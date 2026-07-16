// Normalisation Markdown -> canon_md : logique pure, sans dépendance
// à Hono, D1 ou R2 — testable unitairement (cf. SPEC §9, DoD M1).
//
// Objectif : produire un Markdown structuré et prévisible pour les étapes
// suivantes (scoring M2, chunking RAG M6) :
// - fins de ligne LF, sans BOM, sans espaces traînants
// - titres ATX uniformes (`# Titre`), setext convertis
// - exactement un H1 (le titre de la bible), les autres démotés en H2
// - une seule ligne vide entre blocs
// Les blocs de code (``` ou ~~~) sont laissés intacts.

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 Mo de Markdown brut

export const DEFAULT_TITLE = "Bible sans titre";

export interface NormalizedBible {
  title: string;
  canonMd: string;
}

/** Suit l'état ouvert/fermé des blocs de code au fil des lignes. */
class FenceTracker {
  private open = false;
  private marker = "";

  /** À appeler sur chaque ligne. Vrai si la ligne est un délimiteur de fence. */
  isDelimiter(line: string): boolean {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (!fence) return false;
    if (!this.open) {
      this.open = true;
      this.marker = fence[1][0];
    } else if (fence[1][0] === this.marker) {
      this.open = false;
    }
    return true;
  }

  get inFence(): boolean {
    return this.open;
  }
}

export function normalizeMarkdown(
  raw: string,
  fallbackTitle?: string,
): NormalizedBible {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  // Passe 1 : espaces traînants, setext -> ATX, ATX canonique.
  const lines: string[] = [];
  let fences = new FenceTracker();
  for (const sourceLine of text.split("\n")) {
    let line = sourceLine;
    if (fences.isDelimiter(line) || fences.inFence) {
      lines.push(line);
      continue;
    }

    line = line.replace(/\s+$/, "");

    // Setext -> ATX : la ligne `===`/`---` "consomme" la ligne précédente.
    const prev = lines.length > 0 ? lines[lines.length - 1] : "";
    const isSetext =
      prev.trim() !== "" && !/^#/.test(prev) && /^\s*(=+|-{2,})\s*$/.test(line);
    if (isSetext) {
      const level = line.trim().startsWith("=") ? "#" : "##";
      lines[lines.length - 1] = `${level} ${prev.trim()}`;
      continue;
    }

    // ATX : espacement canonique, suppression des # de fermeture.
    const atx = line.match(/^\s*(#{1,6})\s*(.*?)\s*#*\s*$/);
    if (atx && atx[2] !== "") {
      line = `${atx[1]} ${atx[2]}`;
    }

    lines.push(line);
  }

  // Passe 2 : un seul H1 — le premier devient le titre, les suivants en H2.
  let title: string | null = null;
  fences = new FenceTracker();
  for (let i = 0; i < lines.length; i++) {
    if (fences.isDelimiter(lines[i]) || fences.inFence) continue;
    const h1 = lines[i].match(/^# (.+)$/);
    if (!h1) continue;
    if (title === null) {
      title = h1[1];
    } else {
      lines[i] = `## ${h1[1]}`;
    }
  }

  // Passe 3 : jamais deux lignes vides consécutives (hors blocs de code),
  // ni en tête ni en queue.
  const compact: string[] = [];
  fences = new FenceTracker();
  for (const line of lines) {
    fences.isDelimiter(line);
    if (
      !fences.inFence &&
      line === "" &&
      (compact.length === 0 || compact[compact.length - 1] === "")
    ) {
      continue;
    }
    compact.push(line);
  }
  while (compact.length > 0 && compact[compact.length - 1] === "") compact.pop();

  if (title === null) {
    title = (fallbackTitle ?? "").trim() || DEFAULT_TITLE;
    compact.unshift(`# ${title}`, "");
  }

  return { title, canonMd: compact.join("\n") + "\n" };
}

/** Vrai si le contenu ressemble à du Markdown exploitable (non vide hors espaces). */
export function isUsableMarkdown(raw: string): boolean {
  return raw.trim().length > 0;
}

/**
 * Valide un tone_profile fourni par le client et le renvoie sérialisé,
 * ou null si invalide. Accepte un objet JSON ou une chaîne JSON d'objet.
 */
export function serializeToneProfile(input: unknown): string | null {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return JSON.stringify(value);
}
