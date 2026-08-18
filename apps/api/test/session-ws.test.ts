// M8 lot 8.2 — la table en direct : WebSocket, hibernation, présence.
//
// Deux garanties comptent plus que les autres et sont testées ici :
// l'authentification a lieu à l'UPGRADE et nulle part ailleurs, et un socket
// mort n'interrompt jamais la narration des autres.

import { SELF } from "cloudflare:test";
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

/** Table de deux joueurs, scène 1 jouée. */
async function tableOfTwo(prefix: string): Promise<{
  hote: string;
  joueur: string;
  sessionId: string;
}> {
  const hote = await login(`${prefix}-hote@example.com`);
  const bibleRes = await post(hote, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };
  const createRes = await post(hote, "/api/sessions", {
    bible_id: bibleId,
    format: "campaign",
    mode: "table",
  });
  const { session_id } = (await createRes.json()) as { session_id: string };

  mockAnthropicStream(["La brume s'ouvre. Que fais-tu ?"]);
  await (
    await post(hote, `/api/sessions/${session_id}/setup`, { answers: [] })
  ).text();

  const { code } = (await (
    await post(hote, `/api/sessions/${session_id}/invite`)
  ).json()) as { code: string };
  const joueur = await login(`${prefix}-joueur@example.com`);
  await post(joueur, "/api/sessions/join", { code });

  return { hote, joueur, sessionId: session_id };
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

    mockAnthropicStream(["La porte cède. ", "Que faites-vous ?"]);
    const sse = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je pousse la porte",
    });
    const texte = await sse.text();
    expect(texte).toContain("La porte cède.");

    // Le joueur qui n'a pas agi reçoit tout par le socket…
    await socketJoueur.waitFor("done");
    const recu = socketJoueur.events
      .filter((e) => e.event === "narration")
      .map((e) => e.data.text as string)
      .join("");
    expect(recu).toBe("La porte cède. Que faites-vous ?");

    // …et l'auteur du tour, qui tient déjà le flux SSE, ne le reçoit pas en
    // double sur son propre socket.
    expect(socketHote.events.filter((e) => e.event === "narration")).toHaveLength(0);

    socketHote.close();
    socketJoueur.close();
  });

  it("un socket mort n'interrompt pas la narration des autres", async () => {
    const { hote, joueur, sessionId } = await tableOfTwo("mort");
    const vivant = await openSocket(joueur, sessionId);
    const mourant = await openSocket(joueur, sessionId);
    await vivant.waitFor("presence");

    // Un socket fermé côté client reste listé un court instant par
    // getWebSockets() : l'envoi vers lui lèvera, et c'est exactement le cas
    // qui ne doit pas emporter la narration des autres.
    mourant.ws.close(1000, "coupure");

    mockAnthropicStream(["La suite arrive. Que faites-vous ?"]);
    const sse = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'avance",
    });
    expect((await sse.text())).toContain("La suite arrive.");

    const done = await vivant.waitFor("done");
    expect(done.data.turn).toBe(2);
    vivant.close();
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
