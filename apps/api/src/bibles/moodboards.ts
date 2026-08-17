// Routes /api/bibles/:id/moodboards — références graphiques d'une bible.
//
// Un tableau de références regroupe des images (fichier uploadé ou URL) toutes
// copiées dans R2 : une URL peut mourir, la référence non. L'analyse lit le
// tableau entier et renvoie une ambiance + des palettes, que les sessions
// peuvent adopter (voir sessions/routes.ts).

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible, type BibleRow } from "./db";
import {
  analyzeMoodboard,
  MAX_ANALYZED_IMAGES,
  VISION_MEDIA_TYPES,
  type VisionImage,
} from "./moodboard-ai";
import { parsePalettes, type Palette } from "./palette";
import {
  MAX_ZIP_BYTES,
  pickZipImages,
  ZipError,
  type ZipPick,
} from "./moodboard-zip";

export const moodboards = new Hono<AppEnv>();

moodboards.use("*", requireAuth);

/** Limite Anthropic pour une image en base64 ; sert aussi de garde-fou R2. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Au-delà, un tableau n'est plus une référence mais une galerie. */
export const MAX_IMAGES_PER_BOARD = 24;
const MAX_BOARDS_PER_BIBLE = 20;
const MAX_TITLE = 120;
const MAX_NOTE = 1000;
const MAX_CAPTION = 200;

interface MoodboardRow {
  id: string;
  bible_id: string;
  title: string;
  note: string | null;
  analysis_md: string | null;
  palettes_json: string | null;
  analyzed_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface ImageRow {
  id: string;
  moodboard_id: string;
  bible_id: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  source_url: string | null;
  caption: string | null;
  sort_order: number;
  created_at: number;
}

/** Vue client d'une image : jamais la clé R2, seulement l'URL de service. */
function toPublicImage(row: ImageRow) {
  return {
    id: row.id,
    url: `/api/bibles/${row.bible_id}/moodboards/${row.moodboard_id}/images/${row.id}/file`,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    source_url: row.source_url,
    caption: row.caption,
    sort_order: row.sort_order,
    created_at: row.created_at,
  };
}

function toPublicBoard(row: MoodboardRow, images: ImageRow[]) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    analysis_md: row.analysis_md,
    palettes: parsePalettes(row.palettes_json, 3),
    analyzed_at: row.analyzed_at,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
    images: images.map(toPublicImage),
  };
}

async function owned(c: Context<AppEnv>): Promise<BibleRow | null> {
  return findOwnedBible(c.env.DB, c.req.param("id") ?? "", c.get("user").id);
}

/** Charge un tableau de la bible, ou null. */
async function loadBoard(
  db: D1Database,
  bibleId: string,
  boardId: string,
): Promise<MoodboardRow | null> {
  return db
    .prepare(`SELECT * FROM bible_moodboards WHERE id = ? AND bible_id = ?`)
    .bind(boardId, bibleId)
    .first<MoodboardRow>();
}

async function listImages(db: D1Database, boardId: string): Promise<ImageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM moodboard_images WHERE moodboard_id = ?
       ORDER BY sort_order, created_at`,
    )
    .bind(boardId)
    .all<ImageRow>();
  return results;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text.slice(0, max);
}

// GET /:id/moodboards — tous les tableaux de la bible, images comprises.
moodboards.get("/:id/moodboards", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const { results: boards } = await c.env.DB.prepare(
    `SELECT * FROM bible_moodboards WHERE bible_id = ? ORDER BY sort_order, created_at`,
  )
    .bind(bible.id)
    .all<MoodboardRow>();

  const { results: images } = await c.env.DB.prepare(
    `SELECT * FROM moodboard_images WHERE bible_id = ? ORDER BY sort_order, created_at`,
  )
    .bind(bible.id)
    .all<ImageRow>();

  return c.json({
    moodboards: boards.map((board) =>
      toPublicBoard(
        board,
        images.filter((img) => img.moodboard_id === board.id),
      ),
    ),
  });
});

// POST /:id/moodboards — { title?, note? }
moodboards.post("/:id/moodboards", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { title?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bible_moodboards WHERE bible_id = ?`,
  )
    .bind(bible.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_BOARDS_PER_BIBLE) {
    return c.json({ error: "too_many_moodboards" }, 409);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO bible_moodboards
       (id, bible_id, title, note, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      bible.id,
      cleanText(body.title, MAX_TITLE) ?? "Nouveau tableau",
      cleanText(body.note, MAX_NOTE),
      count?.n ?? 0,
      now,
      now,
    )
    .run();

  const row = await loadBoard(c.env.DB, bible.id, id);
  return c.json(toPublicBoard(row!, []), 201);
});

// PATCH /:id/moodboards/:mid — { title?, note? }
moodboards.patch("/:id/moodboards/:mid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { title?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const board = await loadBoard(c.env.DB, bible.id, c.req.param("mid"));
  if (!board) return c.json({ error: "moodboard_not_found" }, 404);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) {
    const title = cleanText(body.title, MAX_TITLE);
    if (!title) return c.json({ error: "invalid_title" }, 400);
    sets.push("title = ?");
    values.push(title);
  }
  if (body.note !== undefined) {
    sets.push("note = ?");
    values.push(cleanText(body.note, MAX_NOTE));
  }
  if (sets.length === 0) return c.json({ error: "empty_patch" }, 400);

  await c.env.DB.prepare(
    `UPDATE bible_moodboards SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
  )
    .bind(...values, Date.now(), board.id)
    .run();

  const updated = await loadBoard(c.env.DB, bible.id, board.id);
  return c.json(toPublicBoard(updated!, await listImages(c.env.DB, board.id)));
});

// DELETE /:id/moodboards/:mid — le tableau et toutes ses images (D1 + R2).
moodboards.delete("/:id/moodboards/:mid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const board = await loadBoard(c.env.DB, bible.id, c.req.param("mid"));
  if (!board) return c.json({ error: "moodboard_not_found" }, 404);

  const images = await listImages(c.env.DB, board.id);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM moodboard_images WHERE moodboard_id = ?`).bind(board.id),
    c.env.DB.prepare(`DELETE FROM bible_moodboards WHERE id = ?`).bind(board.id),
  ]);
  if (images.length) {
    c.executionCtx.waitUntil(
      Promise.all(images.map((img) => c.env.BUCKET.delete(img.r2_key))).then(() => {}),
    );
  }
  return c.json({ ok: true });
});

/** Extension de fichier déduite du type MIME (clé R2 lisible). */
function extFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

function isSupportedType(contentType: string): boolean {
  return (VISION_MEDIA_TYPES as readonly string[]).includes(contentType);
}

/** Type MIME nu, sans paramètres (`image/png; charset=…`). */
function bareType(header: string): string {
  return header.split(";")[0].trim().toLowerCase();
}

/**
 * Hôtes qu'on refuse de récupérer côté serveur : une URL fournie par
 * l'utilisateur ne doit pas servir à sonder le réseau interne.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  if (/^169\.254\./.test(host)) return true; // link-local (métadonnées cloud)
  const private172 = host.match(/^172\.(\d+)\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) {
    return true;
  }
  return false;
}

interface FetchedImage {
  bytes: Uint8Array;
  contentType: string;
}

/** Erreur d'import d'image : le code part tel quel au client. */
class ImageError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(code);
  }
}

/** Récupère une image distante en la validant (protocole, type, taille). */
async function fetchRemoteImage(rawUrl: string): Promise<FetchedImage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageError("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ImageError("invalid_url");
  }
  if (isBlockedHost(url.hostname)) throw new ImageError("blocked_url");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { accept: "image/*" },
      redirect: "follow",
    });
  } catch {
    throw new ImageError("fetch_failed");
  }
  if (!res.ok) throw new ImageError("fetch_failed");

  const contentType = bareType(res.headers.get("content-type") ?? "");
  if (!isSupportedType(contentType)) throw new ImageError("unsupported_type");

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) throw new ImageError("image_too_large", 413);

  const bytes = new Uint8Array(await res.arrayBuffer());
  // Le content-length peut mentir ou manquer : on revérifie sur le réel.
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageError("image_too_large", 413);
  }
  if (bytes.byteLength === 0) throw new ImageError("fetch_failed");

  return { bytes, contentType };
}

// POST /:id/moodboards/:mid/images — multipart (champ "file", "caption"
// optionnel) ou JSON { url, caption? }. Dans les deux cas l'image finit dans R2.
moodboards.post("/:id/moodboards/:mid/images", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const board = await loadBoard(c.env.DB, bible.id, c.req.param("mid"));
  if (!board) return c.json({ error: "moodboard_not_found" }, 404);

  const existing = await listImages(c.env.DB, board.id);
  if (existing.length >= MAX_IMAGES_PER_BOARD) {
    return c.json({ error: "too_many_images" }, 409);
  }

  let bytes: Uint8Array;
  let contentType: string;
  let sourceUrl: string | null = null;
  let caption: string | null = null;

  const isMultipart = (c.req.header("content-type") ?? "").includes(
    "multipart/form-data",
  );
  try {
    if (isMultipart) {
      const form = await c.req.parseBody();
      const file = form["file"];
      if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
      contentType = bareType(file.type || "");
      if (!isSupportedType(contentType)) {
        return c.json({ error: "unsupported_type" }, 400);
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return c.json({ error: "image_too_large" }, 413);
      }
      bytes = new Uint8Array(await file.arrayBuffer());
      caption = cleanText(form["caption"], MAX_CAPTION);
    } else {
      let body: { url?: unknown; caption?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      if (typeof body.url !== "string" || body.url.trim() === "") {
        return c.json({ error: "missing_url" }, 400);
      }
      const fetched = await fetchRemoteImage(body.url.trim());
      bytes = fetched.bytes;
      contentType = fetched.contentType;
      sourceUrl = body.url.trim().slice(0, 2000);
      caption = cleanText(body.caption, MAX_CAPTION);
    }
  } catch (err) {
    if (err instanceof ImageError) return c.json({ error: err.code }, err.status);
    throw err;
  }

  const id = crypto.randomUUID();
  const r2Key = `moodboards/${board.id}/${id}.${extFor(contentType)}`;
  await c.env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType } });

  const nextOrder = existing.length
    ? Math.max(...existing.map((i) => i.sort_order)) + 1
    : 0;
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO moodboard_images
           (id, moodboard_id, bible_id, r2_key, content_type, size_bytes,
            source_url, caption, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        board.id,
        bible.id,
        r2Key,
        contentType,
        bytes.byteLength,
        sourceUrl,
        caption,
        nextOrder,
        now,
      ),
    c.env.DB
      .prepare(`UPDATE bible_moodboards SET updated_at = ? WHERE id = ?`)
      .bind(now, board.id),
  ]);

  const row = await c.env.DB.prepare(`SELECT * FROM moodboard_images WHERE id = ?`)
    .bind(id)
    .first<ImageRow>();
  return c.json(toPublicImage(row!), 201);
});

// POST /:id/moodboards/:mid/images/zip — multipart (champ "file" : une archive
// .zip). Toutes les images reconnues y sont importées d'un coup, dans l'ordre
// des chemins ; le reste est ignoré et compté (l'import ne casse pas pour un
// .txt égaré). Le nom de fichier sert de légende, souvent le seul indice de
// provenance qui reste d'une planche récupérée ailleurs.
moodboards.post("/:id/moodboards/:mid/images/zip", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const board = await loadBoard(c.env.DB, bible.id, c.req.param("mid"));
  if (!board) return c.json({ error: "moodboard_not_found" }, 404);

  const existing = await listImages(c.env.DB, board.id);
  const room = MAX_IMAGES_PER_BOARD - existing.length;
  if (room <= 0) return c.json({ error: "too_many_images" }, 409);

  if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    return c.json({ error: "expected_multipart" }, 400);
  }
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
  if (file.size > MAX_ZIP_BYTES) return c.json({ error: "zip_too_large" }, 413);

  let picked: ZipPick;
  try {
    picked = pickZipImages(
      new Uint8Array(await file.arrayBuffer()),
      room,
      MAX_IMAGE_BYTES,
    );
  } catch (err) {
    if (err instanceof ZipError) return c.json({ error: err.code }, 400);
    throw err;
  }
  if (picked.images.length === 0) {
    return c.json({ error: "no_image_in_zip", skipped: picked.skipped }, 400);
  }

  let nextOrder = existing.length
    ? Math.max(...existing.map((i) => i.sort_order)) + 1
    : 0;
  const now = Date.now();
  const statements = [];
  const added: string[] = [];
  for (const image of picked.images) {
    const id = crypto.randomUUID();
    const r2Key = `moodboards/${board.id}/${id}.${extFor(image.contentType)}`;
    // R2 d'abord : une image en trop dans le bucket est inerte, une ligne D1
    // sans objet servirait une vignette cassée.
    await c.env.BUCKET.put(r2Key, image.bytes, {
      httpMetadata: { contentType: image.contentType },
    });
    statements.push(
      c.env.DB
        .prepare(
          `INSERT INTO moodboard_images
             (id, moodboard_id, bible_id, r2_key, content_type, size_bytes,
              source_url, caption, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .bind(
          id,
          board.id,
          bible.id,
          r2Key,
          image.contentType,
          image.bytes.byteLength,
          (image.name.split("/").pop() ?? image.name).slice(0, MAX_CAPTION),
          nextOrder++,
          now,
        ),
    );
    added.push(id);
  }
  statements.push(
    c.env.DB
      .prepare(`UPDATE bible_moodboards SET updated_at = ? WHERE id = ?`)
      .bind(now, board.id),
  );
  await c.env.DB.batch(statements);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM moodboard_images WHERE moodboard_id = ?
     ORDER BY sort_order, created_at`,
  )
    .bind(board.id)
    .all<ImageRow>();
  return c.json(
    {
      added: added.length,
      skipped: picked.skipped,
      images: results.map(toPublicImage),
    },
    201,
  );
});

// GET /:id/moodboards/:mid/images/:iid/file — sert l'image depuis R2.
// Passe par le worker (et donc par requireAuth) : le bucket reste privé.
moodboards.get("/:id/moodboards/:mid/images/:iid/file", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT * FROM moodboard_images WHERE id = ? AND moodboard_id = ? AND bible_id = ?`,
  )
    .bind(c.req.param("iid"), c.req.param("mid"), bible.id)
    .first<ImageRow>();
  if (!row) return c.json({ error: "image_not_found" }, 404);

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: "image_not_found" }, 404);

  return new Response(object.body, {
    headers: {
      "content-type": row.content_type,
      // Immuable : la clé R2 contient l'uuid de l'image, jamais réutilisé.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
});

// DELETE /:id/moodboards/:mid/images/:iid
moodboards.delete("/:id/moodboards/:mid/images/:iid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT * FROM moodboard_images WHERE id = ? AND moodboard_id = ? AND bible_id = ?`,
  )
    .bind(c.req.param("iid"), c.req.param("mid"), bible.id)
    .first<ImageRow>();
  if (!row) return c.json({ error: "image_not_found" }, 404);

  await c.env.DB.prepare(`DELETE FROM moodboard_images WHERE id = ?`)
    .bind(row.id)
    .run();
  c.executionCtx.waitUntil(c.env.BUCKET.delete(row.r2_key));
  return c.json({ ok: true });
});

// POST /:id/moodboards/:mid/analyze — lecture d'ambiance + palettes proposées.
moodboards.post("/:id/moodboards/:mid/analyze", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "analyzer_not_configured" }, 503);
  }

  const board = await loadBoard(c.env.DB, bible.id, c.req.param("mid"));
  if (!board) return c.json({ error: "moodboard_not_found" }, 404);

  const images = await listImages(c.env.DB, board.id);
  if (images.length === 0) return c.json({ error: "empty_moodboard" }, 400);

  // On ne lit que les premières images : au-delà, l'appel s'alourdit sans
  // changer la lecture d'ensemble.
  const payload: VisionImage[] = [];
  for (const img of images.slice(0, MAX_ANALYZED_IMAGES)) {
    const object = await c.env.BUCKET.get(img.r2_key);
    if (!object) continue; // image perdue côté R2 : on analyse sans elle
    payload.push({
      mediaType: img.content_type,
      bytes: new Uint8Array(await object.arrayBuffer()),
    });
  }
  if (payload.length === 0) return c.json({ error: "empty_moodboard" }, 400);

  let analysisMd: string;
  let palettes: Palette[];
  try {
    const result = await analyzeMoodboard(
      c.env.ANTHROPIC_API_KEY,
      bible.title,
      board.title,
      board.note,
      payload,
    );
    analysisMd = result.analysisMd;
    palettes = result.palettes;
  } catch (err) {
    console.error("[moodboards] analyse :", err);
    return c.json({ error: "analysis_failed" }, 502);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE bible_moodboards
       SET analysis_md = ?, palettes_json = ?, analyzed_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(analysisMd, JSON.stringify(palettes), now, now, board.id)
    .run();

  return c.json({ analysis_md: analysisMd, palettes, analyzed_at: now });
});

// GET /:id/palettes — toutes les palettes proposées par la bible, à plat.
// Alimente le panneau d'ambiance avant et pendant une session.
moodboards.get("/:id/palettes", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, palettes_json FROM bible_moodboards
     WHERE bible_id = ? AND palettes_json IS NOT NULL
     ORDER BY sort_order, created_at`,
  )
    .bind(bible.id)
    .all<{ id: string; title: string; palettes_json: string }>();

  const palettes = results.flatMap((row) =>
    parsePalettes(row.palettes_json, 3).map((palette) => ({
      ...palette,
      moodboard_id: row.id,
      moodboard_title: row.title,
    })),
  );
  return c.json({ palettes });
});
