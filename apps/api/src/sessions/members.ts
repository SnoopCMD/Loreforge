// Appartenance à une session de jeu (M8 lot 8.1) : qui a le droit d'y entrer,
// et à quel titre.
//
// C'est ce module qui remplace l'ancien `loadOwnedSession`. La distinction
// compte : `game_sessions.user_id` désigne l'AUTEUR — celui dont la bible est
// jouée, à qui reviennent les propositions de canon — tandis que
// `session_members` dit qui est à la table. Les deux coïncident en solo et
// divergent dès qu'un joueur est invité.

export const SESSION_ROLES = ["host", "player"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export const SESSION_MODES = ["solo", "table"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** Durée de vie d'un code d'invitation : le temps d'une soirée qu'on organise. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Un code sert à remplir une table, pas à ouvrir la partie au monde. */
export const INVITE_MAX_USES = 8;

/**
 * Alphabet des codes : ni 0/O ni 1/I/L, qui se confondent quand on dicte un
 * code à voix haute — c'est le cas d'usage principal.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/**
 * Code d'invitation tiré au sort côté serveur. Surtout pas un compteur
 * incrémental : un code devinable donne l'accès à une partie entière.
 * 31^8 ≈ 8,5e11 combinaisons, sans biais de modulo (les octets hors plage
 * sont rejetés plutôt que repliés).
 */
export function generateInviteCode(): string {
  const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= max) continue; // biais écarté
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** Normalise un code saisi par un humain (minuscules, espaces, tirets). */
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === CODE_LENGTH ? code : null;
}

export interface GameSessionRow {
  id: string;
  bible_id: string;
  user_id: string;
  character_id: string | null;
  format: string;
  trame: string | null;
  status: string;
  mode: string;
  summary_md: string | null;
  created_at: number;
  finished_at: number | null;
  palette_json: string | null;
}

/** Une session vue par un membre : la ligne, plus le titre auquel il y entre. */
export interface SessionAccess {
  row: GameSessionRow;
  role: SessionRole;
  /** Personnage incarné par ce membre (null tant qu'il n'a pas choisi). */
  characterId: string | null;
}

/**
 * Résout l'accès d'un utilisateur à une session. Renvoie null s'il n'en est
 * pas membre — l'appelant répond alors 404 et non 403 : l'existence même
 * d'une session ne regarde pas quelqu'un qui n'y joue pas.
 */
export async function loadSessionAccess(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<SessionAccess | null> {
  const row = await db
    .prepare(
      `SELECT gs.*, sm.role AS member_role, sm.character_id AS member_character_id
       FROM game_sessions gs
       JOIN session_members sm ON sm.session_id = gs.id AND sm.user_id = ?
       WHERE gs.id = ?`,
    )
    .bind(userId, sessionId)
    .first<
      GameSessionRow & { member_role: string; member_character_id: string | null }
    >();
  if (!row) return null;

  const { member_role, member_character_id, ...session } = row;
  return {
    row: session as GameSessionRow,
    role: member_role === "host" ? "host" : "player",
    characterId: member_character_id,
  };
}

export interface SessionMember {
  user_id: string;
  display_name: string | null;
  email: string;
  character_id: string | null;
  character_name: string | null;
  role: SessionRole;
  joined_at: number;
}

export async function listMembers(
  db: D1Database,
  sessionId: string,
): Promise<SessionMember[]> {
  const { results } = await db
    .prepare(
      `SELECT sm.user_id, u.display_name, u.email, sm.character_id,
              ch.name AS character_name, sm.role, sm.joined_at
       FROM session_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN characters ch ON ch.id = sm.character_id
       WHERE sm.session_id = ?
       ORDER BY sm.joined_at`,
    )
    .bind(sessionId)
    .all<SessionMember>();
  return results;
}
