// RAG bible (M6) — couche bindings : embeddings Workers AI (bge-m3) et
// index Vectorize. Tout est défensif : bindings absents, index vide ou
// erreur réseau → null, et l'appelant retombe sur la bible tronquée.

import type { Env } from "../env";
import {
  assembleExcerpts,
  buildRagQuery,
  chunkCanon,
  needsRag,
  QUERY_K,
  rerankMatches,
  type RagHints,
  type RagMatch,
} from "./logic";

// Multilingue (français inclus), 1024 dimensions — l'index Vectorize doit
// être créé en cosine/1024 : wrangler vectorize create loreforge-bible
//   --dimensions=1024 --metric=cosine
const EMBED_MODEL = "@cf/baai/bge-m3";
// Limite du modèle : 60k tokens PAR APPEL, tous textes confondus, avec un
// tokenizer ~1,6 car/token en français accentué → 20 chunks de ~2800 chars
// ≈ 35k tokens, marge confortable (constaté en prod : 50 chunks → 87k).
const EMBED_BATCH = 20;

interface RagMeta {
  count: number;
  chars: number;
  indexed_at: number;
}

function ragKvKey(bibleId: string): string {
  return `rag:${bibleId}:meta`;
}

export function ragAvailable(env: Env): boolean {
  return Boolean(env.AI && env.VECTORIZE);
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = (await env.AI!.run(EMBED_MODEL, { text: batch })) as {
      data?: number[][];
    };
    if (!res.data || res.data.length !== batch.length) {
      throw new Error("embedding_failed");
    }
    out.push(...res.data);
  }
  return out;
}

/**
 * (Ré)indexe une bible dans Vectorize. No-op sous le seuil RAG (et purge
 * un éventuel index devenu inutile). Pensé pour waitUntil : ne jette pas.
 */
export async function reindexBible(
  env: Env,
  bibleId: string,
  canonMd: string,
): Promise<void> {
  if (!ragAvailable(env)) return;
  try {
    const key = ragKvKey(bibleId);
    const previous = await env.CACHE.get<RagMeta>(key, "json");

    if (!needsRag(canonMd)) {
      if (previous) {
        await deleteVectors(env, bibleId, previous.count);
        await env.CACHE.delete(key);
      }
      return;
    }

    const chunks = chunkCanon(canonMd);
    const vectors = await embed(env, chunks.map((c) => c.text));

    if (previous && previous.count > chunks.length) {
      await deleteVectors(env, bibleId, previous.count, chunks.length);
    }
    // Upsert par lots (limite Vectorize ~1000 vecteurs par appel).
    const toUpsert = chunks.map((c, i) => ({
      id: `${bibleId}:${c.index}`,
      values: vectors[i],
      metadata: { bible_id: bibleId, index: c.index, section: c.section },
    }));
    for (let i = 0; i < toUpsert.length; i += 500) {
      await env.VECTORIZE!.upsert(toUpsert.slice(i, i + 500));
    }
    await env.CACHE.put(
      key,
      JSON.stringify({
        count: chunks.length,
        chars: canonMd.length,
        indexed_at: Date.now(),
      } satisfies RagMeta),
    );
    console.log(`[rag] ${bibleId} indexée : ${chunks.length} chunks`);
  } catch (err) {
    console.error(`[rag] réindexation échouée pour ${bibleId}:`, err);
  }
}

/** Purge l'index Vectorize et la méta KV d'une bible supprimée. Ne jette pas. */
export async function purgeBibleIndex(env: Env, bibleId: string): Promise<void> {
  if (!ragAvailable(env)) return;
  try {
    const key = ragKvKey(bibleId);
    const meta = await env.CACHE.get<RagMeta>(key, "json");
    if (meta) {
      await deleteVectors(env, bibleId, meta.count);
      await env.CACHE.delete(key);
    }
  } catch (err) {
    console.error(`[rag] purge échouée pour ${bibleId}:`, err);
  }
}

async function deleteVectors(
  env: Env,
  bibleId: string,
  count: number,
  from = 0,
): Promise<void> {
  const ids: string[] = [];
  for (let i = from; i < count; i++) ids.push(`${bibleId}:${i}`);
  for (let i = 0; i < ids.length; i += 500) {
    await env.VECTORIZE!.deleteByIds(ids.slice(i, i + 500));
  }
}

/**
 * Extraits pertinents du canon pour un tour (top-6 re-rankés, SPEC §2).
 * Renvoie null si le RAG n'est pas exploitable (bindings absents, index
 * jamais construit ou périmé) — l'appelant tronque alors la bible ; si
 * l'index est périmé, une réindexation part en tâche de fond.
 */
export async function retrieveCanonExcerpts(
  env: Env,
  bibleId: string,
  canonMd: string,
  queryText: string,
  hints: RagHints,
  scheduleReindex?: (p: Promise<void>) => void,
): Promise<string | null> {
  if (!ragAvailable(env) || !needsRag(canonMd)) return null;
  try {
    const meta = await env.CACHE.get<RagMeta>(ragKvKey(bibleId), "json");
    if (!meta || meta.chars !== canonMd.length) {
      // Index absent ou plus au niveau du canon : on répare pour la suite.
      if (scheduleReindex) scheduleReindex(reindexBible(env, bibleId, canonMd));
      return null;
    }

    const [vector] = await embed(env, [buildRagQuery(queryText, hints)]);
    const result = await env.VECTORIZE!.query(vector, {
      topK: QUERY_K,
      filter: { bible_id: bibleId },
      returnMetadata: true,
    });
    if (!result.matches.length) return null;

    const chunks = chunkCanon(canonMd);
    const matches: RagMatch[] = result.matches.map((m) => ({
      index: Number((m.metadata as { index?: unknown })?.index ?? -1),
      score: m.score,
      section: String((m.metadata as { section?: unknown })?.section ?? ""),
    })).filter((m) => m.index >= 0 && m.index < chunks.length);
    if (!matches.length) return null;

    const kept = rerankMatches(matches, chunks, hints);
    console.log(`[rag] ${bibleId} : ${kept.length} extraits servis au MJ`);
    return assembleExcerpts(chunks, kept);
  } catch (err) {
    console.error(`[rag] récupération échouée pour ${bibleId}:`, err);
    return null;
  }
}
