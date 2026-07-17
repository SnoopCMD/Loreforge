// Routes /api/characters (SPEC §5) : création et liste par bible.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";

const MAX_NAME_CHARS = 80;
const MAX_SHEET_BYTES = 16 * 1024;

export const characters = new Hono<AppEnv>();

characters.use("*", requireAuth);

interface CharacterRow {
  id: string;
  bible_id: string;
  name: string;
  sheet_json: string;
  portrait_r2_key: string | null;
  is_canon: number;
  created_at: number;
}

function toPublic(row: CharacterRow) {
  return {
    id: row.id,
    bible_id: row.bible_id,
    name: row.name,
    sheet: JSON.parse(row.sheet_json) as unknown,
    is_canon: row.is_canon === 1,
    created_at: row.created_at,
  };
}

// POST /api/characters — { bible_id, name, sheet_json }
characters.post("/", async (c) => {
  let body: { bible_id?: unknown; name?: unknown; sheet_json?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (typeof body.bible_id !== "string") {
    return c.json({ error: "missing_bible_id" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > MAX_NAME_CHARS) {
    return c.json({ error: "invalid_name" }, 400);
  }
  if (
    body.sheet_json === null ||
    typeof body.sheet_json !== "object" ||
    Array.isArray(body.sheet_json)
  ) {
    return c.json({ error: "invalid_sheet_json" }, 400);
  }
  const sheetJson = JSON.stringify(body.sheet_json);
  if (sheetJson.length > MAX_SHEET_BYTES) {
    return c.json({ error: "sheet_too_large" }, 413);
  }

  const user = c.get("user");
  const bible = await findOwnedBible(c.env.DB, body.bible_id, user.id);
  if (!bible) return c.json({ error: "bible_not_found" }, 404);

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO characters (id, bible_id, user_id, name, sheet_json, is_canon, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, bible.id, user.id, name, sheetJson, now)
    .run();

  return c.json(
    {
      id,
      bible_id: bible.id,
      name,
      sheet: body.sheet_json,
      is_canon: false,
      created_at: now,
    },
    201,
  );
});

// GET /api/characters?bible_id= — personnages de l'utilisateur pour une bible.
characters.get("/", async (c) => {
  const bibleId = c.req.query("bible_id");
  if (!bibleId) return c.json({ error: "missing_bible_id" }, 400);

  const user = c.get("user");
  const bible = await findOwnedBible(c.env.DB, bibleId, user.id);
  if (!bible) return c.json({ error: "bible_not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM characters WHERE bible_id = ? AND user_id = ?
     ORDER BY created_at DESC`,
  )
    .bind(bible.id, user.id)
    .all<CharacterRow>();

  return c.json({ characters: results.map(toPublic) });
});
