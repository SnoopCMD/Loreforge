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
  onProgress?: (p: RichnessProgress) => void,
): Promise<RichnessResult> {
  const client = new Anthropic({ apiKey });

  // En streaming : un appel non-streamé de plusieurs minutes (grosse bible)
  // se fait couper par le runtime Workers sans même passer par le catch de
  // l'appelant — le flux maintient la connexion active jusqu'au bout.
  const stream = client.messages.stream({
    model: RICHNESS_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      format: {
        type: "json_schema",
        schema: RICHNESS_OUTPUT_SCHEMA,
      },
    },
    messages: [{ role: "user", content: buildRichnessPrompt(canonMd) }],
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

  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new Error("richness_refused");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("richness_invalid_json");
  }

  const result = parseRichnessPayload(payload);
  if (!result) throw new Error("richness_invalid_payload");
  return result;
}
