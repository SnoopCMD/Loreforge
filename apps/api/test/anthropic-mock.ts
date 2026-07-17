// Mock des appels Anthropic pour les tests.
//
// Depuis la ligne vitest 4 de @cloudflare/vitest-pool-workers, `fetchMock`
// n'existe plus : on stubbe `globalThis.fetch` (le worker principal et ses
// Durable Objects tournent dans le même isolat que les tests, le stub
// s'applique donc aussi au SDK Anthropic côté worker et côté DO).
// Tout autre trafic sortant est interdit, comme l'ancien disableNetConnect.

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

const queue: Array<() => Response> = [];
let installed = false;

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
      return next();
    }
    if (/^https?:\/\//.test(url)) {
      throw new Error(`trafic réseau inattendu dans les tests : ${url}`);
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}

/** À appeler en afterEach : vérifie que tous les mocks ont été consommés. */
export function assertAnthropicMockConsumed(): void {
  if (queue.length > 0) {
    queue.length = 0;
    throw new Error("des réponses Anthropic mockées n'ont pas été consommées");
  }
}

/** Prochaine réponse non-streamée (analyse de richesse, résumé de fin). */
export function mockAnthropicText(text: string): void {
  queue.push(
    () =>
      new Response(
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

/** Prochaine réponse streamée : chaque delta devient un text_delta SSE. */
export function mockAnthropicStream(deltas: string[]): void {
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

  queue.push(
    () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
}
