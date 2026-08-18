// Résolution des fiches lore (§7) : à partir d'un terme cliqué en jeu, on
// rédige une fiche courte POUR LE JOUEUR. Un seul chemin de génération, quelle
// que soit la source — canon riche, canon pauvre ou pure invention de session :
// on rassemble ici la matière première (extraits de bible + ce qui a été narré
// sur le terme dans CETTE session), et un appel IA dédié en fait de la prose.
// Rien de ce qui est extrait ici n'est affiché tel quel au joueur.

export type LoreKind = "personnage" | "faction" | "lieu" | "concept";

const KINDS: LoreKind[] = ["personnage", "faction", "lieu", "concept"];

export interface LoreFiche {
  term: string;
  kind: LoreKind;
  definition: string;
  /** Vrai si la bible parle du terme (→ lien « Voir dans la bible »). */
  in_canon: boolean;
}

/** Invention loggée en session (même forme que dans le Durable Object). */
export interface SessionInvention {
  axis: string;
  content: string;
  turn: number;
}

/** Matière première d'une fiche : extraits bruts, jamais affichés au joueur. */
export interface LoreSources {
  canon: string[];
  session: string[];
}

// Budgets d'extraction : assez pour situer le terme, pas de quoi recopier un
// chapitre entier dans le prompt.
const MAX_CANON_CHARS = 1800;
const MAX_SESSION_CHARS = 1600;
const MAX_SESSION_EXCERPTS = 4;
/** Longueur maximale de la fiche rendue (2-4 phrases de prose). */
const MAX_DEF = 700;

export function normalizeKind(kind: string | null | undefined): LoreKind {
  const k = (kind ?? "").toLowerCase().trim();
  return (KINDS as string[]).includes(k) ? (k as LoreKind) : "concept";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(term: string): RegExp {
  return new RegExp(escapeRegExp(term), "i");
}

/** Découpe un texte en phrases (naïf mais suffisant pour un extrait). */
function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…]+[.!?…]+|\S[^.!?…]*$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

/** Coupe sur une frontière de phrase, sinon de mot. */
function clamp(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastStop = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("… "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

/** Fenêtre de phrases autour de la 1re mention du terme. */
function around(text: string, term: string, before = 1, after = 2): string {
  const sents = sentences(text);
  const re = mentions(term);
  const idx = sents.findIndex((s) => re.test(s));
  const start = Math.max(0, (idx < 0 ? 0 : idx) - before);
  return sents.slice(start, start + before + after + 1).join(" ").trim();
}

function pushUnique(out: string[], value: string): void {
  const v = value.trim();
  if (v && !out.includes(v)) out.push(v);
}

function totalChars(list: string[]): number {
  return list.reduce((n, s) => n + s.length, 0);
}

/** Garde les premiers extraits dans un budget de caractères. */
function withinBudget(items: string[], budget: number): string[] {
  const kept: string[] = [];
  for (const e of items) {
    if (totalChars(kept) + e.length > budget) {
      const room = budget - totalChars(kept);
      if (room > 120) kept.push(clamp(e, room));
      break;
    }
    kept.push(e);
  }
  return kept;
}

/** Ligne de séparation d'un tableau Markdown (`---|:---:|---`). */
function isTableRule(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);
}

/**
 * Extraits du canon Markdown parlant du terme : section dont le titre le porte,
 * lignes de tableau le citant (avec leur en-tête pour que l'IA sache lire les
 * colonnes), puis paragraphes le mentionnant. Sortie brute — elle n'alimente
 * que le prompt, jamais directement le popup.
 */
export function collectCanonSources(canonMd: string, term: string): string[] {
  const clean = term.trim();
  const out: string[] = [];
  if (!clean || !canonMd) return out;
  const re = mentions(clean);
  const lines = canonMd.split(/\r?\n/);

  // 1) Sections dont le titre porte le terme (titre inclus : il porte du sens).
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h && re.test(h[1])) {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !/^#{1,6}\s+/.test(lines[j]); j++) {
        body.push(lines[j]);
      }
      pushUnique(out, `${h[1].trim()}\n${body.join("\n").trim()}`.trim());
    }
  }

  // 2) Lignes de tableau citant le terme, précédées de leur ligne d'en-tête.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|") || !re.test(line) || isTableRule(line)) continue;
    let header = "";
    for (let j = i - 1; j >= 0 && j >= i - 12; j--) {
      if (!lines[j].includes("|")) break;
      if (isTableRule(lines[j]) && j - 1 >= 0) {
        header = lines[j - 1].trim();
        break;
      }
    }
    pushUnique(out, (header ? header + "\n" : "") + line.trim());
  }

  // 3) Paragraphes mentionnant le terme.
  for (const p of canonMd.split(/\n\s*\n/)) {
    const body = p.trim();
    if (!body || body.includes("|") || !re.test(body)) continue;
    pushUnique(out, around(body.replace(/^#{1,6}\s+/gm, ""), clean, 0, 3));
  }

  return withinBudget(out, MAX_CANON_CHARS);
}

/**
 * Ce que la session a montré du terme : passages de narration et inventions
 * loggées le mentionnant, du plus récent au plus ancien. C'est cette matière
 * qui sauve les termes absents du canon (apparus en pleine scène).
 */
export function collectSessionSources(
  inventions: SessionInvention[],
  narration: string[],
  term: string,
): string[] {
  const clean = term.trim();
  const out: string[] = [];
  if (!clean) return out;
  const re = mentions(clean);

  for (let i = narration.length - 1; i >= 0 && out.length < MAX_SESSION_EXCERPTS; i--) {
    const text = narration[i];
    if (text && re.test(text)) pushUnique(out, around(text, clean, 1, 2));
  }
  for (let i = inventions.length - 1; i >= 0 && out.length < MAX_SESSION_EXCERPTS; i--) {
    const inv = inventions[i];
    if (inv?.content && re.test(inv.content)) pushUnique(out, inv.content.trim());
  }

  return withinBudget(out, MAX_SESSION_CHARS);
}

export function collectLoreSources(
  canonMd: string,
  inventions: SessionInvention[],
  narration: string[],
  term: string,
): LoreSources {
  return {
    canon: collectCanonSources(canonMd, term),
    session: collectSessionSources(inventions, narration, term),
  };
}

/**
 * Empreinte des sources : clé de fraîcheur du cache. Si de nouveaux tours ont
 * mentionné ou développé le terme depuis la dernière génération, la signature
 * change et la fiche est régénérée avec le contexte enrichi.
 */
export function loreSignature(sources: LoreSources): string {
  // Extraits préfixés par leur longueur : deux découpages différents ne peuvent
  // pas produire la même chaîne.
  const payload = [...sources.canon, "--", ...sources.session]
    .map((s) => s.length + ":" + s)
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + "-" + payload.length.toString(36);
}

/** Prompt système dédié à la résolution de lore (distinct du prompt du MJ). */
export const LORE_SYSTEM_PROMPT = `Tu rédiges une fiche de lore courte pour un JOUEUR, pas pour un auteur.

Règles strictes :
- 2 à 4 phrases maximum, en prose continue. Jamais de markdown, de tableau, de
  liste, de titre ni de puce dans la sortie : uniquement des phrases.
- Ne recopie jamais le document source tel quel : tu reformules toujours. Les
  extraits de bible fournis sont des notes de production internes (tableaux,
  slots réservés, mentions « à développer ») et non du texte à afficher.
- Donne UNIQUEMENT ce que le joueur peut légitimement savoir à ce stade de la
  session : ce qui a été montré ou dit en jeu, ou du contexte public et
  générique du monde. Jamais un secret que l'intrigue n'a pas encore révélé.
- Si le terme vient d'apparaître en session et que le canon n'a presque rien
  dessus : NE DIS PAS « sera précisé plus tard », « à développer », « se
  précisera en jouant », ni aucun équivalent. Décris ce qui vient d'être montré
  — apparence, comportement, ce que le personnage a ressenti ou compris, ce que
  la scène laisse deviner — même si c'est mince. Un joueur veut du texte utile,
  jamais une case vide.
- Si le terme est un lieu, un objet ou une faction : situe-le par rapport à ce
  que le joueur connaît déjà, plutôt qu'une fiche encyclopédique complète
  recopiée du document source.
- Ne révèle jamais un rebondissement futur, un antagoniste caché, ni un lien
  narratif que le MJ prévoit d'introduire plus tard.
- Écris en français, au présent, sur le ton du monde. Pas de méta (« dans cette
  campagne », « le MJ », « la bible », « le document »), pas de préambule, pas
  de titre : réponds par la fiche seule.`;

function block(title: string, items: string[]): string {
  if (items.length === 0) return `${title} :\n(rien)`;
  return `${title} :\n` + items.map((e) => `- ${e}`).join("\n");
}

export function buildLoreUserMessage(input: {
  term: string;
  kind: LoreKind;
  sources: LoreSources;
  bibleTitle?: string | null;
  characterName?: string | null;
}): string {
  const { term, kind, sources } = input;
  const lines: Array<string | null> = [
    `Terme : ${term}`,
    `Nature supposée : ${kind}`,
    input.bibleTitle ? `Univers : ${input.bibleTitle}` : null,
    input.characterName ? `Personnage joué : ${input.characterName}` : null,
    "",
    block("Extraits du canon (notes internes, à reformuler)", sources.canon),
    "",
    block(
      "Ce qui a été narré sur ce terme dans CETTE session (du plus récent au plus ancien)",
      sources.session,
    ),
    "",
    sources.canon.length === 0 && sources.session.length === 0
      ? "Aucune source : appuie-toi sur ce que le nom évoque dans ce monde, sans rien inventer de structurant."
      : "Rédige la fiche.",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * Filet de sécurité : si le modèle glisse du markdown, une puce ou une ligne de
 * tableau, on ramène la sortie à de la prose. Aucun contenu brut ne doit
 * atteindre le popup.
 */
export function toProse(raw: string): string {
  let t = (raw ?? "").replace(/```[\s\S]*?```/g, " ");
  t = t
    .split(/\r?\n/)
    .filter((l) => !isTableRule(l))
    .map((l) =>
      l
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/\s*\|\s*/g, " — "),
    )
    .join(" ");
  t = t
    .replace(/\*\*|__|`|\*|_/g, "")
    .replace(/(?:\s*—\s*)+/g, " — ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?…])/g, "$1")
    .replace(/^[\s—]+|[\s—]+$/g, "")
    .trim();
  return clamp(t, MAX_DEF);
}

/** Assemble la fiche finale à partir du texte rédigé par l'IA. */
export function buildFiche(
  term: string,
  kind: string | null | undefined,
  sources: LoreSources,
  generated: string,
): LoreFiche {
  return {
    term: term.trim(),
    kind: normalizeKind(kind),
    definition: toProse(generated),
    in_canon: sources.canon.length > 0,
  };
}
