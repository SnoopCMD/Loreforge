import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://loreforge.test";

/** Connecte un utilisateur via le flux magic-link et renvoie son cookie. */
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

async function createBible(
  cookie: string,
  markdown: string,
  title?: string,
): Promise<Response> {
  return SELF.fetch(`${BASE}/api/bibles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ markdown, title }),
  });
}

interface BibleJson {
  id: string;
  title: string;
  status: string;
  canon_md: string;
  tone_profile: string | null;
}

describe("POST /api/bibles", () => {
  it("importe du Markdown JSON : normalisation, R2, ligne D1", async () => {
    const cookie = await login("author@example.com");
    const res = await createBible(
      cookie,
      "Les Mondes Fêlés\n================\r\n\r\nCosmologie forte.",
    );
    expect(res.status).toBe(201);
    const bible = (await res.json()) as BibleJson;
    expect(bible.title).toBe("Les Mondes Fêlés");
    expect(bible.status).toBe("draft");
    expect(bible.canon_md).toBe("# Les Mondes Fêlés\n\nCosmologie forte.\n");

    // Le brut est conservé tel quel dans R2.
    const stored = await env.BUCKET.get(`bibles/${bible.id}/source.md`);
    expect(await stored?.text()).toBe(
      "Les Mondes Fêlés\n================\r\n\r\nCosmologie forte.",
    );
  });

  it("importe un fichier multipart, titre déduit du nom de fichier", async () => {
    const cookie = await login("author@example.com");
    const form = new FormData();
    form.append(
      "file",
      new File(["Du lore sans titre."], "monde-oublie.md", {
        type: "text/markdown",
      }),
    );
    const res = await SELF.fetch(`${BASE}/api/bibles`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    const bible = (await res.json()) as BibleJson;
    expect(bible.title).toBe("monde-oublie");
    expect(bible.canon_md).toBe("# monde-oublie\n\nDu lore sans titre.\n");
  });

  it("rejette un import vide", async () => {
    const cookie = await login("author@example.com");
    const res = await createBible(cookie, "   \n  ");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_markdown" });
  });

  it("rejette un multipart sans fichier", async () => {
    const cookie = await login("author@example.com");
    const form = new FormData();
    form.append("title", "Sans fichier");
    const res = await SELF.fetch(`${BASE}/api/bibles`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_file" });
  });

  it("exige une session", async () => {
    const res = await SELF.fetch(`${BASE}/api/bibles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# X" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/bibles", () => {
  it("liste les bibles du seul utilisateur courant, sans canon_md", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    await createBible(alice, "# Bible d'Alice");
    await createBible(bob, "# Bible de Bob");

    const res = await SELF.fetch(`${BASE}/api/bibles`, {
      headers: { cookie: alice },
    });
    expect(res.status).toBe(200);
    const { bibles } = (await res.json()) as {
      bibles: Array<Record<string, unknown>>;
    };
    expect(bibles).toHaveLength(1);
    expect(bibles[0].title).toBe("Bible d'Alice");
    expect(bibles[0]).not.toHaveProperty("canon_md");
  });
});

describe("GET /api/bibles/:id", () => {
  it("renvoie le détail avec canon_md", async () => {
    const cookie = await login("author@example.com");
    const created = (await (
      await createBible(cookie, "# Ma Bible\n\nTexte.")
    ).json()) as BibleJson;

    const res = await SELF.fetch(`${BASE}/api/bibles/${created.id}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const bible = (await res.json()) as BibleJson;
    expect(bible.canon_md).toBe("# Ma Bible\n\nTexte.\n");
    expect(bible.tone_profile).toBeNull();
  });

  it("404 pour la bible d'un autre utilisateur", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    const created = (await (await createBible(alice, "# Secret")).json()) as BibleJson;

    const res = await SELF.fetch(`${BASE}/api/bibles/${created.id}`, {
      headers: { cookie: bob },
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/bibles/:id", () => {
  it("met à jour canon_md et tone_profile", async () => {
    const cookie = await login("author@example.com");
    const created = (await (
      await createBible(cookie, "# Ma Bible")
    ).json()) as BibleJson;

    const res = await SELF.fetch(`${BASE}/api/bibles/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        canon_md: "# Ma Bible\n\nVersion éditée.\n",
        tone_profile: { registre: "sombre", violence_max: 2 },
      }),
    });
    expect(res.status).toBe(200);
    const bible = (await res.json()) as BibleJson;
    expect(bible.canon_md).toBe("# Ma Bible\n\nVersion éditée.\n");
    expect(JSON.parse(bible.tone_profile ?? "")).toEqual({
      registre: "sombre",
      violence_max: 2,
    });
  });

  it("rejette un tone_profile non-objet", async () => {
    const cookie = await login("author@example.com");
    const created = (await (
      await createBible(cookie, "# Ma Bible")
    ).json()) as BibleJson;

    const res = await SELF.fetch(`${BASE}/api/bibles/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ tone_profile: "pas du json" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_tone_profile" });
  });

  it("rejette un patch vide", async () => {
    const cookie = await login("author@example.com");
    const created = (await (
      await createBible(cookie, "# Ma Bible")
    ).json()) as BibleJson;

    const res = await SELF.fetch(`${BASE}/api/bibles/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_patch" });
  });

  it("404 pour la bible d'un autre utilisateur", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    const created = (await (await createBible(alice, "# Secret")).json()) as BibleJson;

    const res = await SELF.fetch(`${BASE}/api/bibles/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: bob },
      body: JSON.stringify({ canon_md: "# Piraté" }),
    });
    expect(res.status).toBe(404);
  });
});
