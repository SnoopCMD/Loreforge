// Indice de Richesse : logique pure (prompt, validation, agrégation).
// Aucune dépendance réseau — testable unitairement (DoD M2, SPEC §4).

export const AXES = [
  "cosmology",
  "characters",
  "plots",
  "tone",
  "geography",
] as const;

export type Axis = (typeof AXES)[number];

export interface RichnessScores {
  cosmology: number;
  characters: number;
  plots: number;
  tone: number;
  geography: number;
}

export interface RichnessGap {
  axis: Axis;
  description: string;
}

export interface RichnessResult {
  scores: RichnessScores;
  gaps: RichnessGap[];
}

// Au-delà, le canon est tronqué avant l'appel (~30k tokens, cf. SPEC §2 :
// les grosses bibles passeront par le RAG en M6).
export const MAX_CANON_CHARS = 120_000;

/**
 * Schéma JSON strict imposé au modèle via output_config.format.
 * Les bornes 0-10 ne sont pas exprimables dans ce sous-ensemble de
 * JSON Schema : elles sont validées côté serveur par parseRichnessPayload.
 */
export const RICHNESS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...AXES, "gaps"],
  properties: {
    cosmology: { type: "integer", description: "Score 0-10" },
    characters: { type: "integer", description: "Score 0-10" },
    plots: { type: "integer", description: "Score 0-10" },
    tone: { type: "integer", description: "Score 0-10" },
    geography: { type: "integer", description: "Score 0-10" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["axis", "description"],
        properties: {
          axis: { type: "string", enum: [...AXES] },
          description: {
            type: "string",
            description: "Zone floue détectée, une phrase concrète",
          },
        },
      },
    },
  },
} as const;

export function buildRichnessPrompt(canonMd: string): string {
  let canon = canonMd;
  if (canon.length > MAX_CANON_CHARS) {
    canon =
      canon.slice(0, MAX_CANON_CHARS) +
      "\n\n[... bible tronquée pour l'analyse ...]";
  }

  return `Tu évalues la « bible » d'un univers de fiction pour préparer des sessions de jeu de rôle narrées par IA.

Note chaque axe de 0 (absent) à 10 (exhaustif) :
- cosmology : règles du monde, magie, hiérarchies, mécaniques internes.
- characters : fiches de personnages, motivations, relations.
- plots : conflits actifs, antagonistes, trames narratives exploitables.
- tone : registre, niveau de violence, humour, inspirations explicités.
- geography : lieux concrets, cartes, descriptions spatiales.

Liste ensuite dans "gaps" les zones floues importantes (3 à 12 entrées) : ce qu'un
Maître de Jeu devrait inventer faute d'information. Chaque entrée cible un axe et
décrit UNE lacune concrète et actionnable, en français.

Ne sur-note pas : une simple mention sans détail exploitable ne dépasse pas 3-4.
Un axe riche mais désorganisé plafonne à 7-8.

== BIBLE À ÉVALUER ==
${canon}`;
}

/**
 * Valide la sortie du modèle (déjà contrainte par le schéma, mais on ne fait
 * jamais confiance au réseau) : structure, axes connus, scores entiers
 * ramenés dans [0, 10]. Renvoie null si inexploitable.
 */
export function parseRichnessPayload(payload: unknown): RichnessResult | null {
  if (payload === null || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  const scores = {} as RichnessScores;
  for (const axis of AXES) {
    const value = obj[axis];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    scores[axis] = Math.min(10, Math.max(0, Math.round(value)));
  }

  if (!Array.isArray(obj.gaps)) return null;
  const gaps: RichnessGap[] = [];
  for (const entry of obj.gaps) {
    if (entry === null || typeof entry !== "object") return null;
    const { axis, description } = entry as Record<string, unknown>;
    if (typeof axis !== "string" || !(AXES as readonly string[]).includes(axis)) {
      return null;
    }
    if (typeof description !== "string" || description.trim() === "") {
      return null;
    }
    gaps.push({ axis: axis as Axis, description: description.trim() });
  }

  return { scores, gaps };
}

/** Score global : moyenne des 5 axes, arrondie au plus proche. */
export function computeGlobal(scores: RichnessScores): number {
  const sum = AXES.reduce((acc, axis) => acc + scores[axis], 0);
  return Math.round(sum / AXES.length);
}
