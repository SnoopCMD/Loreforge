// Moteur « Souffle » : logique pure (SPEC §6), sans dépendance runtime —
// testable unitairement (DoD M3).
//
// - Action risquée → 1d6 côté serveur : 1-2 échec avec complication,
//   3-4 réussite avec coût, 5-6 réussite franche.
// - 3 points de Souffle par session, bornés [0, 3].
// - Le d6 n'est JAMAIS lancé par le modèle : il demande un jet via
//   <roll reason="..."/>, le DO le résout et injecte le résultat au tour
//   suivant.

export const SOUFFLE_MAX = 3;

export type RollOutcome =
  | "failure_complication"
  | "success_cost"
  | "clean_success";

export interface RollResult {
  value: number; // 1-6
  outcome: RollOutcome;
  reason: string;
}

export function outcomeForRoll(value: number): RollOutcome {
  if (value <= 2) return "failure_complication";
  if (value <= 4) return "success_cost";
  return "clean_success";
}

/** Libellé français injecté dans le prompt du tour suivant. */
export function describeOutcome(outcome: RollOutcome): string {
  switch (outcome) {
    case "failure_complication":
      return "échec avec complication";
    case "success_cost":
      return "réussite avec coût";
    case "clean_success":
      return "réussite franche";
  }
}

/** d6 serveur (anti-triche). Le biais modulo sur 2^32 est négligeable. */
export function rollD6(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 6) + 1;
}

/** Souffle borné [0, SOUFFLE_MAX] ; les deltas non entiers sont arrondis. */
export function applySouffleDelta(current: number, delta: number): number {
  return Math.min(SOUFFLE_MAX, Math.max(0, Math.round(current + delta)));
}

// ── Compétences évolutives ────────────────────────────────────────────────
//
// Le MJ enregistre les acquis du personnage via <skill/> ; la liste vit dans
// GameState et est réinjectée à chaque tour (mémoire longue, indépendante de
// la fenêtre d'historique). 4 paliers, du plus fragile au plus assimilé.

export const SKILL_TIERS = [
  "découverte",
  "apprentissage",
  "maîtrise",
  "inné",
] as const;
export type SkillTier = (typeof SKILL_TIERS)[number];

export interface SkillEntry {
  name: string;
  tier: SkillTier;
  /** Précision courte du MJ (portée, limite, coût...). */
  note?: string;
}

export const MAX_SKILLS = 40;
/** Faits établis maximum ; au-delà, les plus anciens sortent (FIFO). */
export const MAX_FACTS = 60;

/** Clé de comparaison : minuscules, accents et espaces superflus retirés. */
function skillKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Palier depuis la valeur brute de l'attribut tier (tolérant aux accents). */
export function normalizeTier(raw: string): SkillTier | null {
  switch (skillKey(raw)) {
    case "decouverte":
    case "novice":
      return "découverte";
    case "apprentissage":
      return "apprentissage";
    case "maitrise":
      return "maîtrise";
    case "inne":
      return "inné";
    default:
      return null;
  }
}

/**
 * Upsert d'une compétence. Une compétence ne régresse jamais (le MJ peut se
 * tromper de palier ; la fiction, elle, n'oublie pas un acquis). La note est
 * rafraîchie quand fournie. Renvoie true si l'état a changé.
 */
export function applySkillUpdate(
  skills: SkillEntry[],
  name: string,
  tierRaw: string,
  note?: string,
): boolean {
  const tier = normalizeTier(tierRaw);
  const cleanName = name.trim();
  if (!tier || cleanName === "") return false;

  const existing = skills.find((s) => skillKey(s.name) === skillKey(cleanName));
  if (!existing) {
    if (skills.length >= MAX_SKILLS) return false;
    const entry: SkillEntry = { name: cleanName, tier };
    if (note?.trim()) entry.note = note.trim();
    skills.push(entry);
    return true;
  }

  let changed = false;
  if (SKILL_TIERS.indexOf(tier) > SKILL_TIERS.indexOf(existing.tier)) {
    existing.tier = tier;
    changed = true;
  }
  if (note?.trim() && note.trim() !== existing.note) {
    existing.note = note.trim();
    changed = true;
  }
  return changed;
}

/**
 * Valide une liste de compétences venue de l'extérieur (skills_json D1, corps
 * d'un PUT client) : entrées bien formées uniquement, paliers normalisés,
 * doublons fusionnés, bornée à MAX_SKILLS. Toujours une liste sûre.
 */
export function sanitizeSkills(raw: unknown): SkillEntry[] {
  if (!Array.isArray(raw)) return [];
  const skills: SkillEntry[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, tier, note } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof tier !== "string") continue;
    applySkillUpdate(
      skills,
      name,
      tier,
      typeof note === "string" ? note : undefined,
    );
  }
  return skills;
}

/**
 * Fusionne les acquis d'une session dans la liste persistée du personnage :
 * upsert par compétence, jamais de régression de palier. Ne mute pas `saved`.
 */
export function mergeSkills(
  saved: SkillEntry[],
  session: SkillEntry[],
): SkillEntry[] {
  const merged = saved.map((s) => ({ ...s }));
  for (const s of session) applySkillUpdate(merged, s.name, s.tier, s.note);
  return merged;
}

/** Ajoute un fait établi (dédupliqué, borné FIFO). Renvoie true si ajouté. */
export function addFact(facts: string[], text: string): boolean {
  const clean = text.trim();
  if (clean === "" || facts.includes(clean)) return false;
  facts.push(clean);
  while (facts.length > MAX_FACTS) facts.shift();
  return true;
}

/** État mutable d'une session, sérialisé dans le storage du DO. */
export interface GameState {
  souffle: number;
  /** Faits établis en session (réponses de setup, événements clés). */
  facts: string[];
  /** Compétences acquises, enregistrées par le MJ via <skill/>. */
  skills: SkillEntry[];
  /** Jet demandé par le MJ via <roll/>, en attente de POST /roll. */
  pending_roll: string | null;
  /** Dernier jet résolu, à injecter dans le prompt du prochain tour. */
  last_roll: RollResult | null;
  /** Nombre de tours de narration générés (setup inclus). */
  turn_count: number;
}

export function initialGameState(): GameState {
  return {
    souffle: SOUFFLE_MAX,
    facts: [],
    skills: [],
    pending_roll: null,
    last_roll: null,
    turn_count: 0,
  };
}
