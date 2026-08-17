// Indice de Richesse : logique pure (prompt, validation, agrégation).
// Aucune dépendance réseau — testable unitairement (DoD M2, SPEC §4).
// Depuis §6bis, la même analyse produit aussi le schéma de fiche personnage
// et les personnages canon jouables.

import {
  normalizeSheetFields,
  parsePlayableCharacters,
  SHEET_FIELD_OUTPUT_SCHEMA,
  SHEET_PAIRS_OUTPUT_SCHEMA,
  type PlayableCharacter,
  type SheetSchema,
} from "../characters/schema";

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
  /** Schéma de fiche dérivé de la bible (SPEC §6bis) ; null si absent. */
  sheetSchema: SheetSchema | null;
  /** Personnages canon jouables extraits de la bible. */
  playable: PlayableCharacter[];
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
  required: [...AXES, "gaps", "sheet_fields", "playable_characters"],
  properties: {
    sheet_fields: {
      type: "array",
      items: SHEET_FIELD_OUTPUT_SCHEMA,
      description: "Champs de fiche personnage dérivés de la bible (§6bis)",
    },
    playable_characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "sheet"],
        properties: {
          name: { type: "string" },
          sheet: SHEET_PAIRS_OUTPUT_SCHEMA,
        },
      },
      description: "Personnages canon incarnables, fiche pré-remplie du canon",
    },
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

export function buildRichnessPrompt(
  canonMd: string,
  moodboardAnnex = "",
): string {
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

Produis aussi, POUR CETTE BIBLE précisément :

"sheet_fields" : les champs d'une fiche de personnage joueur dérivés du canon
(4 à 8 champs). Toujours inclure des équivalents de : nom, concept en une
phrase, tempérament, capacité principale, faiblesse/coût, accroche narrative
(clés : name, concept, temperament, ability, weakness, hook) — enrichis-les de
"suggestions" tirées du canon. Ajoute des champs SPÉCIFIQUES à ce monde quand
le canon s'y prête (ex. un monde à magie divine → champ "Dieu patron" en
select avec les dieux du canon + « Inconnu » ; un monde de factions → champ
"Allégeance"). "type": "select" seulement si le canon fournit une liste fermée.
Clés en snake_case, libellés et contenus en français.

Rends la fiche ADAPTATIVE quand la logique du canon l'exige, via "show_if" et
"hide_if" (sinon laisse-les vides). Chaque condition = { "field": clé d'un
champ select de la fiche, "values": valeurs qui la déclenchent } ; plusieurs
conditions = OU logique :
- "hide_if" masque un champ rendu absurde par une réponse (ex. si le champ
  "classe" vaut « Dieu », masquer "dieu_patron" — un dieu n'a pas de patron).
- "show_if" réserve un champ aux réponses qui le justifient (ex. un champ
  "ecole" listant les écoles n'apparaît que si "voie" vaut « Passeur »).
N'utilise ces conditions que quand le canon les impose clairement — champs
peu nombreux et pertinents plutôt qu'exhaustifs. Jamais de condition sur les
champs de base (name, concept, temperament, ability, weakness, hook).

"playable_characters" : les personnages du canon qu'un joueur pourrait
incarner (0 à 6 : protagonistes, membres de factions accessibles — pas les
antagonistes majeurs ni les dieux). Pré-remplis leur fiche depuis le canon en
réutilisant les clés de "sheet_fields" ; n'invente pas, laisse de côté les
champs que le canon ne renseigne pas.

${
    moodboardAnnex
      ? `${moodboardAnnex}

Ces références comptent pour l'axe "tone" (registre, atmosphère, inspirations
assumées) et peuvent nourrir les "suggestions" de la fiche. Elles ne notent
JAMAIS les autres axes — une ambiance n'est ni une cosmologie, ni une carte, ni
une intrigue — et une lacune de canon reste une lacune même si l'image la
suggère.

`
      : ""
  }== BIBLE À ÉVALUER ==
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

  // §6bis — tolérant : une sortie sans ces champs (anciens mocks, modèle
  // récalcitrant) reste une analyse valide, juste sans schéma de fiche.
  const sheetSchema =
    "sheet_fields" in obj && Array.isArray(obj.sheet_fields)
      ? normalizeSheetFields(obj.sheet_fields)
      : null;
  const playable = parsePlayableCharacters(obj.playable_characters);

  return { scores, gaps, sheetSchema, playable };
}

/** Score global : moyenne des 5 axes, arrondie au plus proche. */
export function computeGlobal(scores: RichnessScores): number {
  const sum = AXES.reduce((acc, axis) => acc + scores[axis], 0);
  return Math.round(sum / AXES.length);
}
