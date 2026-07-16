// Accès D1 aux bibles, partagé entre les routes bibles et richness.

export interface BibleRow {
  id: string;
  user_id: string;
  title: string;
  source_type: string;
  r2_key: string | null;
  canon_md: string | null;
  tone_profile: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export async function findOwnedBible(
  db: D1Database,
  id: string,
  userId: string,
): Promise<BibleRow | null> {
  return db
    .prepare(`SELECT * FROM bibles WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<BibleRow>();
}
