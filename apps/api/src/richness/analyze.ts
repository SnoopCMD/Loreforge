// Appel Anthropic pour l'Indice de Richesse : sortie JSON strict via
// structured outputs (output_config.format), validée par la logique pure.

import Anthropic from "@anthropic-ai/sdk";
import {
  buildRichnessPrompt,
  parseRichnessPayload,
  RICHNESS_OUTPUT_SCHEMA,
  type RichnessResult,
} from "./logic";

export const RICHNESS_MODEL = "claude-opus-4-8";

/** Tick de progression : volume déjà produit par le modèle. */
export interface RichnessProgress {
  output_chars: number;
}

export async function computeRichness(
  apiKey: string,
  canonMd: string,
  /** Annexe des tableaux de références (§8) ; vide s'il n'y en a pas. */
  moodboardAnnex = "",
  onProgress?: (p: RichnessProgress) => void,
): Promise<RichnessResult> {
  const client = new Anthropic({ apiKey });

  // En streaming : un appel non-streamé de plusieurs minutes (grosse bible)
  // se fait couper par le runtime Workers sans même passer par le catch de
  // l'appelant — le flux maintient la connexion active jusqu'au bout.
  // En streaming, la limite haute du modèle est sans risque de timeout : une
  // grosse bible produit beaucoup de réflexion (adaptive) AVANT le JSON, et
  // ces jetons comptent dans max_tokens — trop bas, la sortie est tronquée en
  // plein JSON et l'analyse échoue sans raison visible.
  const stream = client.messages.stream({
    model: RICHNESS_MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: {
      format: {
        type: "json_schema",
        schema: RICHNESS_OUTPUT_SCHEMA,
      },
    },
    messages: [
      { role: "user", content: buildRichnessPrompt(canonMd, moodboardAnnex) },
    ],
  });

  if (onProgress) {
    let chars = 0;
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_delta") {
        const delta = event.delta as { text?: string; thinking?: string };
        chars += (delta.text ?? delta.thinking ?? "").length;
        onProgress({ output_chars: chars });
      }
    });
  }

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    // Une clé révoquée/expirée ressemble sinon à n'importe quel autre échec :
    // on la nomme pour qu'elle soit lisible depuis l'interface.
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("richness_bad_api_key");
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new Error("richness_refused");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Diagnostic d'une seule repro : sans le stop_reason ni la taille, un échec
  // de parsing est indiscernable d'une troncature (cf. characters/ai.ts).
  if (response.stop_reason === "max_tokens") {
    throw new Error(`richness_truncated (len=${text.length})`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `richness_invalid_json (stop=${response.stop_reason}, len=${text.length})`,
    );
  }

  const result = parseRichnessPayload(payload);
  if (!result) {
    const keys =
      payload && typeof payload === "object"
        ? Object.keys(payload as object).join(",")
        : typeof payload;
    throw new Error(`richness_invalid_payload (keys=${keys})`);
  }
  return result;
}
