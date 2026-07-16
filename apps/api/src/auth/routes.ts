import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, User } from "../env";
import { requireAuth } from "./middleware";
import {
  generateToken,
  hashToken,
  isValidEmail,
  MAGIC_LINK_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./tokens";

export const auth = new Hono<AppEnv>();

// POST /api/auth/magic-link { email }
auth.post("/magic-link", async (c) => {
  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) return c.json({ error: "invalid_email" }, 400);

  const token = generateToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO magic_link_tokens (id, email, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      email,
      await hashToken(token),
      now,
      now + MAGIC_LINK_TTL_MS,
    )
    .run();

  const link = new URL("/api/auth/callback", c.req.url);
  link.searchParams.set("token", token);

  if (c.env.ENVIRONMENT === "development") {
    // Pas d'envoi d'email en dev : le lien est renvoyé directement.
    return c.json({ ok: true, dev_link: link.toString() });
  }

  // v1 : aucun fournisseur d'email branché — le lien part dans les logs Worker.
  console.log(`[magic-link] ${email} -> ${link}`);
  return c.json({ ok: true });
});

// GET /api/auth/callback?token=
auth.get("/callback", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "missing_token" }, 400);

  const now = Date.now();
  const pending = await c.env.DB.prepare(
    `SELECT id, email FROM magic_link_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(await hashToken(token), now)
    .first<{ id: string; email: string }>();
  if (!pending) return c.json({ error: "invalid_or_expired_token" }, 400);

  // Usage unique : la clause `used_at IS NULL` protège d'une consommation concurrente.
  const consumed = await c.env.DB.prepare(
    `UPDATE magic_link_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
  )
    .bind(now, pending.id)
    .run();
  if (consumed.meta.changes !== 1) {
    return c.json({ error: "invalid_or_expired_token" }, 400);
  }

  let user = await c.env.DB.prepare(
    `SELECT id, email, display_name FROM users WHERE email = ?`,
  )
    .bind(pending.email)
    .first<User>();
  if (!user) {
    user = { id: crypto.randomUUID(), email: pending.email, display_name: null };
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, NULL, ?)`,
    )
      .bind(user.id, user.email, now)
      .run();
  }

  const sessionToken = generateToken();
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await hashToken(sessionToken),
      user.id,
      now,
      now + SESSION_TTL_MS,
    )
    .run();

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.redirect("/");
});

// GET /api/auth/me — utilisateur courant
auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

// POST /api/auth/logout
auth.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
      .bind(await hashToken(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
