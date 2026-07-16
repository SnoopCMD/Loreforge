import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";
import { computeRichness } from "./analyze";
import { computeGlobal, type RichnessGap } from "./logic";

// Monté sur /api/bibles, en parallèle du routeur d'import (SPEC §5) :
// POST /api/bibles/:id/analyze et GET /api/bibles/:id/richness.
export const richness = new Hono<AppEnv>();

richness.use("*", requireAuth);

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
    return c.json({ error: "analysis_in_progress" }, 409);
  }

  await c.env.DB.prepare(
    `UPDATE bibles SET status = 'analyzing', updated_at = ? WHERE id = ?`,
  )
    .bind(Date.now(), bible.id)
    .run();

  // L'appel Anthropic continue après la réponse HTTP ; le client poll
  // GET /api/bibles/:id/richness.
  c.executionCtx.waitUntil(runAnalysis(c.env, bible.id, bible.canon_md));

  return c.json({ ok: true, status: "analyzing" }, 202);
});

async function runAnalysis(
  env: Env,
  bibleId: string,
  canonMd: string,
): Promise<void> {
  try {
    const result = await computeRichness(env.ANTHROPIC_API_KEY!, canonMd);
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
    await env.DB.prepare(
      `UPDATE bibles SET status = 'analyzed', updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), bibleId)
      .run();
  } catch (err) {
    console.error(`[richness] analyse échouée pour ${bibleId}:`, err);
    // Retour à l'état antérieur : 'analyzed' si un score existait déjà.
    const existing = await env.DB.prepare(
      `SELECT bible_id FROM richness_scores WHERE bible_id = ?`,
    )
      .bind(bibleId)
      .first();
    await env.DB.prepare(
      `UPDATE bibles SET status = ?, updated_at = ? WHERE id = ? AND status = 'analyzing'`,
    )
      .bind(existing ? "analyzed" : "draft", Date.now(), bibleId)
      .run();
  }
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
    return c.json({ status: "analyzing" });
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
