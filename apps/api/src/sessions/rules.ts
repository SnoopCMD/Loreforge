// Moteur « Souffle » : logique pure (SPEC §6), sans dépendance runtime —
// testable unitairement (DoD M3).
//
// Résolution contextuelle : le MJ ne demande plus « un d6 », il décrit les
// CONDITIONS du jet (difficulté, posture, compétences engagées) et le serveur
// lance la poignée de dés correspondante.
//
//   - Issue binaire : réussite ou échec. Un dé retenu à 6 = réussite critique,
//     à 1 = échec critique.
//   - Difficulté → seuil de réussite d'un dé :
//       facile   1-2 échec / 3-4-5-6 réussite   (seuil 3)
//       normal   1-2-3 échec / 4-5-6 réussite   (seuil 4)
//       difficile 1-2-3-4 échec / 5-6 réussite  (seuil 5)
//   - Avantage : un dé de plus, on garde le MEILLEUR.
//     Désavantage : un dé de plus, on garde le PIRE.
//   - Chaque dé à 5 ou 6 annule un dé raté (le pire d'abord) : les dés annulés
//     ne comptent plus, ce qui adoucit notamment le désavantage.
//   - Poignée : barème explicite lié à la fiche (voir « Barème des dés »).
//
// Les dés ne sont JAMAIS lancés par le modèle : il demande un jet via
// <roll reason="..." difficulty="..." stance="..." bonuses="..."/>, le DO le
// résout et injecte le résultat au tour suivant.

export const SOUFFLE_MAX = 3;

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Valeur minimale d'un dé pour qu'il compte comme une réussite. */
export const DIFFICULTY_THRESHOLD: Record<Difficulty, number> = {
  easy: 3,
  normal: 4,
  hard: 5,
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "facile",
  normal: "normale",
  hard: "difficile",
};

export const STANCES = ["advantage", "neutral", "disadvantage"] as const;
export type Stance = (typeof STANCES)[number];

export const STANCE_LABELS: Record<Stance, string> = {
  advantage: "avantage",
  neutral: "neutre",
  disadvantage: "désavantage",
};

/** Un dé à 5 ou 6 annule un dé raté. */
export const CANCEL_VALUE = 5;
/** Somme des bonus possibles (tempérament + capacité + compétence + souffle) ;
 * le cumul peut dépasser la poignée, qui est écrêtée à MAX_POOL. */
export const MAX_BONUS_DICE = 4;
/** Plafond de la poignée, dé de posture compris. */
export const MAX_POOL = 4;

// ── Barème des dés (SPEC §6) ──────────────────────────────────────────────
//
// La poignée ne dépend plus de l'appréciation libre du MJ : elle se calcule.
//
//   1 dé de base
//   +1 si l'action s'aligne avec le TEMPÉRAMENT du personnage
//   +1 si elle mobilise sa CAPACITÉ principale
//   +1 si elle engage une COMPÉTENCE acquise à maîtrise ou inné
//   +1 si un point de Souffle est dépensé
//   -1 si elle heurte frontalement sa FAIBLESSE déclarée
//   (plancher 1 dé, plafond MAX_POOL = 4 — le cumul peut dépasser, il est
//    simplement écrêté)
//
// Le MJ doit énumérer les bonus qu'il applique et pourquoi ; le serveur
// recalcule la poignée depuis cette liste, jamais depuis un nombre annoncé.

export const ROLL_BONUS_SOURCES = [
  "temperament",
  "ability",
  "skill",
  "souffle",
  "weakness",
] as const;
export type RollBonusSource = (typeof ROLL_BONUS_SOURCES)[number];

export const ROLL_BONUS_DICE: Record<RollBonusSource, number> = {
  temperament: 1,
  ability: 1,
  skill: 1,
  souffle: 1,
  weakness: -1,
};

export const ROLL_BONUS_LABELS: Record<RollBonusSource, string> = {
  temperament: "tempérament",
  ability: "capacité",
  skill: "compétence",
  souffle: "souffle",
  weakness: "faiblesse",
};

/** Un bonus (ou malus) appliqué à la poignée, avec sa justification. */
export interface RollBonus {
  source: RollBonusSource;
  /** Ce qui, dans la fiche et dans l'action, justifie ce dé (affichage). */
  why: string;
}

export type RollOutcome =
  | "critical_failure"
  | "failure"
  | "success"
  | "critical_success";

/** Conditions du jet, fixées par le MJ (jamais par le client : anti-triche). */
export interface RollRequest {
  reason: string;
  difficulty: Difficulty;
  stance: Stance;
  /** Somme nette des bonus de fiche — dérivée de `bonuses` quand il y en a. */
  bonus_dice: number;
  /** Bonus appliqués, source par source, avec leur justification. */
  bonuses: RollBonus[];
  /** Compétences/atouts engagés dans l'action (affichage). */
  skills: string[];
}

export interface RolledDie {
  value: number; // 1-6
  /** Le dé atteint-il le seuil de difficulté ? */
  success: boolean;
  /** Dé raté annulé par un 5/6. */
  cancelled: boolean;
  /** Dé finalement retenu pour l'issue. */
  kept: boolean;
}

export interface RollResult extends RollRequest {
  dice: RolledDie[];
  /** Valeur du dé retenu. */
  value: number;
  outcome: RollOutcome;
  /** Nombre d'échecs annulés par les 5/6. */
  cancelled: number;
  /** Seuil appliqué (dérivé de la difficulté, utile côté affichage). */
  threshold: number;
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Source d'un bonus, tolérante aux libellés français et aux accents. */
export function normalizeBonusSource(raw: string): RollBonusSource | null {
  const key = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  switch (key) {
    case "temperament":
    case "temperamment":
      return "temperament";
    case "ability":
    case "capacite":
    case "capacite principale":
    case "pouvoir":
      return "ability";
    case "skill":
    case "competence":
    case "competence engagee":
      return "skill";
    case "souffle":
      return "souffle";
    case "weakness":
    case "faiblesse":
    case "cout":
      return "weakness";
    default:
      return null;
  }
}

/**
 * Lit la liste des bonus : soit un tableau d'objets, soit l'attribut texte du
 * MJ — `tempérament: provocation ; capacité: sigils`. Les entrées inconnues
 * sont ignorées (un bonus non nommé n'est pas un bonus), et une même source ne
 * compte qu'une fois.
 */
export function normalizeBonuses(raw: unknown): RollBonus[] {
  const entries: Array<{ source: string; why: string }> = [];
  if (typeof raw === "string") {
    for (const part of raw.split(/\s*[;/|]\s*/)) {
      const m = part.match(/^\s*([^:]+?)\s*(?::\s*(.*))?$/);
      if (m) entries.push({ source: m[1], why: m[2] ?? "" });
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      const o = (item ?? {}) as { source?: unknown; why?: unknown };
      if (typeof o.source === "string") {
        entries.push({
          source: o.source,
          why: typeof o.why === "string" ? o.why : "",
        });
      }
    }
  }

  const out: RollBonus[] = [];
  for (const entry of entries) {
    const source = normalizeBonusSource(entry.source);
    if (!source || out.some((b) => b.source === source)) continue;
    out.push({ source, why: entry.why.trim().slice(0, 120) });
  }
  return out;
}

/** Somme nette des dés d'une liste de bonus. */
export function bonusDice(bonuses: RollBonus[]): number {
  return bonuses.reduce((n, b) => n + ROLL_BONUS_DICE[b.source], 0);
}

/**
 * Normalise une demande de jet venant du modèle, du client ou d'un état
 * persisté avant ce système (où `pending_roll` n'était qu'une raison texte).
 * Quand le MJ a énuméré ses bonus, ce sont EUX qui font la poignée : le
 * nombre de dés annoncé n'est jamais cru sur parole.
 */
export function normalizeRollRequest(
  input: unknown,
  fallbackReason = "action risquée",
): RollRequest {
  if (typeof input === "string" || input == null) {
    return {
      reason: (typeof input === "string" && input.trim()) || fallbackReason,
      difficulty: "normal",
      stance: "neutral",
      bonus_dice: 0,
      bonuses: [],
      skills: [],
    };
  }
  const raw = input as Record<string, unknown>;
  const difficulty = DIFFICULTIES.includes(raw.difficulty as Difficulty)
    ? (raw.difficulty as Difficulty)
    : "normal";
  const stance = STANCES.includes(raw.stance as Stance)
    ? (raw.stance as Stance)
    : "neutral";
  const skills = Array.isArray(raw.skills)
    ? raw.skills
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_BONUS_DICE)
    : [];
  const reason =
    (typeof raw.reason === "string" && raw.reason.trim().slice(0, 200)) ||
    fallbackReason;
  const bonuses = normalizeBonuses(raw.bonuses);
  return {
    reason,
    difficulty,
    stance,
    // Avec un barème explicite, le total se déduit ; sans lui (état d'avant ce
    // système, jet libre), on retombe sur le nombre transmis.
    bonus_dice:
      bonuses.length > 0
        ? bonusDice(bonuses)
        : clampInt(raw.bonus_dice ?? 0, 0, MAX_BONUS_DICE),
    bonuses,
    skills,
  };
}

/**
 * Taille de la poignée : 1 dé de base + bonus de fiche + 1 dé de posture,
 * jamais moins d'un dé (une faiblesse ne prive pas du jet), jamais plus de
 * MAX_POOL (4).
 */
export function poolSize(request: RollRequest): number {
  const extra = request.stance === "neutral" ? 0 : 1;
  return Math.min(MAX_POOL, Math.max(1, 1 + request.bonus_dice + extra));
}

export function outcomeForValue(
  value: number,
  difficulty: Difficulty,
): RollOutcome {
  if (value >= 6) return "critical_success";
  if (value <= 1) return "critical_failure";
  return value >= DIFFICULTY_THRESHOLD[difficulty] ? "success" : "failure";
}

export function isSuccess(outcome: RollOutcome): boolean {
  return outcome === "success" || outcome === "critical_success";
}

/**
 * Résolution pure : à valeurs de dés données, quelle issue ?
 * 1. chaque dé réussit s'il atteint le seuil de difficulté ;
 * 2. chaque 5/6 annule un dé raté (le pire d'abord) ;
 * 3. on retient, parmi les dés restants, le meilleur (neutre/avantage) ou le
 *    pire (désavantage) ;
 * 4. l'issue vient du dé retenu (6 critique en réussite, 1 critique en échec).
 */
export function resolveRoll(
  request: RollRequest,
  values: number[],
): RollResult {
  const threshold = DIFFICULTY_THRESHOLD[request.difficulty];
  const dice: RolledDie[] = values.map((value) => ({
    value,
    success: value >= threshold,
    cancelled: false,
    kept: false,
  }));

  // Les 5/6 effacent les ratés, en commençant par les plus mauvais.
  const boons = dice.filter((d) => d.value >= CANCEL_VALUE).length;
  const failures = dice
    .filter((d) => !d.success)
    .sort((a, b) => a.value - b.value);
  let cancelled = 0;
  for (const die of failures) {
    if (cancelled >= boons) break;
    die.cancelled = true;
    cancelled++;
  }

  // Un dé à 5/6 n'est jamais un raté (seuil max = 5) : il reste toujours au
  // moins un dé en lice. Le `?? dice` n'est qu'une ceinture.
  const remaining = dice.filter((d) => !d.cancelled);
  const pool = remaining.length ? remaining : dice;
  const kept = pool.reduce((best, die) =>
    request.stance === "disadvantage"
      ? die.value < best.value
        ? die
        : best
      : die.value > best.value
        ? die
        : best,
  );
  kept.kept = true;

  return {
    ...request,
    dice,
    value: kept.value,
    outcome: outcomeForValue(kept.value, request.difficulty),
    cancelled,
    threshold,
  };
}

/** Libellé français injecté dans le prompt du tour suivant. */
export function describeOutcome(outcome: RollOutcome): string {
  switch (outcome) {
    case "critical_failure":
      return "échec critique";
    case "failure":
      return "échec";
    case "success":
      return "réussite";
    case "critical_success":
      return "réussite critique";
  }
}

/** d6 serveur (anti-triche). Le biais modulo sur 2^32 est négligeable. */
export function rollD6(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 6) + 1;
}

/** Lance la poignée du jet et le résout côté serveur. */
export function performRoll(request: RollRequest): RollResult {
  const values = Array.from({ length: poolSize(request) }, () => rollD6());
  return resolveRoll(request, values);
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

/**
 * Ce qu'un palier apporte AU JET, quand jet il y a. En amont, le palier dit
 * déjà s'il faut lancer les dés (découverte : toujours ; inné : jamais) ;
 * ici il dit ce que l'acquis vaut une fois la poignée constituée : un savoir
 * assimilé pèse un dé, un savoir en cours d'acquisition ne pèse rien.
 */
export const TIER_GRANTS_DIE: Record<SkillTier, boolean> = {
  découverte: false,
  apprentissage: false,
  maîtrise: true,
  inné: true,
};

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
 * La compétence engagée la mieux assimilée parmi celles nommées par le MJ,
 * à condition qu'elle soit réellement acquise (la liste du personnage fait
 * foi) et que son palier donne un dé. null sinon.
 */
export function engagedSkillDie(
  engaged: string[],
  acquired: SkillEntry[],
): SkillEntry | null {
  const wanted = new Set(engaged.map(skillKey));
  let best: SkillEntry | null = null;
  for (const skill of acquired) {
    if (!wanted.has(skillKey(skill.name)) || !TIER_GRANTS_DIE[skill.tier]) continue;
    if (!best || SKILL_TIERS.indexOf(skill.tier) > SKILL_TIERS.indexOf(best.tier)) {
      best = skill;
    }
  }
  return best;
}

/**
 * Applique le palier des compétences engagées à la poignée. Déterministe et
 * vérifié : le bonus de compétence n'existe que si le personnage a vraiment
 * l'acquis au bon palier — un bonus réclamé sans acquis derrière est retiré,
 * un acquis oublié par le MJ est ajouté.
 */
export function applySkillTiers(
  request: RollRequest,
  acquired: SkillEntry[],
): RollRequest {
  const earned = engagedSkillDie(request.skills, acquired);
  const others = request.bonuses.filter((b) => b.source !== "skill");
  const bonuses = earned
    ? [...others, { source: "skill" as const, why: `${earned.name}, ${earned.tier}` }]
    : others;
  if (
    bonuses.length === request.bonuses.length &&
    bonuses.every((b, i) => b.source === request.bonuses[i].source && b.why === request.bonuses[i].why)
  ) {
    return request;
  }
  return { ...request, bonuses, bonus_dice: bonusDice(bonuses) };
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
  pending_roll: RollRequest | null;
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
