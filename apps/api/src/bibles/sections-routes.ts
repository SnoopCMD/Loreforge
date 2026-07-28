// Routes /api/bibles/:id/sections — édition par sections (refonte éditeur).
// Les sections sont la source de vérité éditable ; toute mutation régénère
// bibles.canon_md (dérivé) et relance l'indexation RAG. Propriété vérifiée par
// findOwnedBible sur chaque appel.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "./db";
import { MAX_IMPORT_BYTES } from "./normalize";
import { reindexBible } from "../rag/store";
import { classifySections, ensureSections } from "./classify";
import {
  insertSections,
  isDescendantOf,
  listSections,
  MAX_SECTION_DEPTH,
  regenerateCanon,
  renderCanon,
  sectionDepth,
  subtreeHeight,
  toPublicSection,
  type SectionRow,
} from "./sections";

export const bibleSections = new Hono<AppEnv>();

bibleSections.use("*", requireAuth);

const MAX_SECTION_TITLE = 200;

/** Charge la bible possédée ou renvoie null (le handler répond 404). */
async function owned(c: Context<AppEnv>) {
  return findOwnedBible(c.env.DB, c.req.param("id") ?? "", c.get("user").id);
}

/** Régénère le canon puis relance l'indexation RAG en tâche de fond. */
async function syncCanon(
  c: Context<AppEnv>,
  bibleId: string,
  title: string,
): Promise<void> {
  const canon = await regenerateCanon(c.env.DB, bibleId, title);
  c.executionCtx.waitUntil(reindexBible(c.env, bibleId, canon));
}

// GET /:id/sections — liste ordonnée. Init paresseuse au premier accès :
// répartit le canon existant par titres H2 (heuristique, synchrone) ou crée 8
// sections de base vides — migre aussi les bibles créées avant la refonte.
// Volontairement sans IA : le canon existant est déjà structuré en H2 propres,
// et bloquer le chargement de l'éditeur sur un appel Sonnet (plusieurs dizaines
// de secondes) figeait l'écran sur « Chargement… ».
bibleSections.get("/:id/sections", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const { rows, initialized } = await ensureSections(c.env.DB, bible, {
    useAi: false,
  });
  if (initialized) {
    // Le canon a été régénéré à l'init : on réindexe en tâche de fond.
    c.executionCtx.waitUntil(
      reindexBible(c.env, bible.id, renderCanon(bible.title, rows)),
    );
  }
  return c.json({ sections: rows.map(toPublicSection) });
});

// POST /:id/sections/redistribute — reclasse les SECTIONS existantes et les
// REMPLACE. Le modèle ne renvoie qu'un PLAN (section → catégorie) ; le contenu
// est réassemblé localement, jamais réécrit ni ré-émis. 1 section = 1 bloc (pas
// de re-découpage du canon). Sortie minuscule → appel de quelques secondes,
// sans risque de troncature ni d'éviction Workers.
bibleSections.post("/:id/sections/redistribute", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const current = await listSections(c.env.DB, bible.id);
  // Garde-fou : la répartition remplace tout le découpage par une liste plate
  // de sections de base. Une bible organisée en dossiers/sous-niveaux perdrait
  // silencieusement toute sa structure — on refuse.
  if (current.some((s) => s.kind === "folder" || s.parent_id !== null)) {
    return c.json({ error: "has_folders" }, 409);
  }
  const classified = await classifySections(c.env.ANTHROPIC_API_KEY, current);
  await c.env.DB.prepare(`DELETE FROM bible_sections WHERE bible_id = ?`)
    .bind(bible.id)
    .run();
  await insertSections(c.env.DB, bible.id, classified);
  await syncCanon(c, bible.id, bible.title);
  const rows = await listSections(c.env.DB, bible.id);
  return c.json({ sections: rows.map(toPublicSection) });
});

/**
 * Valide un rattachement à `parentId` : le parent peut être un dossier OU une
 * section de la bible (ex. sous-dossiers de trames dans « Trames & conflits »),
 * et la profondeur résultante doit rester dans la limite (un dossier garde de
 * la place pour sa descendance, actuelle ou future). Renvoie un code d'erreur
 * ou null si le rattachement est valide.
 */
function checkParent(
  rows: SectionRow[],
  parentId: string,
  kind: string,
  height: number,
): "invalid_parent" | "too_deep" | null {
  const parent = rows.find((r) => r.id === parentId);
  if (!parent) return "invalid_parent";
  const depth = sectionDepth(rows, parentId) + 1;
  const reserve = kind === "folder" ? Math.max(height, 1) : height;
  if (depth + reserve > MAX_SECTION_DEPTH) return "too_deep";
  return null;
}

// POST /:id/sections — ajoute une section (ou un dossier : kind "folder") en
// fin de liste, à la racine ou dans le dossier `parent_id`.
bibleSections.post("/:id/sections", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { title?: unknown; kind?: unknown; parent_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const kind = body.kind === undefined ? "section" : body.kind;
  if (kind !== "section" && kind !== "folder") {
    return c.json({ error: "invalid_kind" }, 400);
  }
  const title =
    typeof body.title === "string" && body.title.trim() !== ""
      ? body.title.trim().slice(0, MAX_SECTION_TITLE)
      : kind === "folder"
        ? "Nouveau dossier"
        : "Nouvelle section";

  const existing = await listSections(c.env.DB, bible.id);

  let parentId: string | null = null;
  if (body.parent_id !== undefined && body.parent_id !== null) {
    if (typeof body.parent_id !== "string") {
      return c.json({ error: "invalid_parent" }, 400);
    }
    const err = checkParent(existing, body.parent_id, kind, 0);
    if (err) return c.json({ error: err }, 400);
    parentId = body.parent_id;
  }

  const nextOrder = existing.length
    ? Math.max(...existing.map((s) => s.sort_order)) + 1
    : 0;
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO bible_sections
       (id, bible_id, title, content_md, is_base, axis, sort_order, updated_at, parent_id, kind)
     VALUES (?, ?, ?, '', 0, NULL, ?, ?, ?, ?)`,
  )
    .bind(id, bible.id, title, nextOrder, now, parentId, kind)
    .run();
  await syncCanon(c, bible.id, bible.title);

  const row = await c.env.DB.prepare(
    `SELECT * FROM bible_sections WHERE id = ?`,
  )
    .bind(id)
    .first<SectionRow>();
  return c.json(toPublicSection(row!), 201);
});

// PUT /:id/sections/:sid — { title?, content_md?, parent_id? } (autosave,
// updates partiels ; parent_id déplace la section/le dossier dans l'arbre,
// null = retour à la racine).
bibleSections.put("/:id/sections/:sid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { title?: unknown; content_md?: unknown; parent_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sid = c.req.param("sid");
  const rows = await listSections(c.env.DB, bible.id);
  const target = rows.find((r) => r.id === sid);
  if (!target) return c.json({ error: "section_not_found" }, 404);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return c.json({ error: "invalid_title" }, 400);
    }
    sets.push("title = ?");
    values.push(body.title.trim().slice(0, MAX_SECTION_TITLE));
  }
  if (body.content_md !== undefined) {
    if (typeof body.content_md !== "string") {
      return c.json({ error: "invalid_content" }, 400);
    }
    if (body.content_md.length > MAX_IMPORT_BYTES) {
      return c.json({ error: "content_too_large" }, 413);
    }
    sets.push("content_md = ?");
    values.push(body.content_md);
  }
  if (body.parent_id !== undefined) {
    if (body.parent_id === null) {
      sets.push("parent_id = NULL");
    } else {
      if (typeof body.parent_id !== "string" || body.parent_id === sid) {
        return c.json({ error: "invalid_parent" }, 400);
      }
      // Pas de cycle : on ne déplace pas un dossier dans sa propre descendance.
      if (isDescendantOf(rows, sid, body.parent_id)) {
        return c.json({ error: "invalid_parent" }, 400);
      }
      const err = checkParent(
        rows,
        body.parent_id,
        target.kind,
        subtreeHeight(rows, sid),
      );
      if (err) return c.json({ error: err }, 400);
      sets.push("parent_id = ?");
      values.push(body.parent_id);
    }
  }
  if (sets.length === 0) return c.json({ error: "empty_patch" }, 400);

  await c.env.DB.prepare(
    `UPDATE bible_sections SET ${sets.join(", ")}, updated_at = ?
     WHERE id = ? AND bible_id = ?`,
  )
    .bind(...values, Date.now(), sid, bible.id)
    .run();
  await syncCanon(c, bible.id, bible.title);

  const row = await c.env.DB.prepare(
    `SELECT * FROM bible_sections WHERE id = ?`,
  )
    .bind(sid)
    .first<SectionRow>();
  return c.json(toPublicSection(row!));
});

// DELETE /:id/sections/:sid — retire une section ou un dossier (base
// comprise). Les enfants d'un dossier supprimé remontent d'un cran (rattachés
// à son parent) : la suppression d'un dossier ne perd jamais de contenu.
bibleSections.delete("/:id/sections/:sid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const sid = c.req.param("sid");
  const row = await c.env.DB.prepare(
    `SELECT * FROM bible_sections WHERE id = ? AND bible_id = ?`,
  )
    .bind(sid, bible.id)
    .first<SectionRow>();
  if (!row) return c.json({ error: "section_not_found" }, 404);

  const [, res] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE bible_sections SET parent_id = ?, updated_at = ?
         WHERE parent_id = ? AND bible_id = ?`,
      )
      .bind(row.parent_id, Date.now(), sid, bible.id),
    c.env.DB
      .prepare(`DELETE FROM bible_sections WHERE id = ? AND bible_id = ?`)
      .bind(sid, bible.id),
  ]);
  if (!res.meta.changes) return c.json({ error: "section_not_found" }, 404);
  await syncCanon(c, bible.id, bible.title);
  return c.json({ ok: true });
});

// PATCH /:id/sections/reorder — { order: [sid, …] } réordonne toutes les sections.
bibleSections.patch("/:id/sections/reorder", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { order?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const order = body.order;
  if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) {
    return c.json({ error: "invalid_order" }, 400);
  }

  const rows = await listSections(c.env.DB, bible.id);
  const ids = new Set(rows.map((r) => r.id));
  if (order.length !== rows.length || (order as string[]).some((id) => !ids.has(id))) {
    return c.json({ error: "order_mismatch" }, 400);
  }

  const now = Date.now();
  const stmt = c.env.DB.prepare(
    `UPDATE bible_sections SET sort_order = ?, updated_at = ? WHERE id = ? AND bible_id = ?`,
  );
  await c.env.DB.batch(
    (order as string[]).map((id, i) => stmt.bind(i, now, id, bible.id)),
  );
  await syncCanon(c, bible.id, bible.title);

  const updated = await listSections(c.env.DB, bible.id);
  return c.json({ sections: updated.map(toPublicSection) });
});
