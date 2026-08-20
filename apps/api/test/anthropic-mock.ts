// Mock des appels Anthropic pour les tests.
//
// Depuis la ligne vitest 4 de @cloudflare/vitest-pool-workers, `fetchMock`
// n'existe plus : on stubbe `globalThis.fetch` (le worker principal et ses
// Durable Objects tournent dans le même isolat que les tests, le stub
// s'applique donc aussi au SDK Anthropic côté worker et côté DO).
// Tout autre trafic sortant est interdit, comme l'ancien disableNetConnect.

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

const queue: Array<(isStream: boolean) => Response> = [];
let installed = false;

/** Corps de la dernière requête Anthropic, déjà parsé. */
export interface AnthropicRequest {
  system?: unknown;
  messages?: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}

let lastRequest: AnthropicRequest | null = null;

export function installAnthropicMock(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith(ANTHROPIC_ORIGIN)) {
      const next = queue.shift();
      if (!next) {
        throw new Error(`appel Anthropic non mocké : ${url}`);
      }
      // Le SDK envoie "stream": true pour messages.stream — le mock sert
      // alors du SSE, sinon du JSON, quel que soit le mock* utilisé.
      let isStream = false;
      try {
        if (typeof init?.body === "string") {
          // Capturé ICI, une fois parsé : vérifier la sortie du MJ ne dit rien
          // de ce qu'il a REÇU — et c'est exactement là que le multi cassait,
          // sans qu'aucun test n'échoue.
          lastRequest = JSON.parse(init.body) as AnthropicRequest;
          isStream = (lastRequest as { stream?: boolean }).stream === true;
        }
      } catch {
        /* body non-JSON */
      }
      return next(isStream);
    }
    if (/^https?:\/\//.test(url)) {
      throw new Error(`trafic réseau inattendu dans les tests : ${url}`);
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}

/** Dernière requête envoyée au modèle (null si aucune). */
export function lastAnthropicRequest(): AnthropicRequest | null {
  return lastRequest;
}

/**
 * Tout le texte parti au modèle sur la dernière requête : prompt système ET
 * messages, aplatis. De quoi affirmer ce que le MJ a sous les yeux.
 */
export function lastAnthropicPrompt(): string {
  const req = lastRequest;
  if (!req) return "";
  const flat = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) =>
          block !== null && typeof block === "object" && "text" in block
            ? String((block as { text: unknown }).text)
            : "",
        )
        .join("\n");
    }
    return "";
  };
  return [
    flat(req.system),
    ...(req.messages ?? []).map((m) => flat(m.content)),
  ].join("\n");
}

/** À appeler en afterEach : vérifie que tous les mocks ont été consommés. */
export function assertAnthropicMockConsumed(): void {
  if (queue.length > 0) {
    queue.length = 0;
    throw new Error("des réponses Anthropic mockées n'ont pas été consommées");
  }
}

/** Prochain appel : `text` en une réponse — JSON ou SSE selon la requête. */
export function mockAnthropicText(text: string): void {
  queue.push((isStream) =>
    isStream
      ? sseResponse([text])
      : new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 500, output_tokens: 120 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
  );
}

/**
 * Prochain appel : une erreur du fournisseur (clé invalide, quota, panne).
 * Le SDK ne retente ni sur 400 ni sur 401 — un seul mock suffit pour ceux-là.
 */
export function mockAnthropicError(status: number, message: string): void {
  queue.push(
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message },
        }),
        { status, headers: { "content-type": "application/json" } },
      ),
  );
}

/** Prochaine réponse streamée : chaque delta devient un text_delta SSE. */
export function mockAnthropicStream(deltas: string[]): void {
  queue.push(() => sseResponse(deltas));
}

function sseResponse(deltas: string[]): Response {
  const ev = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const body =
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 1 },
      },
    }) +
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    deltas
      .map((text) =>
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }),
      )
      .join("") +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 },
    }) +
    ev("message_stop", { type: "message_stop" });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
