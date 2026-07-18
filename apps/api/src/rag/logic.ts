// RAG bible (SPEC §2, M6) — logique pure, testée unitairement : seuil,
// chunking par section, re-ranking par métadonnées. Le texte des chunks
// n'est jamais dupliqué dans Vectorize : le chunking est déterministe, on
// n'y stocke que les index et on re-découpe le canon au moment du prompt.

// ~30k tokens (français ≈ 3,3 car/token). En dessous : bible entière.
export const RAG_THRESHOLD_CHARS = 100_000;
// ~800 tokens par chunk, ~100 tokens de recouvrement (SPEC §2).
export const CHUNK_CHARS = 2_800;
export const CHUNK_OVERLAP_CHARS = 350;
export const TOP_K = 6;
// On sur-échantillonne avant re-ranking par métadonnées.
export const QUERY_K = 12;

export interface CanonChunk {
  index: number;
  /** Dernier titre Markdown rencontré (fil d'Ariane court). */
  section: string;
  text: string;
}

export function needsRag(canonMd: string): boolean {
  return canonMd.length > RAG_THRESHOLD_CHARS;
}

/**
 * Découpe le canon en chunks d'environ CHUNK_CHARS, à la ligne près, sans
 * jamais couper un titre de sa première ligne de contenu. Chaque chunk
 * démarre par un rappel de sa section et recouvre la fin du précédent.
 * Déterministe : mêmes entrées → mêmes chunks (les index stockés dans
 * Vectorize restent valides tant que le canon n'a pas changé).
 */
export function chunkCanon(canonMd: string): CanonChunk[] {
  const lines = canonMd.split(/\r?\n/);
  const chunks: CanonChunk[] = [];
  let section = "";
  let currentSection = "";
  let buf: string[] = [];
  let size = 0;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text !== "") {
      chunks.push({ index: chunks.length, section: currentSection, text });
    }
    // Recouvrement : on repart avec la fin du chunk précédent.
    const overlap: string[] = [];
    let overlapSize = 0;
    for (let i = buf.length - 1; i >= 0 && overlapSize < CHUNK_OVERLAP_CHARS; i--) {
      overlap.unshift(buf[i]);
      overlapSize += buf[i].length + 1;
    }
    buf = overlap;
    size = overlapSize;
    currentSection = section;
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.*)/);
    if (heading) {
      section = heading[1].trim();
      if (buf.length === 0) currentSection = section;
    }
    if (size + line.length > CHUNK_CHARS && buf.some((l) => l.trim() !== "")) {
      flush();
    }
    buf.push(line);
    size += line.length + 1;
  }
  const text = buf.join("\n").trim();
  if (text !== "") {
    chunks.push({ index: chunks.length, section: currentSection, text });
  }
  return chunks;
}

export interface RagHints {
  trame: string | null;
  /** Personnage joueur et PNJ en scène. */
  names: string[];
}

export interface RagMatch {
  index: number;
  score: number;
  section: string;
}

/** Mots significatifs (≥ 4 lettres) d'une expression, minuscules. */
function keywords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}0-9]+/u)
    .filter((w) => w.length >= 4);
}

/**
 * Re-ranking par métadonnées (SPEC §2) : le score vectoriel est dopé quand
 * la section ou le chunk parlent de la trame active ou des personnages en
 * scène. Renvoie les index retenus, ordonnés par position dans le canon
 * (le prompt lit la bible dans l'ordre).
 */
export function rerankMatches(
  matches: RagMatch[],
  chunks: CanonChunk[],
  hints: RagHints,
  topK = TOP_K,
): number[] {
  const trameWords = hints.trame ? keywords(hints.trame) : [];
  const nameWords = hints.names.flatMap(keywords);

  const boosted = matches.map((m) => {
    const chunk = chunks[m.index];
    const haystack = chunk
      ? (chunk.section + "\n" + chunk.text).toLowerCase()
      : m.section.toLowerCase();
    let boost = 0;
    if (trameWords.some((w) => haystack.includes(w))) boost += 0.08;
    if (nameWords.some((w) => haystack.includes(w))) boost += 0.08;
    return { index: m.index, score: m.score + boost };
  });

  const seen = new Set<number>();
  const kept: number[] = [];
  for (const m of boosted.sort((a, b) => b.score - a.score)) {
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    kept.push(m.index);
    if (kept.length >= topK) break;
  }
  return kept.sort((a, b) => a - b);
}

/** Assemble les extraits retenus, section rappelée en tête de chaque bloc. */
export function assembleExcerpts(
  chunks: CanonChunk[],
  indexes: number[],
): string {
  return indexes
    .map((i) => chunks[i])
    .filter(Boolean)
    .map((c) => `[Extrait — ${c.section || "début de la bible"}]\n${c.text}`)
    .join("\n\n[...]\n\n");
}

/** Texte embarqué pour la requête : action du joueur + contexte de partie. */
export function buildRagQuery(
  playerText: string,
  hints: RagHints,
): string {
  const parts = [playerText.slice(0, 1000)];
  if (hints.trame) parts.push(`Trame : ${hints.trame}`);
  if (hints.names.length) parts.push(`Personnages : ${hints.names.join(", ")}`);
  return parts.join("\n");
}
