// Routes /api/tts (narration vocale, palier 1) : auth, disponibilité et
// validation. La clé Cartesia n'étant pas configurée en test, la branche
// proxy ne part jamais sur le réseau (interdit dans les tests).

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://loreforge.test";

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

describe("M7 — narration vocale (/api/tts)", () => {
  it("exige l'authentification", async () => {
    expect((await SELF.fetch(`${BASE}/api/tts`)).status).toBe(401);
    const post = await SELF.fetch(`${BASE}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Bonjour" }),
    });
    expect(post.status).toBe(401);
  });

  it("signale la voix indisponible tant que la clé n'est pas configurée", async () => {
    const cookie = await login("voice@example.com");
    const res = await SELF.fetch(`${BASE}/api/tts`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      voice_configured: false,
    });
  });

  it("répond 503 sur synthèse sans clé configurée", async () => {
    const cookie = await login("voice2@example.com");
    const res = await SELF.fetch(`${BASE}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "La brume s'ouvre sur Karnos." }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "tts_not_configured",
    );
  });
});
