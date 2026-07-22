import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicText,
} from "./anthropic-mock";

const BASE = "http://loreforge.test";

beforeAll(() => {
  installAnthropicMock();
});

afterEach(() => {
  assertAnthropicMockConsumed();
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

/** Mocke le prochain POST /v1/messages avec `bodyText` (texte JSON) —
 * le mock sert du SSE si la requête est streamée (cas de l'analyse). */
function mockAnthropic(bodyText: string) {
  mockAnthropicText(bodyText);
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
    // Les lacunes sont normalisées (id stable + drapeau resolved) pour être
    // actionnables côté éditeur (zones floues cliquables).
    expect(done.gaps).toEqual([
      { id: "geography-0", axis: "geography", description: "Aucune carte des Mondes.", resolved: false },
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

  it("zone floue : suggestion (cachée) puis marquage résolu", async () => {
    const cookie = await login("gaps@example.com");
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
    await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    await pollRichness(cookie, bibleId, (s) => s === "analyzed");

    // 1re suggestion : un appel IA mocké renvoie le texte proposé.
    mockAnthropic("Une carte des Mondes : trois archipels reliés par les failles.");
    const suggest = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/gaps/geography-0/suggest`,
      { method: "POST", headers: { cookie } },
    );
    expect(suggest.status).toBe(200);
    const sBody = (await suggest.json()) as { gap: { id: string }; proposed_md: string };
    expect(sBody.gap.id).toBe("geography-0");
    expect(sBody.proposed_md).toContain("trois archipels");

    // 2e suggestion : servie par le cache KV — AUCUN appel IA (mock non armé).
    const again = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/gaps/geography-0/suggest`,
      { method: "POST", headers: { cookie } },
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { proposed_md: string }).proposed_md).toContain(
      "trois archipels",
    );

    // Marquage résolu : persisté dans gaps_json.
    const patch = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/gaps/geography-0`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ resolved: true }),
    });
    expect(patch.status).toBe(200);
    const richness = (await (
      await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, { headers: { cookie } })
    ).json()) as { gaps: Array<{ id: string; resolved: boolean }> };
    expect(richness.gaps.find((g) => g.id === "geography-0")?.resolved).toBe(true);
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

describe("récupération des analyses zombies", () => {
  it("une bible bloquée en analyzing depuis trop longtemps repasse à failed/draft", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);

    // État zombie : isolate évincé, le statut n'a jamais été rétabli.
    await env.DB.prepare(
      `UPDATE bibles SET status = 'analyzing', updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now() - 11 * 60 * 1000, bibleId)
      .run();

    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, {
      headers: { cookie },
    });
    expect(await res.json()).toEqual({ status: "failed" });

    const bible = (await (
      await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, { headers: { cookie } })
    ).json()) as { status: string };
    expect(bible.status).toBe("draft");
  });

  it("une analyse zombie peut être relancée", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);

    await env.DB.prepare(
      `UPDATE bibles SET status = 'analyzing', updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now() - 11 * 60 * 1000, bibleId)
      .run();

    mockAnthropic(
      JSON.stringify({
        cosmology: 5, characters: 5, plots: 5, tone: 5, geography: 5, gaps: [],
      }),
    );
    const relaunch = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(relaunch.status).toBe(202);

    await pollRichness(cookie, bibleId, (s) => s === "analyzed");
  });
});

describe("analyse en mode SSE (Accept: text/event-stream)", () => {
  it("l'analyse aboutit dans la requête et persiste les scores", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);

    mockAnthropic(
      JSON.stringify({
        cosmology: 7, characters: 6, plots: 5, tone: 4, geography: 3, gaps: [],
      }),
    );

    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie, accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: done");

    const after = (await (
      await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, {
        headers: { cookie },
      })
    ).json()) as { status: string; global?: number };
    expect(after.status).toBe("analyzed");
    expect(after.global).toBe(5);
  });

  it("échec du modèle : event error et statut rétabli", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await createBible(cookie);

    mockAnthropic(JSON.stringify({ pas: "conforme" }));

    const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/analyze`, {
      method: "POST",
      headers: { cookie, accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: error");

    const bible = (await (
      await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, { headers: { cookie } })
    ).json()) as { status: string };
    expect(bible.status).toBe("draft");
  });
});
