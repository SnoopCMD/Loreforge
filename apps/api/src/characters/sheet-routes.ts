// Routes bible-scopées du flux personnage (SPEC §6bis, montées sur
// /api/bibles) : schéma de fiche dérivé de l'analyse, personnages canon
// jouables extraits de la bible.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findPlayableBible } from "../bibles/db";
import { latestSheetSchema } from "./db";

export const sheetRoutes = new Hono<AppEnv>();

sheetRoutes.use("*", requireAuth);

// GET /api/bibles/:id/sheet-schema — dernier schéma généré à l'analyse.
//
// Playable et non « owned » : sans ça, la forge s'ouvre vide pour un invité —
// il n'a pas le formulaire de fiche de l'univers dans lequel il joue.
sheetRoutes.get("/:id/sheet-schema", async (c) => {
  const bible = await findPlayableBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!bible) return c.json({ error: "not_found" }, 404);

  const latest = await latestSheetSchema(c.env.DB, bible.id);
  if (!latest) return c.json({ status: "none" });
  return c.json({ status: "ready", version: latest.version, schema: latest.schema });
});

// GET /api/bibles/:id/playable — personnages canon incarnables.
sheetRoutes.get("/:id/playable", async (c) => {
  const bible = await findPlayableBible(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!bible) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, sheet_json, created_at FROM characters
     WHERE bible_id = ? AND is_canon = 1 ORDER BY created_at ASC`,
  )
    .bind(bible.id)
    .all<{ id: string; name: string; sheet_json: string; created_at: number }>();

  return c.json({
    characters: results.map((row) => ({
      id: row.id,
      name: row.name,
      sheet: JSON.parse(row.sheet_json) as unknown,
      is_canon: true,
      origin: "canon",
      created_at: row.created_at,
    })),
  });
});
