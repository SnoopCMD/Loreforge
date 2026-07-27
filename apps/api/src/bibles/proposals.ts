// Routes /api/bibles/:id/proposals — boucle canon (SPEC §5, M5).
// Les propositions sont créées par le DO au /finish ; ici on les liste
// et on tranche : accept = merge dans canon_md, reject = simple statut.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "./db";
import { reindexBible } from "../rag/store";
import { ensureSections } from "./classify";
import {
  appendCanonizedSection,
  appendToAxisSection,
  regenerateCanon,
} from "./sections";
import { suggestFromComment } from "../richness/suggest";

const STATUSES = ["pending", "accepted", "rejected"] as const;
const MAX_COMMENT_CHARS = 2000;
const MAX_PASSAGE_CHARS = 4000;

interface ProposalRow {
  id: string;
  session_id: string;
  bible_id: string;
  content_md: string;
  axis: string;
  status: string;
  source: string;
  source_comment: string | null;
  created_at: number;
}

/** Insère une proposition et la renvoie (fabrique partagée comment/feedback). */
async function insertProposal(
  db: D1Database,
  fields: {
    session_id: string;
    bible_id: string;
    content_md: string;
    axis: string;
    source: string;
    source_comment: string | null;
  },
): Promise<ProposalRow> {
  const row: ProposalRow = {
    id: crypto.randomUUID(),
    status: "pending",
    created_at: Date.now(),
    ...fields,
  };
  await db
    .prepare(
      `INSERT INTO canon_proposals
         (id, session_id, bible_id, content_md, axis, status, source, source_comment, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.session_id,
      row.bible_id,
      row.content_md,
      row.axis,
      row.source,
      row.source_comment,
      row.created_at,
    )
    .run();
  return row;
}

/** Vérifie qu'une session appartient bien à la bible (et existe). */
async function sessionOfBible(
  db: D1Database,
  sessionId: string,
  bibleId: string,
): Promise<boolean> {
  const s = await db
    .prepare(`SELECT id FROM game_sessions WHERE id = ? AND bible_id = ?`)
    .bind(sessionId, bibleId)
    .first();
  return !!s;
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

  let sql = `SELECT id, session_id, axis, content_md, status, source, source_comment, created_at
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

// POST /api/bibles/:id/proposals/from-comment — génère une proposition ciblée
// depuis un commentaire de l'auteur sur un passage précis du résumé.
proposals.post("/:id/proposals/from-comment", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "not_configured" }, 503);
  const bible = await findOwnedBible(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { session_id?: unknown; passage?: unknown; comment?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  const passage = typeof body.passage === "string" ? body.passage.slice(0, MAX_PASSAGE_CHARS) : "";
  if (!comment || comment.length > MAX_COMMENT_CHARS) {
    return c.json({ error: "invalid_comment" }, 400);
  }
  if (!sessionId || !(await sessionOfBible(c.env.DB, sessionId, bible.id))) {
    return c.json({ error: "session_not_found" }, 404);
  }

  const suggestion = await suggestFromComment(
    c.env.ANTHROPIC_API_KEY,
    bible.canon_md ?? "",
    passage,
    comment,
  );
  if (!suggestion.relevant) {
    // Retour noté mais sans conséquence de canon : rien à trancher.
    return c.json({ proposal: null, relevant: false });
  }
  const proposal = await insertProposal(c.env.DB, {
    session_id: sessionId,
    bible_id: bible.id,
    content_md: suggestion.content_md,
    axis: suggestion.axis,
    source: "comment",
    source_comment: comment,
  });
  return c.json({ proposal, relevant: true });
});

// POST /api/bibles/:id/proposals/from-feedback — retour général sur la session :
// noté comme contexte (game_sessions.author_feedback, relu par les prochaines
// sessions) ET, si pertinent, transformé en proposition de canon.
proposals.post("/:id/proposals/from-feedback", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "not_configured" }, 503);
  const bible = await findOwnedBible(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { session_id?: unknown; comment?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (!comment || comment.length > MAX_COMMENT_CHARS) {
    return c.json({ error: "invalid_comment" }, 400);
  }
  if (!sessionId || !(await sessionOfBible(c.env.DB, sessionId, bible.id))) {
    return c.json({ error: "session_not_found" }, 404);
  }

  // 1) On garde le retour comme contexte pour les prochaines sessions.
  await c.env.DB.prepare(
    `UPDATE game_sessions SET author_feedback = ? WHERE id = ? AND bible_id = ?`,
  )
    .bind(comment, sessionId, bible.id)
    .run();

  // 2) On tente une proposition de canon (sans passage : retour global).
  const suggestion = await suggestFromComment(
    c.env.ANTHROPIC_API_KEY,
    bible.canon_md ?? "",
    "",
    comment,
  );
  if (!suggestion.relevant) return c.json({ noted: true, proposal: null });
  const proposal = await insertProposal(c.env.DB, {
    session_id: sessionId,
    bible_id: bible.id,
    content_md: suggestion.content_md,
    axis: suggestion.axis,
    source: "comment",
    source_comment: comment,
  });
  return c.json({ noted: true, proposal });
});

// POST /api/bibles/:id/proposals/:pid — { action: 'accept' | 'reject',
// content_md? } — content_md permet d'éditer la proposition avant de la canoniser.
proposals.post("/:id/proposals/:pid", async (c) => {
  let body: { action?: unknown; content_md?: unknown };
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

  // Édition avant validation : le texte final l'emporte sur celui d'origine.
  if (
    body.action === "accept" &&
    typeof body.content_md === "string" &&
    body.content_md.trim() !== "" &&
    body.content_md !== row.content_md
  ) {
    row.content_md = body.content_md.trim();
    await c.env.DB.prepare(
      `UPDATE canon_proposals SET content_md = ? WHERE id = ?`,
    )
      .bind(row.content_md, row.id)
      .run();
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
  // l'ajout rejoint la section de base de son axe (Personnages, Géographie…)
  // — repli « Canonisé en session » si elle a été supprimée — et le canon est
  // régénéré.
  await ensureSections(c.env.DB, bible, { useAi: false });
  const routed = await appendToAxisSection(
    c.env.DB,
    bible.id,
    row.axis,
    row.content_md,
  );
  if (!routed) {
    await appendCanonizedSection(c.env.DB, bible.id, row.axis, row.content_md);
  }
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
