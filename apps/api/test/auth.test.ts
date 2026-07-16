import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://loreforge.test";

async function requestMagicLink(email: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

describe("GET /api/health", () => {
  it("répond ok", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "loreforge" });
  });
});

describe("auth magic-link", () => {
  it("flux complet : magic-link -> callback -> me -> logout", async () => {
    const res = await requestMagicLink("Author@Example.com");
    expect(res.status).toBe(200);
    const { dev_link } = (await res.json()) as { dev_link: string };
    expect(dev_link).toContain("/api/auth/callback?token=");

    const cb = await SELF.fetch(dev_link, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
    const setCookie = cb.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("lf_session=");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0];

    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { cookie },
    });
    expect(me.status).toBe(200);
    const { user } = (await me.json()) as {
      user: { id: string; email: string };
    };
    // L'email est normalisé en minuscules
    expect(user.email).toBe("author@example.com");
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);

    const logout = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(200);

    const meAfter = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { cookie },
    });
    expect(meAfter.status).toBe(401);
  });

  it("un lien magique est à usage unique", async () => {
    const res = await requestMagicLink("once@example.com");
    const { dev_link } = (await res.json()) as { dev_link: string };

    const first = await SELF.fetch(dev_link, { redirect: "manual" });
    expect(first.status).toBe(302);

    const second = await SELF.fetch(dev_link, { redirect: "manual" });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "invalid_or_expired_token" });
  });

  it("réutilise le même utilisateur pour deux connexions du même email", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await requestMagicLink("same@example.com");
      const { dev_link } = (await res.json()) as { dev_link: string };
      const cb = await SELF.fetch(dev_link, { redirect: "manual" });
      const cookie = (cb.headers.get("set-cookie") ?? "").split(";")[0];
      const me = await SELF.fetch(`${BASE}/api/auth/me`, {
        headers: { cookie },
      });
      const { user } = (await me.json()) as { user: { id: string } };
      ids.push(user.id);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it("rejette un email invalide", async () => {
    const res = await requestMagicLink("pas-un-email");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("rejette un body non-JSON", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/magic-link`, {
      method: "POST",
      body: "plain text",
    });
    expect(res.status).toBe(400);
  });

  it("rejette un token inconnu au callback", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/auth/callback?token=nimporte-quoi`,
    );
    expect(res.status).toBe(400);
  });

  it("callback sans token -> 400", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/callback`);
    expect(res.status).toBe(400);
  });

  it("me sans cookie -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`);
    expect(res.status).toBe(401);
  });
});
