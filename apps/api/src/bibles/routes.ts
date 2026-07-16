import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import {
  isUsableMarkdown,
  MAX_IMPORT_BYTES,
  normalizeMarkdown,
  serializeToneProfile,
} from "./normalize";

export const bibles = new Hono<AppEnv>();

bibles.use("*", requireAuth);

interface BibleRow {
  id: string;
  user_id: string;
  title: string;
  source_type: string;
  r2_key: string | null;
  canon_md: string | null;
  tone_profile: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/** Colonnes renvoyées au client (jamais user_id ni r2_key). */
function toPublic(row: BibleRow, withContent: boolean) {
  return {
    id: row.id,
    title: row.title,
    source_type: row.source_type,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(withContent
      ? { canon_md: row.canon_md, tone_profile: row.tone_profile }
      : {}),
  };
}

async function findOwnedBible(
  db: D1Database,
  id: string,
  userId: string,
): Promise<BibleRow | null> {
  return db
    .prepare(`SELECT * FROM bibles WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<BibleRow>();
}

// POST /api/bibles — multipart (champ "file", "title" optionnel)
// ou JSON { markdown, title? }.
bibles.post("/", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let raw: string;
  let fallbackTitle: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: "missing_file" }, 400);
    }
    if (file.size > MAX_IMPORT_BYTES) {
      return c.json({ error: "file_too_large" }, 413);
    }
    raw = await file.text();
    fallbackTitle =
      typeof body["title"] === "string" && body["title"].trim() !== ""
        ? body["title"].trim()
        : file.name.replace(/\.(md|markdown|txt)$/i, "");
  } else {
    let body: { markdown?: unknown; title?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.markdown !== "string") {
      return c.json({ error: "missing_markdown" }, 400);
    }
    if (body.markdown.length > MAX_IMPORT_BYTES) {
      return c.json({ error: "file_too_large" }, 413);
    }
    raw = body.markdown;
    fallbackTitle =
      typeof body.title === "string" && body.title.trim() !== ""
        ? body.title.trim()
        : undefined;
  }

  if (!isUsableMarkdown(raw)) {
    return c.json({ error: "empty_markdown" }, 400);
  }

  const { title, canonMd } = normalizeMarkdown(raw, fallbackTitle);
  const user = c.get("user");
  const id = crypto.randomUUID();
  const now = Date.now();

  // Le fichier brut est conservé tel quel dans R2 (source de ré-import).
  const r2Key = `bibles/${id}/source.md`;
  await c.env.BUCKET.put(r2Key, raw, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  await c.env.DB.prepare(
    `INSERT INTO bibles
       (id, user_id, title, source_type, r2_key, canon_md, status, created_at, updated_at)
     VALUES (?, ?, ?, 'markdown', ?, ?, 'draft', ?, ?)`,
  )
    .bind(id, user.id, title, r2Key, canonMd, now, now)
    .run();

  return c.json(
    {
      id,
      title,
      source_type: "markdown",
      status: "draft",
      canon_md: canonMd,
      created_at: now,
      updated_at: now,
    },
    201,
  );
});

// GET /api/bibles — bibliothèque de l'utilisateur (sans canon_md).
bibles.get("/", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM bibles WHERE user_id = ? ORDER BY updated_at DESC`,
  )
    .bind(user.id)
    .all<BibleRow>();
  return c.json({ bibles: results.map((row) => toPublic(row, false)) });
});

// GET /api/bibles/:id — détail complet (canon_md + tone_profile).
bibles.get("/:id", async (c) => {
  const row = await findOwnedBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(toPublic(row, true));
});

// PATCH /api/bibles/:id — { canon_md?, tone_profile? }
bibles.patch("/:id", async (c) => {
  let body: { canon_md?: unknown; tone_profile?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.canon_md !== undefined) {
    if (typeof body.canon_md !== "string" || !isUsableMarkdown(body.canon_md)) {
      return c.json({ error: "invalid_canon_md" }, 400);
    }
    if (body.canon_md.length > MAX_IMPORT_BYTES) {
      return c.json({ error: "file_too_large" }, 413);
    }
    sets.push("canon_md = ?");
    values.push(body.canon_md);
  }

  if (body.tone_profile !== undefined) {
    const tone = serializeToneProfile(body.tone_profile);
    if (tone === null) return c.json({ error: "invalid_tone_profile" }, 400);
    sets.push("tone_profile = ?");
    values.push(tone);
  }

  if (sets.length === 0) return c.json({ error: "empty_patch" }, 400);

  const id = c.req.param("id");
  const user = c.get("user");
  const row = await findOwnedBible(c.env.DB, id, user.id);
  if (!row) return c.json({ error: "not_found" }, 404);

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE bibles SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
  )
    .bind(...values, now, id)
    .run();

  const updated = await findOwnedBible(c.env.DB, id, user.id);
  return c.json(toPublic(updated as BibleRow, true));
});
