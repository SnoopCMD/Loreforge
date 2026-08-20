// §8.3 — couche transport extraite d'app.js (source : public/transport.js).
// Ces tests fixent le contrat dont dépend la reprise après coupure côté UI :
// une erreur serveur (flux jamais ouvert) et une coupure en plein flux ne se
// traitent pas pareil, et app.js ne distingue les deux que par `interrupted`.

import { describe, expect, it, vi } from "vitest";
import {
  RECONNECT_BACKOFF_MS,
  SSE_IDLE_TIMEOUT_MS,
  STREAM_EVENTS,
  TransportError,
  openSseStream,
  openTableSocket,
  // @ts-expect-error — module JS servi tel quel au front, sans types.
} from "../public/transport.js";

/**
 * Réponse SSE dont les chunks sont livrés au rythme donné. Le signal est
 * honoré comme le ferait un vrai fetch : sans ça, le timeout d'inactivité
 * abandonnerait dans le vide et le test ne prouverait rien.
 */
function sseResponse(
  chunks: string[],
  { delayMs = 0, signal }: { delayMs?: number; signal?: AbortSignal } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new Error("aborted"));
        } catch {
          /* déjà fermé */
        }
      });
      for (const chunk of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (signal?.aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          return;
        }
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("openSseStream", () => {
  it("route chaque event typé vers son handler", async () => {
    const seen: Array<[string, unknown]> = [];
    const handlers = Object.fromEntries(
      STREAM_EVENTS.map((name: string) => [
        name,
        (d: unknown) => seen.push([name, d]),
      ]),
    );

    await openSseStream("/sessions/x/turn", { player_input: "j'avance" }, handlers, {
      fetchImpl: async () =>
        sseResponse([
          frame("narration", { text: "La porte " }),
          frame("narration", { text: "s'ouvre." }),
          frame("state_patch", { souffle: 2 }),
          frame("scene_break", {}),
          frame("done", { turn: 4, souffle: 2 }),
        ]),
    });

    expect(seen).toEqual([
      ["narration", { text: "La porte " }],
      ["narration", { text: "s'ouvre." }],
      ["state_patch", { souffle: 2 }],
      ["scene_break", {}],
      ["done", { turn: 4, souffle: 2 }],
    ]);
  });

  it("poste le corps en JSON sur baseUrl + path", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([frame("done", { turn: 1 })]));
    await openSseStream("/sessions/x/turn", { player_input: "ok" }, {}, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sessions/x/turn");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ player_input: "ok" }));
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
  });

  it("ignore un event inconnu sans casser le flux", async () => {
    let turn = 0;
    await openSseStream("/x", {}, { done: (d: { turn: number }) => (turn = d.turn) }, {
      fetchImpl: async () =>
        sseResponse([frame("turn_mode", { value: "sequential" }), frame("done", { turn: 7 })]),
    });
    expect(turn).toBe(7);
  });

  it("remonte une erreur serveur avec son status et son payload, sans interrupted", async () => {
    const err = await openSseStream("/x", {}, {}, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "roll_required", reason: "sauter" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    }).catch((e: TransportError) => e);

    expect(err).toBeInstanceOf(TransportError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("roll_required");
    expect(err.payload).toEqual({ error: "roll_required", reason: "sauter" });
    // Le flux n'a jamais commencé : ce n'est pas une coupure, l'UI ne doit pas
    // proposer « Régénérer » mais afficher la demande de jet.
    expect(err.interrupted).toBeFalsy();
  });

  it("marque interrupted quand le flux se coupe en plein milieu", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(frame("narration", { text: "Un cri" })));
        await new Promise((r) => setTimeout(r, 5));
        controller.error(new Error("network"));
      },
    });
    let received = "";
    const err = await openSseStream("/x", {}, {
      narration: (d: { text: string }) => (received += d.text),
    }, {
      fetchImpl: async () =>
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
    }).catch((e: Error & { interrupted?: boolean }) => e);

    // La narration déjà reçue reste acquise : l'UI garde le texte tronqué
    // sous le bandeau d'interruption plutôt que de le faire disparaître.
    expect(received).toBe("Un cri");
    expect(err.interrupted).toBe(true);
  });

  it("coupe un flux resté silencieux au-delà du timeout d'inactivité", async () => {
    const err = await openSseStream("/x", {}, {}, {
      idleTimeoutMs: 20,
      fetchImpl: async (_url: string, init: RequestInit) =>
        sseResponse([frame("narration", { text: "…" }), frame("done", { turn: 1 })], {
          delayMs: 200,
          signal: init.signal as AbortSignal,
        }),
    }).catch((e: Error & { interrupted?: boolean }) => e);

    expect(err.message).toBe("stream_timeout");
    expect(err.interrupted).toBe(true);
  });

  it("tient sur un flux qui ne dit que des signes de vie", async () => {
    // Le cas réel : le MJ réfléchit plus longtemps que le timeout avant son
    // premier mot. Le serveur envoie des commentaires SSE ; le parser les
    // ignore (ni `event:` ni `data:`) mais le timeout, lui, repart à zéro.
    const seen: string[] = [];
    await openSseStream(
      "/x",
      {},
      { narration: (d: { text: string }) => seen.push(d.text) },
      {
        idleTimeoutMs: 60,
        fetchImpl: async (_url: string, init: RequestInit) =>
          sseResponse(
            [
              ": attente du narrateur\n\n",
              ": attente du narrateur\n\n",
              ": attente du narrateur\n\n",
              frame("narration", { text: "La brume s'ouvre." }),
              frame("done", { turn: 1 }),
            ],
            { delayMs: 30, signal: init.signal as AbortSignal },
          ),
      },
    );

    // 5 chunks à 30 ms = 150 ms de flux, largement au-delà des 60 ms tolérées
    // entre deux chunks : sans les signes de vie, ce test lèverait stream_timeout.
    expect(seen).toEqual(["La brume s'ouvre."]);
  });

  it("garde le défaut d'inactivité historique de 20 s", () => {
    expect(SSE_IDLE_TIMEOUT_MS).toBe(20000);
  });
});

// ── Client WebSocket de table (M8 lot 8.6) ────────────────────────────────

/** Fausse WebSocket : on pilote open/message/close depuis le test. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket fermée");
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }
  emit(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  deliver(event: string, data: unknown): void {
    this.emit("message", { data: JSON.stringify({ event, data }) });
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("openTableSocket", () => {
  it("route les events de table et se ferme sur demande", async () => {
    FakeSocket.instances = [];
    const vus: Array<[string, unknown]> = [];
    const socket = openTableSocket(
      "sess-1",
      {
        narration: (d: unknown) => vus.push(["narration", d]),
        presence: (d: unknown) => vus.push(["presence", d]),
      },
      { factory: (url: string) => new FakeSocket(url) as unknown as WebSocket },
    );

    const fake = FakeSocket.instances[0];
    expect(fake.url).toContain("/api/sessions/sess-1/ws");
    fake.open();
    expect(socket.isOpen()).toBe(true);

    fake.deliver("presence", { members: [{ user_id: "u1" }] });
    fake.deliver("narration", { text: "La porte cède." });
    fake.deliver("inconnu", {}); // event hors contrat : ignoré, jamais fatal
    expect(vus).toEqual([
      ["presence", { members: [{ user_id: "u1" }] }],
      ["narration", { text: "La porte cède." }],
    ]);

    socket.close();
    expect(socket.isOpen()).toBe(false);
  });

  it("se reconnaît coupé et revient, en prévenant qu'il faut resynchroniser", async () => {
    FakeSocket.instances = [];
    let reprises = 0;
    const etats: boolean[] = [];
    const socket = openTableSocket(
      "sess-2",
      {},
      {
        onReconnect: () => reprises++,
        onStatus: (open: boolean) => etats.push(open),
        factory: (url: string) => new FakeSocket(url) as unknown as WebSocket,
      },
    );

    FakeSocket.instances[0].open();
    // Première connexion : ce n'est pas une reprise, l'appelant vient de
    // charger son état.
    expect(reprises).toBe(0);

    // Écran verrouillé sur mobile : la socket se ferme sans prévenir.
    FakeSocket.instances[0].close();
    expect(etats).toEqual([true, false]);

    await tick(600); // premier palier de backoff
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].open();

    // Cette fois c'est un retour : des events ont pu être manqués, l'appelant
    // doit recharger /state.
    expect(reprises).toBe(1);
    socket.close();
  });

  it("n'ouvre plus rien une fois fermé par l'appelant", async () => {
    FakeSocket.instances = [];
    const socket = openTableSocket("sess-3", {}, {
      factory: (url: string) => new FakeSocket(url) as unknown as WebSocket,
    });
    FakeSocket.instances[0].open();
    socket.close();
    FakeSocket.instances[0].emit("close", {});

    await tick(700);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("espace ses tentatives au lieu de marteler le serveur", () => {
    // Le backoff est croissant et plafonné : une coupure longue ne doit pas
    // se traduire par des milliers de tentatives.
    expect(RECONNECT_BACKOFF_MS[0]).toBeLessThan(RECONNECT_BACKOFF_MS.at(-1)!);
    for (let i = 1; i < RECONNECT_BACKOFF_MS.length; i++) {
      expect(RECONNECT_BACKOFF_MS[i]).toBeGreaterThan(RECONNECT_BACKOFF_MS[i - 1]);
    }
    expect(RECONNECT_BACKOFF_MS.at(-1)).toBeLessThanOrEqual(30000);
  });
});
