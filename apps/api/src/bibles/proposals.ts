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
  listSections,
  regenerateCanon,
} from "./sections";
import { weaveCanonized } from "./canonize";
import { appendEdit, selectWeaveCandidates, validateEdits } from "./weave";
import type { Context } from "hono";
import { suggestFromComment } from "../richness/suggest";
import type { Env } from "../env";
import type { BibleRow } from "./db";

const STATUSES = ["pending", "accepted", "rejected"] as const;

/**
 * Tisse un élément canonisé dans les sections qu'il touche et écrit le
 * résultat. Renvoie null si le tissage n'a pas abouti (modèle indisponible,
 * sortie inexploitable, aucune section candidate) — l'appelant se replie alors
 * sur l'ajout en fin de section. Le canon est régénéré par l'appelant.
 */
async function weaveIntoSections(
  env: Env,
  bible: BibleRow,
  axis: string,
  contentMd: string,
): Promise<{ summary: string; sections: string[] } | null> {
  try {
    const sections = await listSections(env.DB, bible.id);
    const woven = await weaveCanonized(
      env.ANTHROPIC_API_KEY!,
      bible.title,
      axis,
      contentMd,
      sections,
    );
    const now = Date.now();
    await env.DB.batch(
      woven.edits.map((e) =>
        env.DB.prepare(
          `UPDATE bible_sections SET content_md = ?, updated_at = ? WHERE id = ?`,
        ).bind(e.content_md, now, e.section_id),
      ),
    );
    return {
      summary: woven.summary,
      sections: woven.edits.map((e) => e.title),
    };
  } catch (err) {
    console.error(`[canon] tissage de l'élément canonisé (${axis}) :`, err);
    return null;
  }
}
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

/** Proposition possédée et encore en attente, sinon la réponse d'erreur. */
async function pendingProposal(c: Context<AppEnv>) {
  const bible = await findOwnedBible(
    c.env.DB,
    c.req.param("id") ?? "",
    c.get("user").id,
  );
  if (!bible) return { error: c.json({ error: "not_found" }, 404) } as const;
  const row = await c.env.DB.prepare(
    `SELECT * FROM canon_proposals WHERE id = ? AND bible_id = ?`,
  )
    .bind(c.req.param("pid"), bible.id)
    .first<ProposalRow>();
  if (!row) return { error: c.json({ error: "not_found" }, 404) } as const;
  if (row.status !== "pending") {
    return {
      error: c.json({ error: "already_decided", status: row.status }, 409),
    } as const;
  }
  return { bible, row } as const;
}

// POST /api/bibles/:id/proposals/:pid/weave — { content_md? } → la réécriture
// des sections concernées, telle que l'auteur va la relire. RIEN n'est écrit :
// il tranche, puis rappelle /:pid avec { action: 'accept', edits }.
proposals.post("/:id/proposals/:pid/weave", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "not_configured" }, 503);
  const ctx = await pendingProposal(c);
  if ("error" in ctx) return ctx.error;

  let body: { content_md?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    /* corps facultatif : la proposition telle quelle */
  }
  // Édition avant relecture : c'est le texte de l'auteur qui part au tissage.
  const edited =
    typeof body.content_md === "string" && body.content_md.trim() !== ""
      ? body.content_md.trim()
      : ctx.row.content_md;

  await ensureSections(c.env.DB, ctx.bible, { useAi: false });
  const sections = await listSections(c.env.DB, ctx.bible.id);
  const candidates = selectWeaveCandidates(sections, ctx.row.axis);
  if (candidates.length === 0) return c.json({ error: "no_section" }, 409);

  try {
    const woven = await weaveCanonized(
      c.env.ANTHROPIC_API_KEY,
      ctx.bible.title,
      ctx.row.axis,
      edited,
      sections,
    );
    return c.json(woven);
  } catch (err) {
    // Repli : plutôt que de bloquer la canonisation, on propose l'ancien
    // chemin — ajout marqué en fin de section — que l'auteur peut retravailler.
    console.error(`[canon] réécriture ${ctx.row.id} :`, err);
    const target =
      candidates.find((s) => s.axis === ctx.row.axis) ?? candidates[0];
    return c.json({
      summary:
        "Réécriture indisponible — l'élément est proposé en fin de section, à relire.",
      degraded: true,
      edits: [appendEdit(target, `**Canonisé en session :** ${edited}`)],
    });
  }
});

// POST /api/bibles/:id/proposals/:pid — { action: 'accept' | 'reject',
// content_md? } — content_md permet d'éditer la proposition avant de la canoniser.
proposals.post("/:id/proposals/:pid", async (c) => {
  let body: { action?: unknown; content_md?: unknown; edits?: unknown };
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
  // l'élément est TISSÉ dans les sections qu'il touche : il complète le texte
  // en place et tranche les notes ouvertes qu'il vient combler, au lieu d'être
  // recopié en fin de section. Repli sur l'ancien ajout (section de l'axe, ou
  // « Canonisé en session » si elle a été supprimée) quand le modèle est
  // indisponible — une acceptation ne perd jamais son texte.
  await ensureSections(c.env.DB, bible, { useAi: false });
  // Chemin normal (interface) : l'auteur a relu la réécriture proposée par
  // /weave, et ce sont SES corps qui sont écrits. Sans `edits` (appel direct
  // de l'API), on tisse ici même — puis, si ça échoue, l'ancien ajout.
  let woven: { summary: string; sections: string[] } | null = null;
  if (body.edits !== undefined) {
    const rows = await listSections(c.env.DB, bible.id);
    const checked = validateEdits(rows, body.edits);
    if ("error" in checked) return c.json({ error: checked.error }, 400);
    const now = Date.now();
    await c.env.DB.batch(
      [...checked.updates].map(([id, content]) =>
        c.env.DB.prepare(
          `UPDATE bible_sections SET content_md = ?, updated_at = ? WHERE id = ?`,
        ).bind(content, now, id),
      ),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    woven = {
      summary: "",
      sections: [...checked.updates.keys()].map(
        (id) => byId.get(id)?.title ?? "",
      ),
    };
  } else if (c.env.ANTHROPIC_API_KEY) {
    woven = await weaveIntoSections(c.env, bible, row.axis, row.content_md);
  }
  if (!woven) {
    const routed = await appendToAxisSection(
      c.env.DB,
      bible.id,
      row.axis,
      row.content_md,
    );
    if (!routed) {
      await appendCanonizedSection(c.env.DB, bible.id, row.axis, row.content_md);
    }
  }
  const merged = await regenerateCanon(c.env.DB, bible.id, bible.title);
  await c.env.DB.prepare(
    `UPDATE canon_proposals SET status = 'accepted' WHERE id = ?`,
  )
    .bind(row.id)
    .run();

  // Réponse à une zone floue canonisée : la lacune est résolue — retirée de
  // gaps_json, elle ne génère plus ni question de mise en place ni consigne
  // d'invention dans le prompt du MJ. (Un reject la laisse : la question
  // reviendra à la prochaine session.)
  if (row.source === "gap" && row.source_comment) {
    const rs = await c.env.DB.prepare(
      `SELECT gaps_json FROM richness_scores WHERE bible_id = ?`,
    )
      .bind(bible.id)
      .first<{ gaps_json: string }>();
    if (rs) {
      try {
        const gaps = JSON.parse(rs.gaps_json) as Array<{
          axis: string;
          description: string;
        }>;
        // Clé de résolution : la description seule — l'axe de la proposition
        // a pu être réajusté à la reformulation.
        const kept = gaps.filter((g) => g.description !== row.source_comment);
        if (kept.length !== gaps.length) {
          await c.env.DB.prepare(
            `UPDATE richness_scores SET gaps_json = ? WHERE bible_id = ?`,
          )
            .bind(JSON.stringify(kept), bible.id)
            .run();
        }
      } catch {
        // gaps_json illisible : on n'y touche pas, la canonisation reste faite.
      }
    }
  }
  // Réindex Vectorize (M6) en tâche de fond — no-op sous le seuil RAG.
  c.executionCtx.waitUntil(reindexBible(c.env, bible.id, merged));
  return c.json({
    proposal: { ...row, status: "accepted" },
    canon_md: merged,
    // De quoi dire à l'auteur OÙ son élément a atterri, et s'il a été fondu
    // dans le texte ou seulement ajouté en fin de section.
    woven: woven
      ? { summary: woven.summary, sections: woven.sections }
      : null,
  });
});
