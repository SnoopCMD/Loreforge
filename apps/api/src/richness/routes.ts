import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Env } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";
import { ensureSections } from "../bibles/classify";
import { listSections, regenerateCanon } from "../bibles/sections";
import { loadMoodboardAnnex } from "../bibles/moodboard-context";
import { reindexBible } from "../rag/store";
import { appendEdit, fillGap, selectGapCandidates } from "./gap-fill";
import { validateEdits } from "../bibles/weave";
import { computeRichness } from "./analyze";
import { computeGlobal, type Axis, type RichnessResult } from "./logic";

// Monté sur /api/bibles, en parallèle du routeur d'import (SPEC §5) :
// POST /api/bibles/:id/analyze et GET /api/bibles/:id/richness.
export const richness = new Hono<AppEnv>();

richness.use("*", requireAuth);

// Au-delà de ce délai, une bible restée en 'analyzing' est considérée
// morte (isolate évincé : le catch de runAnalysis n'a jamais tourné).
const ANALYSIS_STALE_MS = 10 * 60 * 1000;

async function recoverStaleAnalysis(
  db: D1Database,
  bibleId: string,
): Promise<"analyzed" | "draft"> {
  const scored = await db
    .prepare(`SELECT bible_id FROM richness_scores WHERE bible_id = ?`)
    .bind(bibleId)
    .first();
  const status = scored ? "analyzed" : "draft";
  await db
    .prepare(
      `UPDATE bibles SET status = ?, updated_at = ? WHERE id = ? AND status = 'analyzing'`,
    )
    .bind(status, Date.now(), bibleId)
    .run();
  return status;
}

interface RichnessRow {
  bible_id: string;
  cosmology: number;
  characters: number;
  plots: number;
  tone: number;
  geography: number;
  global: number;
  gaps_json: string;
  computed_at: number;
}

// Lacune actionnable : la version stockée gagne un id stable (cache + marquage)
// et un drapeau « résolu ». Les anciennes analyses n'ont que {axis, description}.
interface StoredGap {
  id: string;
  axis: Axis;
  description: string;
  resolved: boolean;
}

/** Normalise gaps_json en lacunes id-ées (id déterministe si absent). */
function normalizeGaps(raw: unknown): StoredGap[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((g, i) => {
    const axis = (g?.axis as Axis) ?? "plots";
    return {
      id: typeof g?.id === "string" && g.id ? g.id : `${axis}-${i}`,
      axis,
      description: typeof g?.description === "string" ? g.description : "",
      resolved: g?.resolved === true,
    };
  });
}


// POST /api/bibles/:id/analyze — lance le calcul en tâche de fond (202, poll).
richness.post("/:id/analyze", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "analyzer_not_configured" }, 503);
  }

  const bible = await findOwnedBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!bible) return c.json({ error: "not_found" }, 404);
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);
  if (bible.status === "analyzing") {
    if (Date.now() - bible.updated_at < ANALYSIS_STALE_MS) {
      return c.json({ error: "analysis_in_progress" }, 409);
    }
    // Analyse zombie : on la déclare morte et on relance.
    await recoverStaleAnalysis(c.env.DB, bible.id);
  }

  await c.env.DB.prepare(
    `UPDATE bibles SET status = 'analyzing', updated_at = ? WHERE id = ?`,
  )
    .bind(Date.now(), bible.id)
    .run();

  const canonMd = bible.canon_md;
  const userId = c.get("user").id;

  // Mode SSE (le front) : l'analyse tourne DANS la requête, tenue ouverte
  // par le client — le waitUntil d'un Worker se fait évincer sans bruit sur
  // les longues analyses (constaté en prod), pas une requête active.
  if ((c.req.header("accept") ?? "").includes("text/event-stream")) {
    return streamSSE(c, async (stream) => {
      let lastTick = 0;
      try {
        const result = await computeRichness(
          c.env.ANTHROPIC_API_KEY!,
          canonMd,
          await loadMoodboardAnnex(c.env.DB, bible.id),
          (p) => {
            const now = Date.now();
            if (now - lastTick < 2000) return;
            lastTick = now;
            void stream.writeSSE({
              event: "progress",
              data: JSON.stringify(p),
            });
          },
        );
        await persistAnalysis(c.env, bible.id, userId, result);
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ status: "analyzed" }),
        });
      } catch (err) {
        console.error(`[richness] analyse SSE échouée pour ${bible.id}:`, err);
        const status = await markAnalysisFailed(c.env.DB, bible.id);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: "analysis_failed",
            status,
            // La cause exacte (troncature, refus, 4xx Anthropic) est sinon
            // invisible sans wrangler tail.
            detail: err instanceof Error ? err.message : String(err),
          }),
        });
      }
    });
  }

  // Mode JSON (tests, API brute) : tâche de fond + poll GET /richness.
  c.executionCtx.waitUntil(runAnalysis(c.env, bible.id, userId, canonMd));
  return c.json({ ok: true, status: "analyzing" }, 202);
});

async function runAnalysis(
  env: Env,
  bibleId: string,
  userId: string,
  canonMd: string,
): Promise<void> {
  try {
    const result = await computeRichness(
      env.ANTHROPIC_API_KEY!,
      canonMd,
      await loadMoodboardAnnex(env.DB, bibleId),
    );
    await persistAnalysis(env, bibleId, userId, result);
  } catch (err) {
    console.error(`[richness] analyse échouée pour ${bibleId}:`, err);
    await markAnalysisFailed(env.DB, bibleId);
  }
}

/** Écrit scores, schéma de fiche et personnages canon, puis statut analyzed. */
async function persistAnalysis(
  env: Env,
  bibleId: string,
  userId: string,
  result: RichnessResult,
): Promise<void> {
  const s = result.scores;
  await env.DB.prepare(
    `INSERT INTO richness_scores
       (bible_id, cosmology, characters, plots, tone, geography, global, gaps_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bible_id) DO UPDATE SET
       cosmology = excluded.cosmology,
       characters = excluded.characters,
       plots = excluded.plots,
       tone = excluded.tone,
       geography = excluded.geography,
       global = excluded.global,
       gaps_json = excluded.gaps_json,
       computed_at = excluded.computed_at`,
  )
    .bind(
      bibleId,
      s.cosmology,
      s.characters,
      s.plots,
      s.tone,
      s.geography,
      computeGlobal(s),
      JSON.stringify(result.gaps),
      Date.now(),
    )
    .run();
  // §6bis — schéma de fiche versionné + personnages canon jouables.
  if (result.sheetSchema) {
    const prev = await env.DB.prepare(
      `SELECT MAX(version) AS v FROM sheet_schemas WHERE bible_id = ?`,
    )
      .bind(bibleId)
      .first<{ v: number | null }>();
    await env.DB.prepare(
      `INSERT INTO sheet_schemas (id, bible_id, version, schema_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        bibleId,
        (prev?.v ?? 0) + 1,
        JSON.stringify(result.sheetSchema),
        Date.now(),
      )
      .run();
  }
  const schemaJson = result.sheetSchema
    ? JSON.stringify(result.sheetSchema)
    : null;
  for (const pc of result.playable) {
    // Ré-analyse : on met à jour la fiche d'un canon existant (même nom)
    // plutôt que de dupliquer — il peut être référencé par des sessions.
    const existing = await env.DB.prepare(
      `SELECT id FROM characters WHERE bible_id = ? AND name = ? AND is_canon = 1`,
    )
      .bind(bibleId, pc.name)
      .first<{ id: string }>();
    if (existing) {
      await env.DB.prepare(
        `UPDATE characters SET sheet_json = ?, sheet_schema_json = ? WHERE id = ?`,
      )
        .bind(JSON.stringify(pc.sheet), schemaJson, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO characters
           (id, bible_id, user_id, name, sheet_json, sheet_schema_json, origin, is_canon, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'canon', 1, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          bibleId,
          userId,
          pc.name,
          JSON.stringify(pc.sheet),
          schemaJson,
          Date.now(),
        )
        .run();
    }
  }
  await env.DB.prepare(
    `UPDATE bibles SET status = 'analyzed', updated_at = ? WHERE id = ?`,
  )
    .bind(Date.now(), bibleId)
    .run();
}

/** Retour à l'état antérieur : 'analyzed' si un score existait déjà. */
async function markAnalysisFailed(
  db: D1Database,
  bibleId: string,
): Promise<"analyzed" | "draft"> {
  const existing = await db
    .prepare(`SELECT bible_id FROM richness_scores WHERE bible_id = ?`)
    .bind(bibleId)
    .first();
  const status = existing ? "analyzed" : "draft";
  await db
    .prepare(
      `UPDATE bibles SET status = ?, updated_at = ? WHERE id = ? AND status = 'analyzing'`,
    )
    .bind(status, Date.now(), bibleId)
    .run();
  return status;
}

// GET /api/bibles/:id/richness — état + scores (endpoint de poll).
richness.get("/:id/richness", async (c) => {
  const bible = await findOwnedBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!bible) return c.json({ error: "not_found" }, 404);

  if (bible.status === "analyzing") {
    if (Date.now() - bible.updated_at < ANALYSIS_STALE_MS) {
      return c.json({ status: "analyzing" });
    }
    const status = await recoverStaleAnalysis(c.env.DB, bible.id);
    if (status === "draft") return c.json({ status: "failed" });
    // 'analyzed' : on retombe sur la lecture des scores ci-dessous.
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM richness_scores WHERE bible_id = ?`,
  )
    .bind(bible.id)
    .first<RichnessRow>();
  if (!row) return c.json({ status: "none" });

  return c.json({
    status: "analyzed",
    scores: {
      cosmology: row.cosmology,
      characters: row.characters,
      plots: row.plots,
      tone: row.tone,
      geography: row.geography,
    },
    global: row.global,
    gaps: normalizeGaps(JSON.parse(row.gaps_json)),
    computed_at: row.computed_at,
  });
});

// PATCH /api/bibles/:id/gaps/:gapId — { resolved: boolean } marque la lacune
// comme comblée (persistée dans gaps_json ; réinitialisée à la ré-analyse).
richness.patch("/:id/gaps/:gapId", async (c) => {
  const bible = await findOwnedBible(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!bible) return c.json({ error: "not_found" }, 404);

  let body: { resolved?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.resolved !== "boolean") {
    return c.json({ error: "invalid_resolved" }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT gaps_json FROM richness_scores WHERE bible_id = ?`,
  )
    .bind(bible.id)
    .first<{ gaps_json: string }>();
  if (!row) return c.json({ error: "not_analyzed" }, 404);

  const gapId = c.req.param("gapId");
  const gaps = normalizeGaps(JSON.parse(row.gaps_json));
  const gap = gaps.find((g) => g.id === gapId);
  if (!gap) return c.json({ error: "gap_not_found" }, 404);
  gap.resolved = body.resolved;

  await c.env.DB.prepare(
    `UPDATE richness_scores SET gaps_json = ? WHERE bible_id = ?`,
  )
    .bind(JSON.stringify(gaps), bible.id)
    .run();
  return c.json({ gap });
});

// ── Comblement d'une zone floue ───────────────────────────────────────────
//
// Deux temps, comme l'atelier d'écriture : /fill propose la réécriture des
// sections concernées (rien n'est écrit), /apply enregistre ce que l'auteur a
// relu, régénère le canon et marque la lacune comblée.

/** Au-delà, la réponse n'est plus une réponse : c'est une section entière. */
const MAX_GAP_ANSWER_CHARS = 8_000;

/** Charge la bible possédée, ses sections et la lacune visée. */
async function loadGapContext(c: Context<AppEnv>) {
  const bible = await findOwnedBible(
    c.env.DB,
    c.req.param("id") ?? "",
    c.get("user").id,
  );
  if (!bible) return { error: c.json({ error: "not_found" }, 404) } as const;

  const row = await c.env.DB.prepare(
    `SELECT gaps_json FROM richness_scores WHERE bible_id = ?`,
  )
    .bind(bible.id)
    .first<{ gaps_json: string }>();
  if (!row) return { error: c.json({ error: "not_analyzed" }, 404) } as const;

  const gaps = normalizeGaps(JSON.parse(row.gaps_json));
  const gap = gaps.find((g) => g.id === c.req.param("gapId"));
  if (!gap) return { error: c.json({ error: "gap_not_found" }, 404) } as const;
  return { bible, gaps, gap } as const;
}

// POST /api/bibles/:id/gaps/:gapId/fill — { answer } → réécriture proposée.
richness.post("/:id/gaps/:gapId/fill", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "not_configured" }, 503);
  const ctx = await loadGapContext(c);
  if ("error" in ctx) return ctx.error;

  let body: { answer?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (answer === "" || answer.length > MAX_GAP_ANSWER_CHARS) {
    return c.json({ error: "invalid_answer" }, 400);
  }

  await ensureSections(c.env.DB, ctx.bible, { useAi: false });
  const sections = await listSections(c.env.DB, ctx.bible.id);
  const candidates = selectGapCandidates(sections, ctx.gap.axis);
  if (candidates.length === 0) return c.json({ error: "no_section" }, 409);

  try {
    const fill = await fillGap(
      c.env.ANTHROPIC_API_KEY,
      ctx.bible.title,
      ctx.gap,
      answer,
      sections,
    );
    return c.json(fill);
  } catch (err) {
    // Repli : plutôt que de perdre la réponse, on la propose en ajout de fin
    // de section — l'auteur voit le mode « append » et peut la retravailler.
    console.error(`[gap] réécriture ${ctx.gap.id} :`, err);
    const target =
      candidates.find((s) => s.axis === ctx.gap.axis) ?? candidates[0];
    return c.json({
      summary:
        "Réécriture indisponible — la réponse est proposée en fin de section, à relire.",
      degraded: true,
      edits: [appendEdit(target, answer)],
    });
  }
});

// POST /api/bibles/:id/gaps/:gapId/apply — { edits: [{ section_id, content_md }] }
// Le corps relu par l'auteur REMPLACE celui de la section (c'est une
// réécriture, pas un ajout), le canon est régénéré puis réindexé, et la
// lacune passe à comblée.
richness.post("/:id/gaps/:gapId/apply", async (c) => {
  const ctx = await loadGapContext(c);
  if ("error" in ctx) return ctx.error;

  let body: { edits?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const rows = await listSections(c.env.DB, ctx.bible.id);
  const checked = validateEdits(rows, body.edits);
  if ("error" in checked) return c.json({ error: checked.error }, 400);
  const updates = checked.updates;

  const now = Date.now();
  await c.env.DB.batch([
    ...[...updates].map(([id, content]) =>
      c.env.DB.prepare(
        `UPDATE bible_sections SET content_md = ?, updated_at = ? WHERE id = ?`,
      ).bind(content, now, id),
    ),
  ]);

  const canon = await regenerateCanon(c.env.DB, ctx.bible.id, ctx.bible.title);
  ctx.gap.resolved = true;
  await c.env.DB.prepare(
    `UPDATE richness_scores SET gaps_json = ? WHERE bible_id = ?`,
  )
    .bind(JSON.stringify(ctx.gaps), ctx.bible.id)
    .run();
  c.executionCtx.waitUntil(reindexBible(c.env, ctx.bible.id, canon));

  return c.json({
    ok: true,
    applied: updates.size,
    gap: ctx.gap,
    sections: [...updates.keys()],
  });
});
