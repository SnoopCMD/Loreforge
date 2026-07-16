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

export async function computeRichness(
  apiKey: string,
  canonMd: string,
): Promise<RichnessResult> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
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
