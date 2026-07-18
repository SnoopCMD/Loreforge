import type { SheetSchema } from "./schema";

export interface SheetSchemaRow {
  id: string;
  bible_id: string;
  version: number;
  schema_json: string;
  created_at: number;
}

/** Dernier schéma de fiche de la bible (versionné à chaque analyse). */
export async function latestSheetSchema(
  db: D1Database,
  bibleId: string,
): Promise<{ version: number; schema: SheetSchema } | null> {
  const row = await db
    .prepare(
      `SELECT * FROM sheet_schemas WHERE bible_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(bibleId)
    .first<SheetSchemaRow>();
  if (!row) return null;
  return {
    version: row.version,
    schema: JSON.parse(row.schema_json) as SheetSchema,
  };
}
