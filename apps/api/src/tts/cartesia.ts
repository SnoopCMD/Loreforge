// Synthèse vocale Cartesia, partagée par la route de proxy /api/tts (lecture
// d'un tour en direct) et par le Durable Object (récit d'acte, stocké en R2).
//
// La clé API ne quitte jamais le Worker : le navigateur ne parle qu'à nous.

import type { Env } from "../env";

const CARTESIA_BASE = "https://api.cartesia.ai";
const CARTESIA_VERSION = "2026-03-01";
const MODEL_ID = "sonic-3.5";
export const MAX_TTS_CHARS = 5000;

/** La voix est-elle utilisable ? Clé ET voix doivent être configurées. */
export function ttsConfigured(env: Env): boolean {
  return Boolean(env.CARTESIA_API_KEY && env.CARTESIA_VOICE_ID);
}

/**
 * Appelle Cartesia et renvoie la réponse brute (MP3 streamé). L'appelant
 * décide s'il la re-streame telle quelle ou s'il la matérialise pour R2.
 */
export async function synthesizeSpeech(
  env: Env,
  text: string,
): Promise<Response> {
  return fetch(`${CARTESIA_BASE}/tts/bytes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CARTESIA_API_KEY}`,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: MODEL_ID,
      transcript: text,
      language: "fr",
      voice: { mode: "id", id: env.CARTESIA_VOICE_ID },
      output_format: {
        container: "mp3",
        sample_rate: 44100,
        bit_rate: 128000,
      },
    }),
  });
}

/** Listing des voix (filtrable par langue) — sert à choisir un VOICE_ID. */
export async function listVoices(
  env: Env,
  language: string | undefined,
): Promise<Response> {
  const url = new URL(`${CARTESIA_BASE}/voices`);
  if (language) url.searchParams.set("language", language);
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${env.CARTESIA_API_KEY}`,
      "Cartesia-Version": CARTESIA_VERSION,
    },
  });
}

/** Clé R2 du récit audio d'un acte : une seule par acte, jamais réécrite. */
export function actAudioKey(sessionId: string, actIndex: number): string {
  return `acts/${sessionId}/${actIndex}.mp3`;
}
