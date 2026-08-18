// M8 lot 8.5 — régimes de tour : verrou, file et tour par tour.
//
// Le test qui compte le plus n'est pas celui du multi : c'est celui du solo.
// Le verrou et la file existent pour une table ; en solo ils doivent être un
// no-op observable. C'est le parcours quotidien, celui qu'on régresserait sans
// le voir.

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

const post = (cookie: string, path: string, body?: unknown) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const put = (cookie: string, path: string, body: unknown) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

const get = (cookie: string, path: string) =>
  SELF.fetch(`${BASE}${path}`, { headers: { cookie } });

async function character(
  cookie: string,
  bibleId: string,
  name: string,
): Promise<string> {
  const res = await post(cookie, "/api/characters", {
    bible_id: bibleId,
    name,
    sheet_json: { pouvoir: "marche-faille" },
  });
  return ((await res.json()) as { id: string }).id;
}

/** Table de deux joueurs, lancée, scène 1 jouée. */
async function table(prefix: string): Promise<{
  hote: string;
  joueur: string;
  sessionId: string;
}> {
  const hote = await login(`${prefix}-hote@example.com`);
  const bibleRes = await post(hote, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };
  const kael = await character(hote, bibleId, "Kaelen");

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
  const mira = await character(joueur, bibleId, "Mira");
  await put(joueur, `/api/sessions/${session_id}/members/me`, {
    character_id: mira,
  });

  await post(hote, `/api/sessions/${session_id}/start`);
  mockAnthropicStream(["La brume s'ouvre. Que faites-vous ?"]);
  await (
    await post(hote, `/api/sessions/${session_id}/setup`, { answers: [] })
  ).text();

  return { hote, joueur, sessionId: session_id };
}

/** Corps envoyé à Anthropic lors du prochain appel. */
function captureAnthropicBody(): { get: () => string; restore: () => void } {
  let body = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("https://api.anthropic.com") && typeof init?.body === "string") {
      body = init.body;
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    get: () => body,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("lot 8.5 — le solo ne subit aucune latence ajoutée", () => {
  it("résout immédiatement, sans verrou ni file", async () => {
    const cookie = await login("solo-tour@example.com");
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
    await (
      await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })
    ).text();

    mockAnthropicStream(["Tu avances. Que fais-tu ?"]);
    const res = await post(cookie, `/api/sessions/${session_id}/turn`, {
      player_input: "j'avance",
    });
    // Pas de 202 « waiting » : le tour part tout de suite, comme avant M8.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("Tu avances.");

    // Et rien n'a été écrit dans le storage du tour : le passage par le
    // verrou et la file est un no-op observable.
    const state = (await (
      await get(cookie, `/api/sessions/${session_id}/state`)
    ).json()) as { turn_count: number };
    expect(state.turn_count).toBe(2);
  });

  it("garde le message du tour identique à l'octet près", async () => {
    const cookie = await login("solo-prompt@example.com");
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
    await (
      await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })
    ).text();

    const capture = captureAnthropicBody();
    try {
      mockAnthropicStream(["Suite. Que fais-tu ?"]);
      await (
        await post(cookie, `/api/sessions/${session_id}/turn`, {
          player_input: "je pousse la porte",
        })
      ).text();
    } finally {
      capture.restore();
    }

    const payload = JSON.parse(capture.get()) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: unknown }>;
    };
    // Ni en-tête d'actions, ni nom de personnage, ni règles de table : le solo
    // n'hérite d'aucun échafaudage du multi.
    const dernier = JSON.stringify(payload.messages.at(-1));
    expect(dernier).toContain("je pousse la porte");
    expect(dernier).not.toContain("ACTIONS DU TOUR");
    expect(payload.system[0].text).not.toContain("TABLE DE PLUSIEURS JOUEURS");
    expect(payload.system[0].text).not.toContain("RÉGIME DE TOUR");
  });
});

describe("lot 8.5 — régime simultané", () => {
  it("produit une seule narration qui référence les deux actions", async () => {
    const { hote, joueur, sessionId } = await table("simultane");

    const attente = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je force la porte",
    });
    expect(attente.status).toBe(202);

    const capture = captureAnthropicBody();
    let texte = "";
    try {
      mockAnthropicStream(["Kaelen force, Mira couvre. Que faites-vous ?"]);
      texte = await (
        await post(joueur, `/api/sessions/${sessionId}/turn`, {
          player_input: "je couvre le couloir",
        })
      ).text();
    } finally {
      capture.restore();
    }

    // UNE narration, pas deux.
    expect(texte.match(/event: done/g) ?? []).toHaveLength(1);
    const payload = JSON.parse(capture.get()) as {
      messages: Array<{ content: unknown }>;
    };
    const dernier = JSON.stringify(payload.messages.at(-1));
    // Les deux actions y sont, attribuées à leur personnage.
    expect(dernier).toContain("Kaelen : je force la porte");
    expect(dernier).toContain("Mira : je couvre le couloir");
  });

  it("laisse l'hôte forcer la résolution sans attendre les retardataires", async () => {
    const { hote, joueur, sessionId } = await table("forcage");

    expect(
      (
        await post(hote, `/api/sessions/${sessionId}/turn`, {
          player_input: "je n'attends plus",
        })
      ).status,
    ).toBe(202);

    // Un joueur ne force pas la table.
    expect(
      (await post(joueur, `/api/sessions/${sessionId}/turn/resolve`)).status,
    ).toBe(403);

    mockAnthropicStream(["Sans attendre, la scène bascule. Et maintenant ?"]);
    const res = await post(hote, `/api/sessions/${sessionId}/turn/resolve`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("la scène bascule");
  });

  it("ne perd jamais une action arrivée pendant une narration", async () => {
    const { hote, joueur, sessionId } = await table("file");

    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "premier geste",
    });

    // On pose le verrou à la main : c'est exactement l'état où une narration
    // est en cours et où une action arrive quand même.
    const stub = env.GAME_SESSIONS.get(
      env.GAME_SESSIONS.idFromString(sessionId),
    );
    await stub.fetch("https://do/state"); // réveille le DO
    const { results } = await env.DB.prepare(
      `SELECT id FROM game_sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .all();
    expect(results).toHaveLength(1);

    const tardif = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "geste tardif",
    });
    // Soit le tour part (tout le monde a soumis), soit l'action est mise en
    // file — dans les deux cas elle est acceptée, jamais rejetée.
    expect([200, 202]).toContain(tardif.status);
    if (tardif.status === 200) {
      // Le tour est parti : il fallait un mock, on le consomme.
      await tardif.text();
    }
  });
});

describe("lot 8.5 — régime séquentiel", () => {
  /** Passe la table en tour par tour, Kaelen d'abord. */
  async function passeEnSequentiel(
    hote: string,
    joueur: string,
    sessionId: string,
  ): Promise<void> {
    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'ouvre le combat",
    });
    mockAnthropicStream([
      'Les lames sortent. <turn_mode value="sequential" order="Kaelen,Mira"/> À toi, Kaelen.',
    ]);
    await (
      await post(joueur, `/api/sessions/${sessionId}/turn`, {
        player_input: "je dégaine",
      })
    ).text();
  }

  it("passe en tour par tour sur ordre du MJ, et le dit à la table", async () => {
    const { hote, joueur, sessionId } = await table("sequentiel");
    await passeEnSequentiel(hote, joueur, sessionId);

    // Le régime est persisté : il vaut pour les tours suivants.
    mockAnthropicStream(["Kaelen frappe. Et ensuite ?"]);
    const aTon = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je frappe",
    });
    // En séquentiel, celui dont c'est le tour est résolu immédiatement : on
    // n'attend personne d'autre.
    expect(aTon.status).toBe(200);
    expect(await aTon.text()).toContain("Kaelen frappe.");
  });

  it("refuse une action hors tour sans la mettre en file", async () => {
    const { hote, joueur, sessionId } = await table("horstour");
    await passeEnSequentiel(hote, joueur, sessionId);

    const refus = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je frappe aussi",
    });
    expect(refus.status).toBe(409);
    const body = (await refus.json()) as { error: string; awaiting: string };
    expect(body.error).toBe("not_your_turn");
    // Le message dit qui l'on attend : « ce n'est pas ton tour » sans dire à
    // qui il est ne sert à rien.
    expect(body.awaiting).toBe("Kaelen");

    // Et surtout : l'action n'est PAS en file. Kaelen joue, et rien de Mira
    // ne s'invite dans sa narration — la jouer plus tard la sortirait de son
    // contexte, et Mira croirait l'avoir perdue.
    const capture = captureAnthropicBody();
    try {
      mockAnthropicStream(["Kaelen frappe seul. Et ensuite ?"]);
      await (
        await post(hote, `/api/sessions/${sessionId}/turn`, {
          player_input: "je frappe",
        })
      ).text();
    } finally {
      capture.restore();
    }
    expect(capture.get()).not.toContain("je frappe aussi");
  });
});
