import { Hono } from "hono";
import type { AppEnv } from "./env";
import { auth } from "./auth/routes";
import { bibles } from "./bibles/routes";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => c.json({ ok: true, service: "loreforge" }));
app.route("/api/auth", auth);
app.route("/api/bibles", bibles);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
