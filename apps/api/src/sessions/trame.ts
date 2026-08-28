// Fils rouges proposés à la mise en place (SPEC §4).
//
// Le champ libre reste la voie principale : le fil rouge est la volonté de
// l'auteur pour CETTE partie, et personne ne la connaît mieux que lui. Mais
// devant une page blanche, deux propositions tirées du canon valent mieux
// qu'un exemple générique — surtout sur une bible qu'on n'a pas relue depuis
// des semaines. On en propose donc DEUX, jamais plus : trois pistes, et le
// choix redevient une corvée.

import Anthropic from "@anthropic-ai/sdk";
import { MAX_CANON_CHARS } from "../richness/logic";

export const TRAME_MODEL = "claude-sonnet-5";

/** Deux propositions, pas une de plus : au-delà, choisir coûte plus que rédiger. */
export const TRAME_SUGGESTIONS = 2;

/** Borne du champ libre côté client (textarea maxlength). */
const MAX_TRAME_CHARS = 500;

/** Le format, en clair pour le modèle : « campagne » cadre mieux que « campaign ». */
const FORMATS: Record<string, string> = {
  oneshot: "one-shot (une seule soirée)",
  mini: "mini-campagne (quelques séances)",
  campaign: "campagne (au long cours)",
};

const TRAMES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["trames"],
  properties: {
    trames: {
      // Les sorties structurées n'acceptent minItems qu'à 0 ou 1 et ignorent
      // maxItems (cf. MOODBOARD_OUTPUT_SCHEMA) : un schéma exigeant deux
      // éléments est REFUSÉ par l'API, et l'appel échouait avant même de
      // générer quoi que ce soit. Le « exactement deux » est porté par le
      // prompt et vérifié par parseTrames.
      type: "array",
      minItems: 1,
      description:
        "Exactement deux fils rouges, différents l'un de l'autre, une phrase chacun.",
      items: { type: "string" },
    },
  },
} as const;

export interface TrameContext {
  bibleTitle: string;
  canonMd: string;
  format: string;
  /** Les personnages de la table, s'ils sont déjà assis. */
  characters: string[];
}

/** Le prompt, isolé pour être relisible sans dérouler l'appel réseau. */
export function buildTramePrompt(input: TrameContext): string {
  const canon =
    input.canonMd.length > MAX_CANON_CHARS
      ? input.canonMd.slice(0, MAX_CANON_CHARS) + "\n\n[... bible tronquée ...]"
      : input.canonMd;
  const format = FORMATS[input.format] ?? input.format;
  const qui = input.characters.length
    ? `Personnages incarnés à cette table : ${input.characters.join(", ")}. Chacun des deux fils rouges doit donner à CES personnages une raison d'agir — une place dans l'histoire, pas un rôle de spectateur.`
    : "Personne n'est encore assis : écris des fils rouges qu'un personnage encore à créer pourra épouser, sans présumer de qui il sera.";

  return `Propose ${TRAME_SUGGESTIONS} fils rouges possibles pour une partie de jeu de rôle qui démarre dans l'univers « ${input.bibleTitle} ».

Un fil rouge est l'INTENTION directrice de la partie, pas son scénario : une
phrase qui dit ce que la session cherche, sans en écrire la fin. Il oriente les
scènes et les enjeux ; le MJ et les joueurs restent libres de s'en écarter.

- Une phrase par fil rouge, en français, sans guillemets ni numérotation.
- Ancré dans le canon ci-dessous : nomme des lieux, factions ou personnages qui
  y existent vraiment. Rien d'inventé.
- Les deux propositions doivent ouvrir des parties DIFFÉRENTES — pas deux
  formulations de la même idée.
- Format de la partie : ${format}. Une campagne peut viser loin ; un one-shot
  doit tenir en une soirée.
- ${qui}

== BIBLE ==
${canon}`;
}

/** Nettoie une proposition : une phrase, bornée comme le champ libre. */
function cleanTrame(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^["«\s]+|["»\s]+$/g, "");
  return trimmed === "" ? null : trimmed.slice(0, MAX_TRAME_CHARS);
}

export function parseTrames(payload: unknown): string[] | null {
  const raw = (payload as { trames?: unknown })?.trames;
  if (!Array.isArray(raw)) return null;
  const trames = raw.map(cleanTrame).filter((t): t is string => t !== null);
  // Deux propositions identiques ne laisseraient aucun choix.
  const uniques = [...new Set(trames)];
  return uniques.length >= TRAME_SUGGESTIONS
    ? uniques.slice(0, TRAME_SUGGESTIONS)
    : null;
}

export async function suggestTrames(
  apiKey: string,
  input: TrameContext,
): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: TRAME_MODEL,
    max_tokens: 1000,
    output_config: { format: { type: "json_schema", schema: TRAMES_OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: buildTramePrompt(input) }],
  });
  if (response.stop_reason === "refusal") throw new Error("trame_refused");

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `trame_invalid_json (stop=${response.stop_reason}, len=${text.length})`,
    );
  }
  const trames = parseTrames(payload);
  if (trames === null) throw new Error("trame_invalid_payload");
  return trames;
}
