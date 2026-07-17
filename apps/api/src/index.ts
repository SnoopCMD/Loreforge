import { Hono } from "hono";
import type { AppEnv } from "./env";
import { auth } from "./auth/routes";
import { bibles } from "./bibles/routes";
import { richness } from "./richness/routes";
import { characters } from "./characters/routes";
import { sessions } from "./sessions/routes";

export { GameSession } from "./sessions/do";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => c.json({ ok: true, service: "loreforge" }));
app.route("/api/auth", auth);
app.route("/api/bibles", richness);
app.route("/api/bibles", bibles);
app.route("/api/characters", characters);
app.route("/api/sessions", sessions);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
