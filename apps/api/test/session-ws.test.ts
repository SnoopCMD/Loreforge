// M8 lot 8.2 — la table en direct : WebSocket, hibernation, présence.
//
// Deux garanties comptent plus que les autres et sont testées ici :
// l'authentification a lieu à l'UPGRADE et nulle part ailleurs, et un socket
// mort n'interrompt jamais la narration des autres.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
} from "./anthropic-mock";

const BASE = "http://loreforge.test";

beforeAll(() => installAnthropicMock());
afterEach(() => assertAnthropicMockConsumed());

async function login(email: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const { dev_link } = (await res.json()) as { dev_link: string };
  const cb = await SELF.fetch(dev_link, { redirect: "manual" });
  return (cb.headers.get("set-cookie") ?? "").split(";")[0];
}

async function post(
  cookie: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface WsEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Socket ouvert sur une session, avec les events reçus au fil de l'eau. */
interface TestSocket {
  ws: WebSocket;
  events: WsEvent[];
  waitFor(event: string, timeoutMs?: number): Promise<WsEvent>;
  close(): void;
}

async function openSocket(
  cookie: string,
  sessionId: string,
): Promise<TestSocket> {
  const res = await SELF.fetch(`${BASE}/api/sessions/${sessionId}/ws`, {
    headers: { cookie, upgrade: "websocket" },
  });
  expect(res.status, "l'upgrade doit aboutir").toBe(101);
  const ws = res.webSocket!;
  const events: WsEvent[] = [];
  ws.accept();
  ws.addEventListener("message", (e) => {
    events.push(JSON.parse(e.data as string) as WsEvent);
  });

  return {
    ws,
    events,
    async waitFor(event, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((e) => e.event === event);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `event "${event}" jamais reçu (reçus : ${events.map((e) => e.event).join(", ")})`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      ws.close();
    },
  };
}

async function put(
  cookie: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function createCharacter(
  cookie: string,
  bibleId: string,
  name: string,
): Promise<string> {
  const res = await post(cookie, "/api/characters", {
    bible_id: bibleId,
    name,
    sheet_json: { pouvoir: "marche-faille", temperament: "taciturne" },
  });
  return ((await res.json()) as { id: string }).id;
}

/**
 * Table de deux joueurs, scène 1 jouée. Le parcours complet passe par le
 * lobby : une table naît en lobby, chacun s'assoit avec sa fiche, l'hôte
 * lance, et c'est seulement là que le premier appel au modèle a lieu.
 */
async function tableOfTwo(prefix: string): Promise<{
  hote: string;
  joueur: string;
  sessionId: string;
  bibleId: string;
}> {
  const hote = await login(`${prefix}-hote@example.com`);
  const bibleRes = await post(hote, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };
  const kael = await createCharacter(hote, bibleId, `${prefix}-Kael`);

  const createRes = await post(hote, "/api/sessions", {
    bible_id: bibleId,
    character_id: kael,
    format: "campaign",
    mode: "table",
  });
  const { session_id } = (await createRes.json()) as { session_id: string };

  const { code } = (await (
    await post(hote, `/api/sessions/${session_id}/invite`)
  ).json()) as { code: string };
  const joueur = await login(`${prefix}-joueur@example.com`);
  await post(joueur, "/api/sessions/join", { code });
  const mira = await createCharacter(joueur, bibleId, `${prefix}-Mira`);
  await put(joueur, `/api/sessions/${session_id}/members/me`, {
    character_id: mira,
  });

  await post(hote, `/api/sessions/${session_id}/start`);
  mockAnthropicStream(["La brume s'ouvre. Que faites-vous ?"]);
  await (
    await post(hote, `/api/sessions/${session_id}/setup`, { answers: [] })
  ).text();

  return { hote, joueur, sessionId: session_id, bibleId };
}

describe("lot 8.2 — l'upgrade est le seul point d'authentification", () => {
  it("refuse un non-membre, et une requête qui n'est pas un upgrade", async () => {
    const { hote, sessionId } = await tableOfTwo("auth");

    const inconnu = await login("ws-inconnu@example.com");
    const refus = await SELF.fetch(`${BASE}/api/sessions/${sessionId}/ws`, {
      headers: { cookie: inconnu, upgrade: "websocket" },
    });
    expect(refus.status).toBe(404);
    expect(refus.webSocket).toBeFalsy();

    // Sans cookie du tout : 401, avant même de toucher au Durable Object.
    const anonyme = await SELF.fetch(`${BASE}/api/sessions/${sessionId}/ws`, {
      headers: { upgrade: "websocket" },
    });
    expect(anonyme.status).toBe(401);

    // Une requête HTTP ordinaire sur la même route n'ouvre rien.
    const simple = await SELF.fetch(`${BASE}/api/sessions/${sessionId}/ws`, {
      headers: { cookie: hote },
    });
    expect(simple.status).toBe(426);
  });

  it("ne laisse pas un message WebSocket redéfinir qui l'on est", async () => {
    const { joueur, sessionId } = await tableOfTwo("usurpation");
    const socket = await openSocket(joueur, sessionId);
    await socket.waitFor("presence");

    // Un client malveillant s'annonce hôte : le serveur ne lit RIEN d'autre
    // qu'un battement de cœur dans les messages entrants.
    socket.ws.send(JSON.stringify({ type: "identify", role: "host" }));
    socket.ws.send(JSON.stringify({ type: "ping" }));
    const pong = await socket.waitFor("pong");
    expect(pong.event).toBe("pong");

    const presence = socket.events.filter((e) => e.event === "presence").at(-1)!;
    const membres = presence.data.members as Array<{ role: string }>;
    expect(membres.every((m) => m.role !== "host")).toBe(true);
    socket.close();
  });
});

describe("lot 8.2 — diffusion et présence", () => {
  it("sert l'état courant à un socket qui arrive, sans rien rejouer", async () => {
    const { hote, sessionId } = await tableOfTwo("etat");
    const socket = await openSocket(hote, sessionId);

    const state = await socket.waitFor("state");
    expect(state.data.status).toBe("playing");
    expect(state.data.souffle).toBe(3);
    // C'est ce qui fait qu'un réveil après hibernation — ou après un écran
    // verrouillé — rattrape ce qui a été manqué.
    expect((state.data.log as unknown[]).length).toBeGreaterThan(0);
    socket.close();
  });

  it("annonce les arrivées et les départs", async () => {
    const { hote, joueur, sessionId } = await tableOfTwo("presence");
    const premier = await openSocket(hote, sessionId);
    await premier.waitFor("presence");

    const second = await openSocket(joueur, sessionId);
    const arrivee = await premier.waitFor("member_joined");
    expect(arrivee.data.user_id).toBeTruthy();
    expect((await second.waitFor("presence")).data.members).toHaveLength(2);

    second.close();
    const depart = await premier.waitFor("member_left");
    expect(depart.data.user_id).toBe(arrivee.data.user_id);
    premier.close();
  });

  it("diffuse la narration à la table, sans la servir deux fois à son auteur", async () => {
    const { hote, joueur, sessionId } = await tableOfTwo("narration");
    const socketHote = await openSocket(hote, sessionId);
    const socketJoueur = await openSocket(joueur, sessionId);
    await socketJoueur.waitFor("presence");
    socketHote.events.length = 0;
    socketJoueur.events.length = 0;

    // Régime simultané : tant que tous les connectés n'ont pas soumis, le
    // tour attend. C'est la dernière soumission qui déclenche la narration.
    const attente = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je pousse la porte",
    });
    expect(attente.status).toBe(202);
    expect(((await attente.json()) as { status: string }).status).toBe("waiting");

    mockAnthropicStream(["La porte cède. ", "Que faites-vous ?"]);
    const sse = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je couvre ses arrières",
    });
    const texte = await sse.text();
    expect(texte).toContain("La porte cède.");

    // L'hôte, qui ne tient aucun flux SSE, reçoit tout par le socket…
    await socketHote.waitFor("done");
    const recu = socketHote.events
      .filter((e) => e.event === "narration")
      .map((e) => e.data.text as string)
      .join("");
    expect(recu).toBe("La porte cède. Que faites-vous ?");

    // …et l'auteur de la dernière soumission, qui tient le flux SSE, ne le
    // reçoit pas en double sur son propre socket.
    expect(socketJoueur.events.filter((e) => e.event === "narration")).toHaveLength(0);

    socketHote.close();
    socketJoueur.close();
  });

  it("un socket mort n'interrompt pas la narration des autres", async () => {
    const { hote, joueur, sessionId } = await tableOfTwo("mort");
    // L'observateur est l'hôte : c'est lui qui doit continuer à tout recevoir.
    const vivant = await openSocket(hote, sessionId);
    // Le joueur garde un onglet valide en plus de celui qui va mourir : sans
    // lui, il sortirait de la présence et le tour partirait tout seul.
    const secondOnglet = await openSocket(joueur, sessionId);
    const mourant = await openSocket(joueur, sessionId);
    await vivant.waitFor("presence");

    // Un socket fermé côté client reste listé un court instant par
    // getWebSockets() : l'envoi vers lui lèvera, et c'est exactement le cas
    // qui ne doit pas emporter la narration des autres.
    mourant.ws.close(1000, "coupure");

    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'avance",
    });
    mockAnthropicStream(["La suite arrive. Que faites-vous ?"]);
    const sse = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je suis",
    });
    expect(await sse.text()).toContain("La suite arrive.");

    // Le socket resté valide a bien tout reçu, malgré le mort à côté.
    const done = await vivant.waitFor("done");
    expect(done.data.turn).toBe(2);
    vivant.close();
    secondOnglet.close();
  });

  it("le SSE reste intact : une session solo ne voit rien changer", async () => {
    const cookie = await login("solo-ws@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers\n\nDu lore.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    mockAnthropicStream(["Scène 1. Que fais-tu ?"]);
    const setup = await post(cookie, `/api/sessions/${session_id}/setup`, {
      answers: [],
    });
    expect(setup.headers.get("content-type")).toContain("text/event-stream");
    const events = (await setup.text()).split("\n\n").filter(Boolean);
    expect(events.some((e) => e.includes("event: narration"))).toBe(true);
    expect(events.some((e) => e.includes("event: done"))).toBe(true);
  });
});

describe("lot 8.3 — l'état de jeu appartient à chaque personnage", () => {
  /** Table où chaque joueur incarne sa propre fiche, déjà lancée. */
  async function tableWithCharacters(prefix: string): Promise<{
    hote: string;
    joueur: string;
    sessionId: string;
    kael: string;
    mira: string;
  }> {
    const t = await tableOfTwo(prefix);
    const { results } = await env.DB.prepare(
      `SELECT role, character_id FROM session_members WHERE session_id = ?`,
    )
      .bind(t.sessionId)
      .all<{ role: string; character_id: string }>();
    return {
      ...t,
      kael: results.find((r) => r.role === "host")!.character_id,
      mira: results.find((r) => r.role === "player")!.character_id,
    };
  }

  it("expose l'état de chaque personnage, sans casser les champs historiques", async () => {
    const { hote, sessionId, kael } = await tableWithCharacters("etatpj");

    const state = (await (
      await SELF.fetch(`${BASE}/api/sessions/${sessionId}/state`, {
        headers: { cookie: hote },
      })
    ).json()) as Record<string, unknown>;

    // Les champs d'avant la table restent servis tels quels : le front
    // mono-joueur ne voit aucune différence.
    expect(state.souffle).toBe(3);
    expect(state.skills).toEqual([]);
    expect(state.character_id).toBe(kael);

    // Et la vérité complète est là, indexée par personnage.
    const characters = state.characters as Record<string, { souffle: number }>;
    expect(characters[kael].souffle).toBe(3);
  });

  it("dépense le Souffle du joueur qui agit, pas celui de la table", async () => {
    const { hote, joueur, sessionId, kael, mira } =
      await tableWithCharacters("souffle");
    // Les deux soumettent : en régime simultané, c'est la dernière action qui
    // déclenche la narration. Le MJ dit explicitement de qui il parle.
    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je regarde faire",
    });
    mockAnthropicStream([
      "Mira force le passage. ",
      '<souffle delta="-1" character="souffle-Mira"/>',
      " Et toi, Kael ?",
    ]);
    await (
      await post(joueur, `/api/sessions/${sessionId}/turn`, {
        player_input: "je force le passage",
      })
    ).text();

    const state = (await (
      await SELF.fetch(`${BASE}/api/sessions/${sessionId}/state`, {
        headers: { cookie: hote },
      })
    ).json()) as { characters: Record<string, { souffle: number }> };

    expect(state.characters[mira].souffle).toBe(2);
    // Kael n'a rien dépensé : c'est tout l'objet de ce lot.
    expect(state.characters[kael].souffle).toBe(3);
  });

  it("laisse deux jets en attente coexister sur la même table", async () => {
    const { hote, joueur, sessionId, kael, mira } =
      await tableWithCharacters("jets");
    // Une seule narration, deux demandes de jet, une par personnage : c'est
    // précisément ce qu'un état plat au niveau session rendait impossible.
    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je saute",
    });
    mockAnthropicStream([
      'Kael s\'élance. <roll reason="sauter la faille" character="jets-Kael" difficulty="normal" stance="neutral" dice="1" bonuses=""/>',
      ' Mira tend l\'oreille. <roll reason="écouter le couloir" character="jets-Mira" difficulty="easy" stance="neutral" dice="1" bonuses=""/>',
    ]);
    await (
      await post(joueur, `/api/sessions/${sessionId}/turn`, {
        player_input: "j'écoute",
      })
    ).text();

    const state = (await (
      await SELF.fetch(`${BASE}/api/sessions/${sessionId}/state`, {
        headers: { cookie: hote },
      })
    ).json()) as {
      characters: Record<string, { pending_roll: { reason: string } | null }>;
    };

    // Deux jets en attente en même temps : impossible avant ce lot.
    expect(state.characters[kael].pending_roll?.reason).toBe("sauter la faille");
    expect(state.characters[mira].pending_roll?.reason).toBe(
      "écouter le couloir",
    );

    // Et chacun résout le sien, sur SA fiche.
    const rollKael = await post(hote, `/api/sessions/${sessionId}/roll`);
    expect(rollKael.status).toBe(200);
    expect(((await rollKael.json()) as { reason: string }).reason).toBe(
      "sauter la faille",
    );
    const rollMira = await post(joueur, `/api/sessions/${sessionId}/roll`);
    expect(((await rollMira.json()) as { reason: string }).reason).toBe(
      "écouter le couloir",
    );
  });

  it("nomme les personnages au MJ dès qu'ils sont plusieurs", async () => {
    const { hote, joueur, sessionId } = await tableWithCharacters("roster");
    let envoye = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("https://api.anthropic.com") && typeof init?.body === "string") {
        envoye = init.body;
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      await post(hote, `/api/sessions/${sessionId}/turn`, {
        player_input: "j'observe",
      });
      mockAnthropicStream(["La suite. Que faites-vous ?"]);
      await (
        await post(joueur, `/api/sessions/${sessionId}/turn`, {
          player_input: "je guette",
        })
      ).text();
    } finally {
      globalThis.fetch = realFetch;
    }

    // Le roster voyage dans le CONTEXTE DU TOUR, jamais dans le prompt
    // système : celui-ci est en cache ephemeral et doit rester identique à
    // l'octet près, or les joueurs vont et viennent.
    const payload = JSON.parse(envoye) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: unknown }>;
    };
    expect(payload.system[0].text).not.toContain("roster-Mira");
    expect(JSON.stringify(payload.messages)).toContain("roster-Kael —");
    expect(JSON.stringify(payload.messages)).toContain("roster-Mira —");
  });
});
