// Accès libre : inscription et connexion par email + mot de passe.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/tokens";

const BASE = "http://loreforge.test";

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function sessionCookie(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

describe("hashPassword / verifyPassword", () => {
  it("vérifie le bon mot de passe et rejette le mauvais", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^pbkdf2\$\d+\$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("incorrect", stored)).toBe(false);
  });

  it("deux hachages du même mot de passe diffèrent (sel aléatoire)", async () => {
    expect(await hashPassword("abcdefgh")).not.toBe(await hashPassword("abcdefgh"));
  });
});

describe("POST /api/auth/register", () => {
  it("crée le compte, ouvre la session, normalise l'email", async () => {
    const res = await post("/api/auth/register", {
      email: "Nouveau@Example.com",
      password: "motdepasse",
    });
    expect(res.status).toBe(201);
    const cookie = sessionCookie(res);
    expect(cookie).toContain("lf_session=");

    const me = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const { user } = (await me.json()) as { user: { email: string } };
    expect(user.email).toBe("nouveau@example.com");
  });

  it("409 si l'email a déjà un mot de passe", async () => {
    await post("/api/auth/register", { email: "pris@example.com", password: "motdepasse" });
    const res = await post("/api/auth/register", {
      email: "pris@example.com",
      password: "autre-mdp",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_taken" });
  });

  it("rattache un mot de passe à un compte lien-magique existant", async () => {
    // Compte créé via le flux magic-link (sans mot de passe).
    const ml = await post("/api/auth/magic-link", { email: "ancien@example.com" });
    const { dev_link } = (await ml.json()) as { dev_link: string };
    const cb = await SELF.fetch(dev_link, { redirect: "manual" });
    const oldCookie = sessionCookie(cb);
    const before = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { cookie: oldCookie },
    });
    const oldId = ((await before.json()) as { user: { id: string } }).user.id;

    const res = await post("/api/auth/register", {
      email: "ancien@example.com",
      password: "motdepasse",
    });
    expect(res.status).toBe(200);

    // Même utilisateur : les bibles restent rattachées.
    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { cookie: sessionCookie(res) },
    });
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(oldId);
  });

  it("rejette un mot de passe trop court", async () => {
    const res = await post("/api/auth/register", {
      email: "court@example.com",
      password: "1234567",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_password" });
  });
});

describe("POST /api/auth/login", () => {
  it("connecte avec les bons identifiants", async () => {
    await post("/api/auth/register", { email: "joueur@example.com", password: "motdepasse" });
    const res = await post("/api/auth/login", {
      email: "joueur@example.com",
      password: "motdepasse",
    });
    expect(res.status).toBe(200);
    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { cookie: sessionCookie(res) },
    });
    expect(me.status).toBe(200);
  });

  it("401 indifférencié : mauvais mot de passe, email inconnu, compte sans mot de passe", async () => {
    await post("/api/auth/register", { email: "joueur2@example.com", password: "motdepasse" });
    const ml = await post("/api/auth/magic-link", { email: "sansmdp@example.com" });
    const { dev_link } = (await ml.json()) as { dev_link: string };
    await SELF.fetch(dev_link, { redirect: "manual" });

    for (const creds of [
      { email: "joueur2@example.com", password: "mauvais-mdp" },
      { email: "inconnu@example.com", password: "motdepasse" },
      { email: "sansmdp@example.com", password: "motdepasse" },
    ]) {
      const res = await post("/api/auth/login", creds);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_credentials" });
    }
  });
});
