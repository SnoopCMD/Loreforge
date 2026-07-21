// Intégration : glossaire lore cliquable (GET /lore) et garde-fou de fin de
// tour (relance serveur), sur le DO GameSession.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
  mockAnthropicText,
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

async function post(cookie: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { cookie } });
}

async function readSse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => ({
      event: /^event: (.+)$/m.exec(b)![1],
      data: JSON.parse(/^data: (.+)$/m.exec(b)![1]),
    }));
}

const narrationOf = (events: Array<{ event: string; data: Record<string, unknown> }>) =>
  events.filter((e) => e.event === "narration").map((e) => e.data.text as string).join("");

const CANON = `# Les Mondes Fêlés

La magie vient des failles.

## La Garde Blanche

La Garde Blanche est l'ordre qui scelle les failles, mené par le Commandant Kass.`;

async function analyzedBible(cookie: string): Promise<string> {
  const { id } = (await (
    await post(cookie, "/api/bibles", { markdown: CANON })
  ).json()) as { id: string };
  mockAnthropicText(
    JSON.stringify({
      cosmology: 8,
      characters: 7,
      plots: 6,
      tone: 6,
      geography: 5,
      gaps: [],
    }),
  );
  await post(cookie, `/api/bibles/${id}/analyze`);
  for (let i = 0; i < 50; i++) {
    const body = (await (await get(cookie, `/api/bibles/${id}/richness`)).json()) as {
      status: string;
    };
    if (body.status === "analyzed") return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("analyse trop lente");
}

async function newSession(cookie: string, bibleId: string): Promise<string> {
  const { session_id } = (await (
    await post(cookie, "/api/sessions", { bible_id: bibleId, format: "oneshot" })
  ).json()) as { session_id: string };
  return session_id;
}

describe("glossaire lore (§7)", () => {
  it("un <lore> reste visible et GET /lore résout la fiche depuis le canon", async () => {
    const cookie = await login("lore@example.com");
    const bibleId = await analyzedBible(cookie);
    const sessionId = await newSession(cookie, bibleId);

    // Scène 1 avec un terme d'univers annoté (et une question → pas de relance).
    mockAnthropicStream([
      "Tu croises la ",
      '<lore term="Garde Blanche" kind="faction">Garde Blanche</lore>',
      " au pont. Que fais-tu ?",
    ]);
    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/setup`, { answers: [] }),
    );
    const narration = narrationOf(events);
    // Le texte visible du terme est conservé (les marqueurs sont invisibles).
    expect(narration).toContain("Garde Blanche");
    expect(narration).toContain("Que fais-tu ?");

    // Résolution de la fiche.
    const res = await get(
      cookie,
      `/api/sessions/${sessionId}/lore?term=${encodeURIComponent("Garde Blanche")}&kind=faction`,
    );
    expect(res.status).toBe(200);
    const fiche = (await res.json()) as {
      term: string;
      kind: string;
      definition: string;
      in_canon: boolean;
      bible_id: string;
    };
    expect(fiche.in_canon).toBe(true);
    expect(fiche.kind).toBe("faction");
    expect(fiche.definition).toContain("scelle les failles");
    expect(fiche.bible_id).toBe(bibleId);

    // term manquant → 400.
    expect((await get(cookie, `/api/sessions/${sessionId}/lore`)).status).toBe(400);
  });

  it("un tour qui retombe fermé déclenche une relance serveur invisible", async () => {
    const cookie = await login("relance@example.com");
    const bibleId = await analyzedBible(cookie);
    const sessionId = await newSession(cookie, bibleId);

    // Scène close (ni question ni options) → second appel de relance.
    mockAnthropicStream(["La cité dort. Les lanternes s'éteignent une à une."]);
    mockAnthropicText("Un cri déchire la nuit. Que fais-tu ?");

    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/setup`, { answers: [] }),
    );
    const narration = narrationOf(events);
    expect(narration).toContain("Les lanternes s'éteignent");
    // La relance a été ajoutée au même tour.
    expect(narration).toContain("Que fais-tu ?");
    expect(events.at(-1)?.event).toBe("done");
  });
});
