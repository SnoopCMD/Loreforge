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

/** État mutable d'une session, sérialisé dans le storage du DO. */
export interface GameState {
  souffle: number;
  /** Faits établis en session (réponses de setup, événements clés). */
  facts: string[];
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
    pending_roll: null,
    last_roll: null,
    turn_count: 0,
  };
}
