// M4 — additions backend pour l'UI : liste des sessions d'une bible,
// résumé fusionné dans /state après finish, et serving des assets du front.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
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

async function get(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { cookie } });
}

/** Bible minimale non analysée (0 question de setup). */
async function createBible(cookie: string): Promise<string> {
  const res = await post(cookie, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id } = (await res.json()) as { id: string };
  return id;
}

async function createSession(
  cookie: string,
  bibleId: string,
  format = "oneshot",
): Promise<string> {
  const res = await post(cookie, "/api/sessions", {
    bible_id: bibleId,
    format,
  });
  expect(res.status).toBe(201);
  const { session_id } = (await res.json()) as { session_id: string };
  return session_id;
}

describe("GET /api/sessions?bible_id=", () => {
  it("liste les sessions de la bible, plus récentes d'abord", async () => {
    const cookie = await login("list@example.com");
    const bibleId = await createBible(cookie);
    const first = await createSession(cookie, bibleId, "oneshot");
    const second = await createSession(cookie, bibleId, "mini");

    const res = await get(cookie, `/api/sessions?bible_id=${bibleId}`);
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining([first, second]),
    );
    for (const s of sessions) {
      expect(s.status).toBe("setup");
      expect(s.character_name).toBeNull();
      expect(typeof s.created_at).toBe("number");
    }
  });

  it("404 pour la bible d'un autre", async () => {
    const alice = await login("alice3@example.com");
    const bob = await login("bob3@example.com");
    const bibleId = await createBible(alice);

    expect(
      (await get(bob, `/api/sessions?bible_id=${bibleId}`)).status,
    ).toBe(404);
  });

  it("sans bible_id : toutes les sessions de l'utilisateur, avec le titre de la bible", async () => {
    const cookie = await login("all-sessions@example.com");
    const other = await login("other-sessions@example.com");
    const bible1 = await createBible(cookie);
    const bible2 = await createBible(cookie);
    const foreign = await createBible(other);
    await createSession(cookie, bible1);
    await createSession(cookie, bible2);
    await createSession(other, foreign);

    const res = await get(cookie, "/api/sessions");
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect([bible1, bible2]).toContain(s.bible_id);
      expect(s.bible_title).toBe("Les Mondes Fêlés");
    }
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("efface la session : elle sort de la liste et son état est introuvable", async () => {
    const cookie = await login("del-session@example.com");
    const bibleId = await createBible(cookie);
    const doomed = await createSession(cookie, bibleId);
    const kept = await createSession(cookie, bibleId);

    const res = await SELF.fetch(`${BASE}/api/sessions/${doomed}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const { sessions } = (await (
      await get(cookie, `/api/sessions?bible_id=${bibleId}`)
    ).json()) as { sessions: Array<{ id: string }> };
    expect(sessions.map((s) => s.id)).toEqual([kept]);
    expect((await get(cookie, `/api/sessions/${doomed}/state`)).status).toBe(404);
  });

  it("404 pour la session d'un autre — et elle survit", async () => {
    const alice = await login("alice-del@example.com");
    const bob = await login("bob-del@example.com");
    const bibleId = await createBible(alice);
    const sessionId = await createSession(alice, bibleId);

    const res = await SELF.fetch(`${BASE}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { cookie: bob },
    });
    expect(res.status).toBe(404);
    expect((await get(alice, `/api/sessions/${sessionId}/state`)).status).toBe(200);
  });
});

describe("POST /api/sessions/:id/trame", () => {
  it("enregistre le fil rouge posé à la mise en place et rend les questions", async () => {
    const cookie = await login("trame-setup@example.com");
    const bibleId = await createBible(cookie);
    const sessionId = await createSession(cookie, bibleId);

    const res = await post(cookie, `/api/sessions/${sessionId}/trame`, {
      trame: "  Retrouver la trace de la Garde Blanche.  ",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trame: string;
      setup_questions: string[];
    };
    expect(body.trame).toBe("Retrouver la trace de la Garde Blanche.");
    expect(Array.isArray(body.setup_questions)).toBe(true);

    const { sessions } = (await (
      await get(cookie, `/api/sessions?bible_id=${bibleId}`)
    ).json()) as { sessions: Array<{ trame: string | null }> };
    expect(sessions[0].trame).toBe("Retrouver la trace de la Garde Blanche.");

    const state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.trame).toBe("Retrouver la trace de la Garde Blanche.");
  });

  it("un fil rouge vide efface celui de la session", async () => {
    const cookie = await login("trame-vide@example.com");
    const bibleId = await createBible(cookie);
    const sessionId = await createSession(cookie, bibleId);

    await post(cookie, `/api/sessions/${sessionId}/trame`, { trame: "La route du sel" });
    const res = await post(cookie, `/api/sessions/${sessionId}/trame`, { trame: "   " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { trame: string | null }).trame).toBeNull();

    const state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.trame).toBeNull();
  });

  it("refuse une trame mal typée, et refuse d'en poser une en cours de partie", async () => {
    const cookie = await login("trame-bad@example.com");
    const bibleId = await createBible(cookie);
    const sessionId = await createSession(cookie, bibleId);

    const bad = await post(cookie, `/api/sessions/${sessionId}/trame`, { trame: 42 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_trame");

    mockAnthropicStream(["Scène 1. Que fais-tu ?"]);
    await (await post(cookie, `/api/sessions/${sessionId}/setup`, { answers: [] })).text();

    const late = await post(cookie, `/api/sessions/${sessionId}/trame`, { trame: "Trop tard" });
    expect(late.status).toBe(409);
  });
});

describe("GET /api/sessions/:id/state après finish", () => {
  it("fusionne summary_md depuis D1 pour une session finie", async () => {
    const cookie = await login("finished@example.com");
    const bibleId = await createBible(cookie);
    const sessionId = await createSession(cookie, bibleId);

    mockAnthropicStream(["Scène 1. Que fais-tu ?"]);
    const setupRes = await post(cookie, `/api/sessions/${sessionId}/setup`, {
      answers: [],
    });
    expect(setupRes.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    await setupRes.text(); // draine le SSE

    mockAnthropicText("## Résumé\n\nUne courte session d'essai.");
    const finishRes = await post(cookie, `/api/sessions/${sessionId}/finish`);
    expect(finishRes.status).toBe(200);

    const state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.status).toBe("finished");
    expect(state.summary_md).toContain("## Résumé");
  });
});

describe("assets du front", () => {
  it("sert index.html, app.js et styles.css", async () => {
    const home = await SELF.fetch(`${BASE}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("Loreforge");

    const js = await SELF.fetch(`${BASE}/app.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("runGeneration");

    const css = await SELF.fetch(`${BASE}/styles.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("--arcane");
  });

  it("sert le module core et les fichiers PWA (§8.3)", async () => {
    const core = await SELF.fetch(`${BASE}/core.js`);
    expect(core.status).toBe(200);
    expect(await core.text()).toContain("createSseParser");

    const manifest = await SELF.fetch(`${BASE}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    const parsed = (await manifest.json()) as { display: string; icons: unknown[] };
    expect(parsed.display).toBe("standalone");
    expect(parsed.icons.length).toBeGreaterThan(0);

    const sw = await SELF.fetch(`${BASE}/sw.js`);
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain("addEventListener");

    expect((await SELF.fetch(`${BASE}/icon.svg`)).status).toBe(200);
  });
});
