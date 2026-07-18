import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Env } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";
import { computeRichness } from "./analyze";
import { computeGlobal, type RichnessGap, type RichnessResult } from "./logic";

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
          data: JSON.stringify({ error: "analysis_failed", status }),
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
    const result = await computeRichness(env.ANTHROPIC_API_KEY!, canonMd);
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
    gaps: JSON.parse(row.gaps_json) as RichnessGap[],
    computed_at: row.computed_at,
  });
});
