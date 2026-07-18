// Routes /api/characters (SPEC §5 + §6bis) : création « full », liste par
// bible, questionnaire éclair (Incarner-express), suggestion ✨ et
// validation de fiche.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible, type BibleRow } from "../bibles/db";
import { latestSheetSchema } from "./db";
import {
  generateQuickCharacter,
  generateQuiz,
  suggestField,
  validateSheet,
  type QuizAnswer,
} from "./ai";

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
  origin: string;
  is_canon: number;
  created_at: number;
}

function toPublic(row: CharacterRow) {
  return {
    id: row.id,
    bible_id: row.bible_id,
    name: row.name,
    sheet: JSON.parse(row.sheet_json) as unknown,
    origin: row.origin,
    is_canon: row.is_canon === 1,
    created_at: row.created_at,
  };
}

/** Corps JSON + bible possédée, mutualisés par les routes §6bis. */
async function loadBibleFromBody(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; body: Record<string, unknown>; bible: BibleRow }
  | { ok: false; res: Response }
> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid_json" }, 400) };
  }
  if (typeof body.bible_id !== "string") {
    return { ok: false, res: c.json({ error: "missing_bible_id" }, 400) };
  }
  const bible = await findOwnedBible(c.env.DB, body.bible_id, c.get("user").id);
  if (!bible) {
    return { ok: false, res: c.json({ error: "bible_not_found" }, 404) };
  }
  return { ok: true, body, bible };
}

function cleanSheet(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const sheet: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") sheet[k] = v;
    else if (v !== null && v !== undefined) sheet[k] = JSON.stringify(v);
  }
  return sheet;
}

async function insertCharacter(
  c: Context<AppEnv>,
  bible: BibleRow,
  name: string,
  sheet: Record<string, string>,
  origin: "quick" | "full",
): Promise<Response> {
  const sheetJson = JSON.stringify(sheet);
  if (sheetJson.length > MAX_SHEET_BYTES) {
    return c.json({ error: "sheet_too_large" }, 413);
  }
  const latest = await latestSheetSchema(c.env.DB, bible.id);
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO characters
       (id, bible_id, user_id, name, sheet_json, sheet_schema_json, origin, is_canon, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      id,
      bible.id,
      c.get("user").id,
      name,
      sheetJson,
      latest ? JSON.stringify(latest.schema) : null,
      origin,
      now,
    )
    .run();
  return c.json(
    {
      id,
      bible_id: bible.id,
      name,
      sheet,
      origin,
      is_canon: false,
      created_at: now,
    },
    201,
  );
}

// POST /api/characters — { bible_id, name, sheet_json } (origin = full).
characters.post("/", async (c) => {
  const loaded = await loadBibleFromBody(c);
  if (!loaded.ok) return loaded.res;
  const { body, bible } = loaded;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > MAX_NAME_CHARS) {
    return c.json({ error: "invalid_name" }, 400);
  }
  const sheet = cleanSheet(body.sheet_json);
  if (sheet === null) return c.json({ error: "invalid_sheet_json" }, 400);

  return insertCharacter(c, bible, name, sheet, "full");
});

// GET /api/characters?bible_id= — persos canon + persos créés par le joueur.
characters.get("/", async (c) => {
  const bibleId = c.req.query("bible_id");
  if (!bibleId) return c.json({ error: "missing_bible_id" }, 400);

  const user = c.get("user");
  const bible = await findOwnedBible(c.env.DB, bibleId, user.id);
  if (!bible) return c.json({ error: "bible_not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM characters WHERE bible_id = ? AND (user_id = ? OR is_canon = 1)
     ORDER BY is_canon DESC, created_at DESC`,
  )
    .bind(bible.id, user.id)
    .all<CharacterRow>();

  return c.json({ characters: results.map(toPublic) });
});

// ── §6bis — Incarner-express : questionnaire éclair ──────────────────────

// POST /api/characters/embody-quiz — { bible_id } → 3-4 questions à choix.
characters.post("/embody-quiz", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "character_ai_not_configured" }, 503);
  }
  const loaded = await loadBibleFromBody(c);
  if (!loaded.ok) return loaded.res;
  const { bible } = loaded;
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);

  const latest = await latestSheetSchema(c.env.DB, bible.id);
  try {
    const questions = await generateQuiz(
      c.env.ANTHROPIC_API_KEY,
      bible.title,
      bible.canon_md,
      latest?.schema ?? null,
    );
    return c.json({ questions });
  } catch (err) {
    console.error(`[characters] quiz échoué pour ${bible.id}:`, err);
    return c.json({ error: "quiz_failed" }, 502);
  }
});

// POST /api/characters/embody-quiz/answers — { bible_id, answers[] }
// → l'IA rédige la fiche complète, personnage créé avec origin = quick.
characters.post("/embody-quiz/answers", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "character_ai_not_configured" }, 503);
  }
  const loaded = await loadBibleFromBody(c);
  if (!loaded.ok) return loaded.res;
  const { body, bible } = loaded;
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);

  const answers: QuizAnswer[] = [];
  if (Array.isArray(body.answers)) {
    for (const entry of body.answers) {
      if (entry === null || typeof entry !== "object") continue;
      const { question, answer } = entry as Record<string, unknown>;
      if (typeof question === "string" && typeof answer === "string") {
        answers.push({
          question: question.slice(0, 300),
          answer: answer.slice(0, 300),
        });
      }
    }
  }

  const latest = await latestSheetSchema(c.env.DB, bible.id);
  try {
    const generated = await generateQuickCharacter(
      c.env.ANTHROPIC_API_KEY,
      bible.title,
      bible.canon_md,
      latest?.schema ?? null,
      answers.slice(0, 6),
    );
    return insertCharacter(c, bible, generated.name, generated.sheet, "quick");
  } catch (err) {
    console.error(`[characters] fiche quick échouée pour ${bible.id}:`, err);
    return c.json({ error: "quick_character_failed" }, 502);
  }
});

// ── §6bis — Créer : suggestion ✨ par champ et validation de fiche ───────

// POST /api/characters/suggest — { bible_id, field_key, sheet } → { value }
characters.post("/suggest", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "character_ai_not_configured" }, 503);
  }
  const loaded = await loadBibleFromBody(c);
  if (!loaded.ok) return loaded.res;
  const { body, bible } = loaded;
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);
  if (typeof body.field_key !== "string" || body.field_key.trim() === "") {
    return c.json({ error: "missing_field_key" }, 400);
  }
  const sheet = cleanSheet(body.sheet ?? {});
  if (sheet === null) return c.json({ error: "invalid_sheet" }, 400);

  const latest = await latestSheetSchema(c.env.DB, bible.id);
  try {
    const value = await suggestField(
      c.env.ANTHROPIC_API_KEY,
      bible.title,
      bible.canon_md,
      latest?.schema ?? null,
      sheet,
      body.field_key.trim(),
    );
    return c.json({ value });
  } catch (err) {
    console.error(`[characters] suggestion échouée pour ${bible.id}:`, err);
    return c.json({ error: "suggest_failed" }, 502);
  }
});

// POST /api/characters/validate — { bible_id, sheet } → { issues[] }
characters.post("/validate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "character_ai_not_configured" }, 503);
  }
  const loaded = await loadBibleFromBody(c);
  if (!loaded.ok) return loaded.res;
  const { body, bible } = loaded;
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);
  const sheet = cleanSheet(body.sheet ?? {});
  if (sheet === null) return c.json({ error: "invalid_sheet" }, 400);

  const latest = await latestSheetSchema(c.env.DB, bible.id);
  try {
    const issues = await validateSheet(
      c.env.ANTHROPIC_API_KEY,
      bible.title,
      bible.canon_md,
      latest?.schema ?? null,
      sheet,
    );
    return c.json({ issues });
  } catch (err) {
    console.error(`[characters] validation échouée pour ${bible.id}:`, err);
    return c.json({ error: "validate_failed" }, 502);
  }
});
