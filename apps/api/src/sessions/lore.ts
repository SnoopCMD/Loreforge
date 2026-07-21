// Résolution des fiches lore (§7) : à partir d'un terme cliqué en jeu, on
// produit une définition courte SANS appel IA — extraction texte du canon,
// repli sur le log d'inventions de la session, puis repli générique pour
// qu'aucun terme ne reste « mort ». Logique pure, testable unitairement.

export type LoreKind = "personnage" | "faction" | "lieu" | "concept";

const KINDS: LoreKind[] = ["personnage", "faction", "lieu", "concept"];

export interface LoreFiche {
  term: string;
  kind: LoreKind;
  definition: string;
  /** Vrai si la définition vient de la bible (→ lien « Voir dans la bible »). */
  in_canon: boolean;
}

/** Invention loggée en session (même forme que dans le Durable Object). */
export interface SessionInvention {
  axis: string;
  content: string;
  turn: number;
}

const MAX_DEF = 360;

export function normalizeKind(kind: string | null | undefined): LoreKind {
  const k = (kind ?? "").toLowerCase().trim();
  return (KINDS as string[]).includes(k) ? (k as LoreKind) : "concept";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Coupe proprement à ~MAX_DEF caractères, sur une frontière de mot. */
function clamp(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_DEF) return t;
  const cut = t.slice(0, MAX_DEF);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_DEF * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

/** Découpe un texte en phrases (naïf mais suffisant pour une fiche courte). */
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

/** 2-3 phrases autour de la 1re mention du terme dans un paragraphe. */
function pickAround(paragraph: string, term: string): string {
  const sents = sentences(paragraph);
  const re = new RegExp(escapeRegExp(term), "i");
  const idx = sents.findIndex((s) => re.test(s));
  const start = idx < 0 ? 0 : idx;
  return clamp(sents.slice(start, start + 3).join(" "));
}

/**
 * Cherche une définition du terme dans le canon Markdown.
 * Priorité : une section (## Titre) dont le titre porte le terme → son corps ;
 * sinon le 1er paragraphe qui mentionne le terme. null si introuvable.
 */
export function defineFromCanon(
  canonMd: string,
  term: string,
): string | null {
  const clean = term.trim();
  if (!clean || !canonMd) return null;
  const re = new RegExp(escapeRegExp(clean), "i");
  const lines = canonMd.split(/\r?\n/);

  // 1) Section dont le titre contient le terme.
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
      const bodyText = body.join("\n").trim();
      if (bodyText) return clamp(pickAround(bodyText, clean) || bodyText);
    }
  }

  // 2) 1er paragraphe (bloc séparé par une ligne vide) mentionnant le terme.
  const paragraphs = canonMd.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const body = p.replace(/^#{1,6}\s+.*$/gm, "").trim();
    if (body && re.test(body)) return pickAround(body, clean);
  }
  return null;
}

/** Repli : une invention de la session mentionnant le terme (la plus récente). */
export function defineFromInventions(
  inventions: SessionInvention[],
  term: string,
): string | null {
  const clean = term.trim();
  if (!clean) return null;
  const re = new RegExp(escapeRegExp(clean), "i");
  for (let i = inventions.length - 1; i >= 0; i--) {
    const inv = inventions[i];
    if (inv.content && re.test(inv.content)) return clamp(inv.content);
  }
  return null;
}

/**
 * Fiche complète d'un terme : canon d'abord, sinon inventions de session,
 * sinon repli générique — jamais de terme sans définition.
 */
export function resolveLore(
  canonMd: string,
  inventions: SessionInvention[],
  term: string,
  kind?: string | null,
): LoreFiche {
  const clean = term.trim();
  const canonDef = defineFromCanon(canonMd, clean);
  if (canonDef) {
    return { term: clean, kind: normalizeKind(kind), definition: canonDef, in_canon: true };
  }
  const invDef = defineFromInventions(inventions, clean);
  if (invDef) {
    return { term: clean, kind: normalizeKind(kind), definition: invDef, in_canon: false };
  }
  return {
    term: clean,
    kind: normalizeKind(kind),
    definition: `« ${clean} » — élément introduit au fil de cette session ; sa définition se précisera en jouant.`,
    in_canon: false,
  };
}
