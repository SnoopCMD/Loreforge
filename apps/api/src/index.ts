import { Hono } from "hono";
import type { AppEnv } from "./env";
import { auth } from "./auth/routes";
import { bibles } from "./bibles/routes";
import { bibleSections } from "./bibles/sections-routes";
import { richness } from "./richness/routes";
import { proposals } from "./bibles/proposals";
import { moodboards } from "./bibles/moodboards";
import { sheetRoutes } from "./characters/sheet-routes";
import { characters } from "./characters/routes";
import { sessions } from "./sessions/routes";
import { tts } from "./tts/routes";

export { GameSession } from "./sessions/do";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => c.json({ ok: true, service: "loreforge" }));
app.route("/api/auth", auth);
app.route("/api/bibles", richness);
app.route("/api/bibles", proposals);
app.route("/api/bibles", sheetRoutes);
app.route("/api/bibles", bibleSections);
app.route("/api/bibles", moodboards);
app.route("/api/bibles", bibles);
app.route("/api/characters", characters);
app.route("/api/sessions", sessions);
app.route("/api/tts", tts);

// Hors /api : front statique via le binding ASSETS (en prod le runtime sert
// les assets avant le worker ; ce fallback couvre les tests et run_worker_first).
app.notFound((c) => {
  if (!new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: "not_found" }, 404);
});
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
