// Analyse d'un tableau de références : lecture d'ambiance + palettes proposées.
// Appel vision Anthropic (images en base64) avec sortie JSON stricte, validée
// par la logique pure de palette.ts.

import Anthropic from "@anthropic-ai/sdk";
import {
  describeAnalysisPayload,
  MOODBOARD_OUTPUT_SCHEMA,
  parseAnalysisPayload,
  type MoodboardAnalysis,
} from "./palette";

export const MOODBOARD_MODEL = "claude-opus-5";

/** Images acceptées par l'API vision. */
export const VISION_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** Au-delà, l'appel devient lourd sans rien apporter à la lecture d'ambiance. */
export const MAX_ANALYZED_IMAGES = 8;

/**
 * Budget d'images d'un appel. L'API refuse une requête au-delà de 32 Mo et le
 * base64 gonfle d'un tiers : huit photos de 5 Mo (tolérées à l'import une par
 * une) dépassent la limite ensemble, et l'appel échoue en bloc. On s'arrête
 * donc avant — mieux vaut lire quatre images que zéro.
 */
export const MAX_ANALYZED_BYTES = 18 * 1024 * 1024;

export interface VisionImage {
  mediaType: string;
  bytes: Uint8Array;
}

/** base64 d'un buffer binaire (btoa ne prend qu'une chaîne « binaire »). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // évite le dépassement de pile sur les gros buffers
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Consigne du lecteur d'ambiance : rôle de chaque couleur de la DA. */
export function buildMoodboardPrompt(
  bibleTitle: string,
  boardTitle: string,
  note: string | null,
): string {
  return [
    `Tu analyses un tableau de références graphiques pour l'univers « ${bibleTitle} ».`,
    `Titre du tableau : « ${boardTitle} ».`,
    note ? `Intention de l'auteur : ${note}` : null,
    "",
    "Regarde les images ensemble, comme un tout, et non une par une.",
    "",
    "1. Rédige `analysis_md` : ce que ces images disent de l'univers — lumière,",
    "matières, échelle, époque, niveau de technologie ou de magie, émotion",
    "dominante, et ce que cela implique pour la narration d'une session de jeu.",
    "Markdown simple (paragraphes, éventuellement une liste courte), 150 à 300 mots.",
    "Pas de titre de niveau 1. Français.",
    "",
    "2. Propose 2 ou 3 palettes dans `palettes`, chacune tirée des images (couleurs",
    "réellement présentes ou leur prolongement naturel), et non d'un thème générique.",
    "Chaque palette porte huit couleurs, dont voici le rôle exact :",
    "- `void` : fond de page. Toujours très sombre.",
    "- `nebula` : fond des panneaux, un cran plus clair que `void`.",
    "- `arcane` : couleur d'identité, celle des boutons et accents principaux.",
    "- `spirit` : couleur du vivant — liens, titres, narration en cours. Contrastée avec `void`.",
    "- `ember` : couleur du danger et de l'urgence. Chaude.",
    "- `parchment` : couleur du texte courant. Claire, très lisible sur `void`.",
    "- `parchment_dim` : texte secondaire, plus discret mais encore lisible.",
    "- `line` : bordures et séparateurs, entre `nebula` et `arcane`.",
    "",
    "Toutes les couleurs au format hexadécimal #rrggbb.",
    "Donne à chaque palette un nom court et évocateur, et une ligne d'ambiance.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Lit le tableau et renvoie l'analyse + les palettes.
 * Lève `moodboard_*` en cas de refus, de JSON invalide ou de forme inattendue.
 */
export async function analyzeMoodboard(
  apiKey: string,
  bibleTitle: string,
  boardTitle: string,
  note: string | null,
  images: VisionImage[],
): Promise<MoodboardAnalysis> {
  const client = new Anthropic({ apiKey });

  const content: Anthropic.ContentBlockParam[] = [];
  let budget = MAX_ANALYZED_BYTES;
  for (const image of images.slice(0, MAX_ANALYZED_IMAGES)) {
    if (image.bytes.byteLength > budget) break;
    budget -= image.bytes.byteLength;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: toBase64(image.bytes),
      },
    });
  }
  if (content.length === 0) throw new Error("moodboard_images_too_large");
  content.push({
    type: "text",
    text: buildMoodboardPrompt(bibleTitle, boardTitle, note),
  });

  // Streaming, comme l'analyse de richesse : un appel long non streamé se fait
  // couper par le runtime Workers avant même le catch de l'appelant.
  const stream = client.messages.stream({
    model: MOODBOARD_MODEL,
    // La réflexion adaptive est comptée dans ce budget et précède le JSON :
    // trop bas, la sortie est tronquée en plein objet (cf. richness/analyze).
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: MOODBOARD_OUTPUT_SCHEMA },
    },
    messages: [{ role: "user", content }],
  });

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("moodboard_bad_api_key");
    }
    // 400 de l'API (requête trop lourde, image refusée) : le message porte la
    // raison, sans quoi l'échec est indiscernable d'un problème de réseau.
    if (err instanceof Anthropic.APIError) {
      throw new Error(`moodboard_api_error (${err.status}: ${err.message})`);
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new Error("moodboard_refused");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("moodboard_truncated");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `moodboard_invalid_json (stop=${response.stop_reason}, len=${text.length})`,
    );
  }

  const result = parseAnalysisPayload(payload);
  if (!result) {
    throw new Error(
      `moodboard_invalid_payload (${describeAnalysisPayload(payload)})`,
    );
  }
  return result;
}
