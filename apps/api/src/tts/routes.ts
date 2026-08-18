// Routes /api/tts (narration vocale, palier 1) : le Worker fait proxy vers
// Cartesia pour que la clé API reste secrète (jamais exposée au navigateur).
// Le front envoie le texte d'un tour du MJ, reçoit un MP3 et le joue.
//
// L'appel lui-même vit dans cartesia.ts : le Durable Object s'en sert aussi
// pour fabriquer le récit audio d'un acte (M7 lot 7.3).

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { listVoices, MAX_TTS_CHARS, synthesizeSpeech } from "./cartesia";

export const tts = new Hono<AppEnv>();

tts.use("*", requireAuth);

/** Le front interroge cet endpoint pour décider d'afficher le bouton 🔊. */
tts.get("/", (c) =>
  c.json({
    available: Boolean(c.env.CARTESIA_API_KEY),
    voice_configured: Boolean(c.env.CARTESIA_VOICE_ID),
  }),
);

/** Listing des voix (filtrable par langue) — sert à choisir un CARTESIA_VOICE_ID. */
tts.get("/voices", async (c) => {
  if (!c.env.CARTESIA_API_KEY) {
    return c.json({ error: "tts_not_configured" }, 503);
  }
  const res = await listVoices(c.env, c.req.query("language"));
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[tts] voices ${res.status}: ${detail}`);
    return c.json({ error: "voices_failed" }, 502);
  }
  return c.body(await res.text(), 200, { "content-type": "application/json" });
});

/** POST { text } → MP3 streamé. La clé Cartesia ne quitte jamais le Worker. */
tts.post("/", async (c) => {
  if (!c.env.CARTESIA_API_KEY) {
    return c.json({ error: "tts_not_configured" }, 503);
  }
  if (!c.env.CARTESIA_VOICE_ID) {
    return c.json({ error: "tts_voice_not_configured" }, 503);
  }

  let body: { text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") return c.json({ error: "empty_text" }, 400);
  if (text.length > MAX_TTS_CHARS) {
    return c.json({ error: "text_too_long" }, 413);
  }

  const res = await synthesizeSpeech(c.env, text);

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    console.error(`[tts] bytes ${res.status}: ${detail}`);
    return c.json({ error: "tts_failed" }, 502);
  }

  // On re-streame le MP3 tel quel ; cache navigateur court pour éviter de
  // re-facturer un re-clic sur le même passage (le front met aussi en cache).
  return c.body(res.body, 200, {
    "content-type": "audio/mpeg",
    "cache-control": "private, max-age=3600",
  });
});
