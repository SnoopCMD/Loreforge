import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AppEnv, User } from "../env";
import { hashToken, SESSION_COOKIE } from "./tokens";

/** Charge l'utilisateur depuis le cookie de session, 401 sinon. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await hashToken(token), Date.now())
    .first<User>();

  if (!user) return c.json({ error: "unauthorized" }, 401);

  c.set("user", user);
  await next();
});
