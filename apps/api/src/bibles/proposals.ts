// Routes /api/bibles/:id/proposals — boucle canon (SPEC §5, M5).
// Les propositions sont créées par le DO au /finish ; ici on les liste
// et on tranche : accept = merge dans canon_md, reject = simple statut.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "./db";
import { reindexBible } from "../rag/store";
import { ensureSections } from "./classify";
import { appendCanonizedSection, regenerateCanon } from "./sections";

const STATUSES = ["pending", "accepted", "rejected"] as const;

interface ProposalRow {
  id: string;
  session_id: string;
  bible_id: string;
  content_md: string;
  axis: string;
  status: string;
  created_at: number;
}

export const proposals = new Hono<AppEnv>();

proposals.use("*", requireAuth);

// GET /api/bibles/:id/proposals?status=&session_id=
proposals.get("/:id/proposals", async (c) => {
  const bible = await findOwnedBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!bible) return c.json({ error: "not_found" }, 404);

  const status = c.req.query("status");
  if (
    status !== undefined &&
    !(STATUSES as readonly string[]).includes(status)
  ) {
    return c.json({ error: "invalid_status" }, 400);
  }
  const sessionId = c.req.query("session_id");

  let sql = `SELECT id, session_id, axis, content_md, status, created_at
             FROM canon_proposals WHERE bible_id = ?`;
  const binds: unknown[] = [bible.id];
  if (status) {
    sql += ` AND status = ?`;
    binds.push(status);
  }
  if (sessionId) {
    sql += ` AND session_id = ?`;
    binds.push(sessionId);
  }
  sql += ` ORDER BY created_at ASC, rowid ASC`;

  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return c.json({ proposals: results });
});

// POST /api/bibles/:id/proposals/:pid — { action: 'accept' | 'reject' }
proposals.post("/:id/proposals/:pid", async (c) => {
  let body: { action?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (body.action !== "accept" && body.action !== "reject") {
    return c.json({ error: "invalid_action" }, 400);
  }

  const bible = await findOwnedBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!bible) return c.json({ error: "not_found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT * FROM canon_proposals WHERE id = ? AND bible_id = ?`,
  )
    .bind(c.req.param("pid"), bible.id)
    .first<ProposalRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "pending") {
    return c.json({ error: "already_decided", status: row.status }, 409);
  }

  if (body.action === "reject") {
    await c.env.DB.prepare(
      `UPDATE canon_proposals SET status = 'rejected' WHERE id = ?`,
    )
      .bind(row.id)
      .run();
    return c.json({ proposal: { ...row, status: "rejected" } });
  }

  // Canonisation via les sections (invariant : canon_md est dérivé). Les
  // sections sont initialisées si besoin (heuristique, sans appel IA), puis
  // l'ajout rejoint la section « Canonisé en session » et le canon est régénéré.
  await ensureSections(c.env.DB, bible, { useAi: false });
  await appendCanonizedSection(c.env.DB, bible.id, row.axis, row.content_md);
  const merged = await regenerateCanon(c.env.DB, bible.id, bible.title);
  await c.env.DB.prepare(
    `UPDATE canon_proposals SET status = 'accepted' WHERE id = ?`,
  )
    .bind(row.id)
    .run();
  // Réindex Vectorize (M6) en tâche de fond — no-op sous le seuil RAG.
  c.executionCtx.waitUntil(reindexBible(c.env, bible.id, merged));
  return c.json({ proposal: { ...row, status: "accepted" }, canon_md: merged });
});
