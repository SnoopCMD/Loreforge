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
import { classifyCanon, ensureSections } from "./classify";
import {
  insertSections,
  listSections,
  regenerateCanon,
  renderCanon,
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

// POST /:id/sections/redistribute — reclasse le canon courant et REMPLACE les
// sections. Le modèle ne renvoie qu'un PLAN (bloc → catégorie) ; le contenu est
// réassemblé localement, jamais réécrit ni ré-émis. Sortie minuscule → appel
// rapide (quelques secondes), sans risque de troncature ni d'éviction Workers.
bibleSections.post("/:id/sections/redistribute", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const classified = await classifyCanon(c.env.ANTHROPIC_API_KEY, bible.canon_md ?? "");
  await c.env.DB.prepare(`DELETE FROM bible_sections WHERE bible_id = ?`)
    .bind(bible.id)
    .run();
  await insertSections(c.env.DB, bible.id, classified);
  await syncCanon(c, bible.id, bible.title);
  const rows = await listSections(c.env.DB, bible.id);
  return c.json({ sections: rows.map(toPublicSection) });
});

// POST /:id/sections — ajoute une section personnalisée en fin de liste.
bibleSections.post("/:id/sections", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { title?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const title =
    typeof body.title === "string" && body.title.trim() !== ""
      ? body.title.trim().slice(0, MAX_SECTION_TITLE)
      : "Nouvelle section";

  const existing = await listSections(c.env.DB, bible.id);
  const nextOrder = existing.length
    ? Math.max(...existing.map((s) => s.sort_order)) + 1
    : 0;
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO bible_sections
       (id, bible_id, title, content_md, is_base, axis, sort_order, updated_at)
     VALUES (?, ?, ?, '', 0, NULL, ?, ?)`,
  )
    .bind(id, bible.id, title, nextOrder, now)
    .run();
  await syncCanon(c, bible.id, bible.title);

  const row = await c.env.DB.prepare(
    `SELECT * FROM bible_sections WHERE id = ?`,
  )
    .bind(id)
    .first<SectionRow>();
  return c.json(toPublicSection(row!), 201);
});

// PUT /:id/sections/:sid — { title?, content_md? } (autosave, updates partiels).
bibleSections.put("/:id/sections/:sid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { title?: unknown; content_md?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

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
  if (sets.length === 0) return c.json({ error: "empty_patch" }, 400);

  const sid = c.req.param("sid");
  const res = await c.env.DB.prepare(
    `UPDATE bible_sections SET ${sets.join(", ")}, updated_at = ?
     WHERE id = ? AND bible_id = ?`,
  )
    .bind(...values, Date.now(), sid, bible.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "section_not_found" }, 404);
  await syncCanon(c, bible.id, bible.title);

  const row = await c.env.DB.prepare(
    `SELECT * FROM bible_sections WHERE id = ?`,
  )
    .bind(sid)
    .first<SectionRow>();
  return c.json(toPublicSection(row!));
});

// DELETE /:id/sections/:sid — retire une section (base comprise).
bibleSections.delete("/:id/sections/:sid", async (c) => {
  const bible = await owned(c);
  if (!bible) return c.json({ error: "not_found" }, 404);

  const res = await c.env.DB.prepare(
    `DELETE FROM bible_sections WHERE id = ? AND bible_id = ?`,
  )
    .bind(c.req.param("sid"), bible.id)
    .run();
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
