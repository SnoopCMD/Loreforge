// Pertinence des zones floues pour LA session qui démarre (SPEC §4).
//
// Les lacunes d'une bible sont globales ; une partie, non. Poser « qui sont les
// six Gardiens ? » à une joueuse qui incarne une videuse de club au milieu
// d'une guerre de gangs gaspille la mise en place et laisse de côté ce qui
// compte vraiment (sa faction, son club, les règles de son propre pouvoir).
// On note donc chaque lacune par un appel IA court, contexte de session en
// main, avant de choisir les questions. Logique pure ici ; l'appel est dans le
// Durable Object.

import { AXES, type Axis, type RichnessGap } from "../richness/logic";
import { MAX_SETUP_QUESTIONS } from "./prompt";

/** En dessous, la lacune ne sera probablement pas croisée : on ne la pose pas. */
export const RELEVANCE_THRESHOLD = 6;
/** Lacunes soumises au scoring : au-delà, le coût dépasse l'utilité. */
export const MAX_SCORED_GAPS = 24;

export interface ScoredGap {
  gap: RichnessGap;
  /** 0-10 : probabilité que le MJ doive trancher cette lacune cette fois-ci. */
  relevance: number;
  why: string;
}

export interface RelevanceContext {
  /** Fiche du personnage joué, telle que stockée (JSON ou texte). */
  characterSheet?: string | null;
  characterName?: string | null;
  trame?: string | null;
  format?: string | null;
}

export interface RelevanceVerdict {
  scored: ScoredGap[];
  /**
   * Zone floue ad hoc : la session touche clairement un point que la bible ne
   * couvre pas et qu'aucune lacune détectée ne nomme. Null la plupart du temps.
   */
  adHoc: RichnessGap | null;
}

function gapId(index: number): string {
  return `g${index + 1}`;
}

export const RELEVANCE_SYSTEM_PROMPT = `Tu tries des zones floues de bible d'univers pour une partie de jeu de rôle qui va démarrer. Tu ne rédiges pas de fiction : tu estimes ce que le MJ devra trancher pendant CETTE session.

- Une lacune sur une faction que le personnage ne croisera pas, ou sur une
  mécanique qui ne s'appliquera pas à son type de pouvoir, obtient un score bas
  même si l'axe est globalement faible dans la bible.
- Une lacune que la première scène peut heurter (le lieu où le personnage
  travaille, les règles de sa propre nature, les gens de son allégeance)
  obtient un score haut.
- Sois sévère : mieux vaut trois lacunes vraiment pertinentes, ou une seule,
  que six approximatives.
- Si, et seulement si, aucune lacune de la liste n'est pertinente alors que la
  session touche visiblement une zone que la bible ne couvre pas (typiquement
  une capacité du personnage dont les règles ne sont pas définies), décris
  cette zone manquante dans "ad_hoc". Sinon "ad_hoc" vaut null.
- "why" tient en une demi-phrase, pour l'auteur.`;

export function buildRelevanceMessage(
  gaps: RichnessGap[],
  context: RelevanceContext,
): string {
  const listed = gaps
    .map((g, i) => `${gapId(i)} [${g.axis}] ${g.description}`)
    .join("\n");
  return [
    "Voici les zones floues détectées dans la bible :",
    listed,
    "",
    "Voici le contexte de la session qui va démarrer :",
    `- Personnage : ${context.characterName ?? "non nommé"} — ${
      context.characterSheet?.trim() || "fiche non renseignée"
    }`,
    `- Trame / cadre : ${context.trame?.trim() || "aucun fil rouge posé"}`,
    `- Format : ${context.format ?? "non précisé"}`,
    "",
    "Pour chaque lacune, estime de 0 à 10 la probabilité que le MJ ait besoin de la trancher pendant cette session précise.",
  ].join("\n");
}

export const RELEVANCE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gaps", "ad_hoc"],
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["gap_id", "relevance", "why"],
        properties: {
          gap_id: { type: "string", description: "Identifiant fourni (g1, g2…)" },
          relevance: { type: "integer", description: "0-10" },
          why: { type: "string", description: "Une demi-phrase" },
        },
      },
    },
    // anyOf plutôt qu'un type nullable : c'est la forme du sous-ensemble de
    // JSON Schema accepté par l'API pour les sorties structurées.
    ad_hoc: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["axis", "description"],
          properties: {
            axis: { type: "string", enum: [...AXES] },
            description: {
              type: "string",
              description:
                "Zone manquante propre à cette session, formulée comme une lacune",
            },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(10, Math.max(0, n));
}

/** Lit la réponse du modèle ; tout ce qui est illisible vaut « non pertinent ». */
export function parseRelevance(
  payload: unknown,
  gaps: RichnessGap[],
): RelevanceVerdict {
  const body = (payload ?? {}) as {
    gaps?: unknown;
    ad_hoc?: { axis?: unknown; description?: unknown } | null;
  };
  const byId = new Map(gaps.map((g, i) => [gapId(i), g]));
  const seen = new Set<string>();
  const scored: ScoredGap[] = [];

  if (Array.isArray(body.gaps)) {
    for (const row of body.gaps) {
      const r = (row ?? {}) as { gap_id?: unknown; relevance?: unknown; why?: unknown };
      const id = typeof r.gap_id === "string" ? r.gap_id.trim() : "";
      const gap = byId.get(id);
      if (!gap || seen.has(id)) continue;
      seen.add(id);
      scored.push({
        gap,
        relevance: clampScore(r.relevance),
        why: typeof r.why === "string" ? r.why.trim() : "",
      });
    }
  }

  const ad = body.ad_hoc;
  const axis = typeof ad?.axis === "string" ? ad.axis.trim() : "";
  const description = typeof ad?.description === "string" ? ad.description.trim() : "";
  const adHoc =
    (AXES as readonly string[]).includes(axis) && description
      ? { axis: axis as Axis, description }
      : null;

  return { scored, adHoc };
}

/**
 * Questions de mise en place : les lacunes au-dessus du seuil, 3 max, les plus
 * pertinentes d'abord. On ne complète JAMAIS avec des lacunes faibles — une
 * mise en place courte vaut mieux qu'une mise en place hors sujet. Si rien ne
 * passe le seuil, la zone ad hoc prend la main quand le modèle en a nommé une.
 */
export function selectRelevantGaps(verdict: RelevanceVerdict): RichnessGap[] {
  const kept = verdict.scored
    .filter((s) => s.relevance >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_SETUP_QUESTIONS)
    .map((s) => s.gap);
  if (kept.length > 0) return kept;
  return verdict.adHoc ? [verdict.adHoc] : [];
}
