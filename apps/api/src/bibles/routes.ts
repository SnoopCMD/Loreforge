import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible, type BibleRow } from "./db";
import {
  isUsableMarkdown,
  MAX_IMPORT_BYTES,
  normalizeMarkdown,
  serializeToneProfile,
} from "./normalize";
import { purgeBibleIndex, reindexBible } from "../rag/store";
import {
  detectFormat,
  ensureExtractedSize,
  ExtractError,
  extractMarkdown,
  MAX_UPLOAD_BYTES,
  stripImportExtension,
  type ImportFormat,
} from "./extract";

export const bibles = new Hono<AppEnv>();

bibles.use("*", requireAuth);

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

// POST /api/bibles — multipart (champ "file" : .md/.txt/.zip/.pdf/.docx,
// "title" optionnel) ou JSON { markdown, title? }.
bibles.post("/", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let raw: string;
  let fallbackTitle: string | undefined;
  let sourceType: ImportFormat = "markdown";
  let sourceBytes: Uint8Array | null = null;
  let sourceContentType = "text/markdown; charset=utf-8";
  let sourceExt = "md";

  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: "missing_file" }, 400);
    }
    sourceType = detectFormat(file.name);
    const maxBytes =
      sourceType === "markdown" ? MAX_IMPORT_BYTES : MAX_UPLOAD_BYTES;
    if (file.size > maxBytes) {
      return c.json({ error: "file_too_large" }, 413);
    }
    sourceBytes = new Uint8Array(await file.arrayBuffer());
    try {
      raw = await extractMarkdown(sourceType, sourceBytes);
      ensureExtractedSize(raw);
    } catch (err) {
      if (err instanceof ExtractError) {
        return c.json(
          { error: err.code },
          err.code === "file_too_large" ? 413 : 400,
        );
      }
      throw err;
    }
    if (sourceType !== "markdown") {
      sourceExt = file.name.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? "bin";
      sourceContentType = file.type || "application/octet-stream";
    }
    fallbackTitle =
      typeof body["title"] === "string" && body["title"].trim() !== ""
        ? body["title"].trim()
        : stripImportExtension(file.name);
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
  const r2Key = `bibles/${id}/source.${sourceExt}`;
  await c.env.BUCKET.put(r2Key, sourceBytes ?? raw, {
    httpMetadata: { contentType: sourceContentType },
  });

  await c.env.DB.prepare(
    `INSERT INTO bibles
       (id, user_id, title, source_type, r2_key, canon_md, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  )
    .bind(id, user.id, title, sourceType, r2Key, canonMd, now, now)
    .run();

  // RAG (M6) : indexation en tâche de fond (no-op sous le seuil).
  c.executionCtx.waitUntil(reindexBible(c.env, id, canonMd));

  return c.json(
    {
      id,
      title,
      source_type: sourceType,
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

const MAX_TITLE_LENGTH = 200;

// PATCH /api/bibles/:id — { title?, canon_md?, tone_profile? }
bibles.patch("/:id", async (c) => {
  let body: { title?: unknown; canon_md?: unknown; tone_profile?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title === "" || title.length > MAX_TITLE_LENGTH) {
      return c.json({ error: "invalid_title" }, 400);
    }
    sets.push("title = ?");
    values.push(title);
  }

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
  if (body.canon_md !== undefined) {
    c.executionCtx.waitUntil(
      reindexBible(c.env, id, (updated as BibleRow).canon_md ?? ""),
    );
  }
  return c.json(toPublic(updated as BibleRow, true));
});

// DELETE /api/bibles/:id — suppression complète : lignes D1 liées,
// fichier source R2, index RAG (Vectorize + méta KV).
bibles.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await findOwnedBible(c.env.DB, id, c.get("user").id);
  if (!row) return c.json({ error: "not_found" }, 404);

  // Images de référence : les clés R2 doivent être lues avant le DELETE.
  const { results: moodboardImages } = await c.env.DB.prepare(
    `SELECT r2_key FROM moodboard_images WHERE bible_id = ?`,
  )
    .bind(id)
    .all<{ r2_key: string }>();

  // Enfants d'abord (canon_proposals référence aussi game_sessions).
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM writing_messages WHERE writing_id IN
         (SELECT id FROM writing_sessions WHERE bible_id = ?)`,
    ).bind(id),
    c.env.DB.prepare(`DELETE FROM writing_sessions WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM moodboard_images WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM bible_moodboards WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM canon_proposals WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM game_sessions WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM characters WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM richness_scores WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sheet_schemas WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM bible_sections WHERE bible_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM bibles WHERE id = ?`).bind(id),
  ]);

  if (row.r2_key) {
    c.executionCtx.waitUntil(c.env.BUCKET.delete(row.r2_key));
  }
  if (moodboardImages.length) {
    c.executionCtx.waitUntil(
      Promise.all(
        moodboardImages.map((img) => c.env.BUCKET.delete(img.r2_key)),
      ).then(() => {}),
    );
  }
  c.executionCtx.waitUntil(purgeBibleIndex(c.env, id));

  return c.json({ ok: true });
});
