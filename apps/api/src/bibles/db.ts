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

/**
 * Bible accessible en LECTURE et pour s'y créer un personnage : la sienne, ou
 * celle d'une table où l'on est assis (M8).
 *
 * Un joueur invité doit pouvoir incarner ou créer un personnage dans l'univers
 * de l'hôte — sans ça, le lobby est un cul-de-sac : on rejoint la partie et on
 * ne peut pas s'y asseoir. Il n'obtient RIEN de plus : ni l'édition du canon,
 * ni les propositions, ni la suppression, qui restent sur findOwnedBible.
 */
export async function findPlayableBible(
  db: D1Database,
  id: string,
  userId: string,
): Promise<BibleRow | null> {
  const owned = await findOwnedBible(db, id, userId);
  if (owned) return owned;

  return db
    .prepare(
      `SELECT b.* FROM bibles b
       JOIN game_sessions gs ON gs.bible_id = b.id
       JOIN session_members sm ON sm.session_id = gs.id AND sm.user_id = ?
       WHERE b.id = ? LIMIT 1`,
    )
    .bind(userId, id)
    .first<BibleRow>();
}
