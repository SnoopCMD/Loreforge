// Routes /api/sessions (SPEC §5) : validation + propriété côté worker,
// puis délégation au Durable Object GameSession (un DO par session).

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";
import { sessionKvKey } from "./do";

const FORMATS = ["oneshot", "mini", "campaign"] as const;

export const sessions = new Hono<AppEnv>();

sessions.use("*", requireAuth);

interface GameSessionRow {
  id: string;
  bible_id: string;
  user_id: string;
  character_id: string | null;
  format: string;
  trame: string | null;
  status: string;
  summary_md: string | null;
  created_at: number;
  finished_at: number | null;
}

// POST /api/sessions — { bible_id, character_id?, format, trame? }
// → crée le DO, retourne { session_id, setup_questions[] }.
sessions.post("/", async (c) => {
  let body: {
    bible_id?: unknown;
    character_id?: unknown;
    format?: unknown;
    trame?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (typeof body.bible_id !== "string") {
    return c.json({ error: "missing_bible_id" }, 400);
  }
  if (
    typeof body.format !== "string" ||
    !(FORMATS as readonly string[]).includes(body.format)
  ) {
    return c.json({ error: "invalid_format" }, 400);
  }
  const trame =
    body.trame === undefined || body.trame === null
      ? null
      : typeof body.trame === "string" && body.trame.trim() !== ""
        ? body.trame.trim().slice(0, 200)
        : null;
  const characterId =
    body.character_id === undefined || body.character_id === null
      ? null
      : typeof body.character_id === "string"
        ? body.character_id
        : undefined;
  if (characterId === undefined) {
    return c.json({ error: "invalid_character_id" }, 400);
  }

  const user = c.get("user");
  const bible = await findOwnedBible(c.env.DB, body.bible_id, user.id);
  if (!bible) return c.json({ error: "bible_not_found" }, 404);
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);

  if (characterId) {
    const character = await c.env.DB.prepare(
      `SELECT id FROM characters WHERE id = ? AND user_id = ? AND bible_id = ?`,
    )
      .bind(characterId, user.id, bible.id)
      .first();
    if (!character) return c.json({ error: "character_not_found" }, 404);
  }

  const doId = c.env.GAME_SESSIONS.newUniqueId();
  const sessionId = doId.toString();
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO game_sessions
       (id, bible_id, user_id, character_id, format, trame, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'setup', ?)`,
  )
    .bind(sessionId, bible.id, user.id, characterId, body.format, trame, now)
    .run();

  const stub = c.env.GAME_SESSIONS.get(doId);
  const res = await stub.fetch("https://do/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      userId: user.id,
      bibleId: bible.id,
      characterId,
      format: body.format,
      trame,
    }),
  });
  if (!res.ok) {
    // Init impossible (bible vidée entre-temps...) : pas de ligne orpheline.
    await c.env.DB.prepare(`DELETE FROM game_sessions WHERE id = ?`)
      .bind(sessionId)
      .run();
    return c.json({ error: "session_init_failed" }, 500);
  }

  const { setup_questions } = (await res.json()) as {
    setup_questions: string[];
  };
  return c.json({ session_id: sessionId, setup_questions }, 201);
});

async function loadOwnedSession(
  db: D1Database,
  id: string,
  userId: string,
): Promise<GameSessionRow | null> {
  return db
    .prepare(`SELECT * FROM game_sessions WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<GameSessionRow>();
}

/** Proxy d'un endpoint du DO ; le corps de la requête est transmis tel quel. */
function proxy(path: string) {
  return async (c: Context<AppEnv, "/:id">): Promise<Response> => {
    const row = await loadOwnedSession(
      c.env.DB,
      c.req.param("id"),
      c.get("user").id,
    );
    if (!row) return c.json({ error: "not_found" }, 404);

    const stub = c.env.GAME_SESSIONS.get(
      c.env.GAME_SESSIONS.idFromString(row.id),
    );
    return stub.fetch(new Request(`https://do${path}`, c.req.raw));
  };
}

sessions.post("/:id/setup", proxy("/setup"));
sessions.post("/:id/turn", proxy("/turn"));
sessions.post("/:id/roll", proxy("/roll"));
sessions.post("/:id/finish", proxy("/finish"));

// GET /api/sessions/:id/state — cache chaud KV, sinon DO (qui repeuple KV).
sessions.get("/:id/state", async (c) => {
  const row = await loadOwnedSession(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!row) return c.json({ error: "not_found" }, 404);

  const cached = await c.env.CACHE.get(sessionKvKey(row.id));
  if (cached) {
    return c.body(cached, 200, { "content-type": "application/json" });
  }

  const stub = c.env.GAME_SESSIONS.get(
    c.env.GAME_SESSIONS.idFromString(row.id),
  );
  return stub.fetch("https://do/state");
});
