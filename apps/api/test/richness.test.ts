import { fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const BASE = "http://loreforge.test";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

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

async function createBible(cookie: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/bibles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      markdown: "# Les Mondes Fêlés\n\nCosmologie forte, géographie floue.",
    }),
  });
  const { id } = (await res.json()) as { id: string };
  return id;
}

/** Intercepte le prochain POST /v1/messages et renvoie `body` (texte JSON). */
function mockAnthropic(bodyText: string) {
  fetchMock
    .get("https://api.anthropic.com")
    .intercept({ method: "POST", path: "/v1/messages" })
    .reply(
      200,
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: bodyText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 120 },
      }),
      { headers: { "content-type": "application/json" } },
    );
}

async function pollRichness(
  cookie: string,
  bibleId: string,
  until: (status: string) => boolean,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, {
      headers: { cookie },
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (until(body.status as string)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("richness polling timed out");
}

describe("POST /api/bibles/:id/analyze + GET richness", () => {
  it("flux complet : analyze -> analyzing -> analyzed avec scores et gaps", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);

    mockAnthropic(
      JSON.stringify({
        cosmology: 9,
        characters: 6,
        plots: 8,
        tone: 5,
        geography: 4,
        gaps: [{ axis: "geography", description: "Aucune carte des Mondes." }],
      }),
    );

    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, status: "analyzing" });

    const done = await pollRichness(cookie, bibleId, (s) => s === "analyzed");
    expect(done.scores).toEqual({
      cosmology: 9,
      characters: 6,
      plots: 8,
      tone: 5,
      geography: 4,
    });
    expect(done.global).toBe(6); // 32/5 arrondi
    expect(done.gaps).toEqual([
      { axis: "geography", description: "Aucune carte des Mondes." },
    ]);

    // Le statut de la bible est passé à 'analyzed'.
    const bible = (await (
      await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, { headers: { cookie } })
    ).json()) as { status: string };
    expect(bible.status).toBe("analyzed");
  });

  it("revient à draft si la sortie du modèle est inexploitable", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);

    mockAnthropic(JSON.stringify({ pas: "conforme" }));

    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(202);

    // L'analyse échoue : le poll retombe sur 'none' (pas de score).
    await pollRichness(cookie, bibleId, (s) => s === "none");
    const bible = (await (
      await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, { headers: { cookie } })
    ).json()) as { status: string };
    expect(bible.status).toBe("draft");
  });

  it("richness sans analyse -> status none", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);
    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "none" });
  });

  it("404 pour la bible d'un autre utilisateur", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    const bibleId = await createBible(alice);

    const analyze = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie: bob },
    });
    expect(analyze.status).toBe(404);

    const get = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, {
      headers: { cookie: bob },
    });
    expect(get.status).toBe(404);
  });

  it("exige une session", async () => {
    const res = await SELF.fetch(`${BASE}/api/bibles/xyz/analyze`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
