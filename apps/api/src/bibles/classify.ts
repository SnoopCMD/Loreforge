// Classification du contenu d'une bible dans les sections de base (init de
// l'éditeur et migration des bibles existantes). Un appel IA répartit la prose
// existante dans les bonnes sections ; en cas d'échec, d'absence de clé, ou de
// bible volumineuse, un repli heuristique (titres H2 → sections) prend le
// relais. Le texte est préservé, jamais réécrit ni résumé.

import Anthropic from "@anthropic-ai/sdk";
import type { Axis } from "../richness/logic";
import type { BibleRow } from "./db";
import {
  BASE_SECTIONS,
  insertSections,
  listSections,
  regenerateCanon,
  type SectionRow,
} from "./sections";

const CLASSIFY_MODEL = "claude-sonnet-5";

export interface ClassifiedSection {
  title: string;
  content_md: string;
  is_base: boolean;
  axis: Axis | null;
}

// Le modèle ne renvoie qu'un PLAN (quel bloc H2 va dans quelle catégorie), pas
// le contenu : la sortie reste minuscule quelle que soit la taille de la bible.
// On réassemble le texte localement, sans jamais le faire ré-émettre au modèle
// (rapide, jamais tronqué, contenu préservé au caractère près).
const MAPPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assignments"],
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "target"],
        properties: {
          index: { type: "integer" },
          target: { type: "string", enum: [...BASE_SECTIONS.map((s) => s.key), "custom"] },
        },
      },
    },
  },
} as const;

const EXCERPT_CHARS = 240;

function buildMappingPrompt(blocks: Array<{ title: string; body: string }>): string {
  const cats = BASE_SECTIONS.map((s) => `- ${s.key} : ${s.title}`).join("\n");
  const list = blocks
    .map((b, i) => {
      const excerpt = b.body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
      return `[${i}] « ${b.title} » — ${excerpt || "(vide)"}`;
    })
    .join("\n");
  return `Tu réorganises la bible d'un univers de jeu de rôle. Voici des sections
existantes (index, titre, extrait). Classe CHAQUE section dans une catégorie.

Catégories de base :
${cats}
- custom : ne correspond à aucune des catégories ci-dessus (la section gardera
  son propre titre).

Sections :
${list}

Pour CHAQUE index, choisis une cible (une clé de base, ou "custom"). Ne juge que
d'après le sens du titre et de l'extrait. Réponds en JSON strict :
{ "assignments": [{ "index", "target" }] }.`;
}

/** Ordonne les sections de base (remplies ou vides) puis les personnalisées. */
function assemble(
  baseContent: Map<string, string>,
  custom: Array<{ title: string; content_md: string }>,
): ClassifiedSection[] {
  const out: ClassifiedSection[] = BASE_SECTIONS.map((tpl) => ({
    title: tpl.title,
    content_md: (baseContent.get(tpl.key) ?? "").trim(),
    is_base: true,
    axis: tpl.axis,
  }));
  for (const c of custom) {
    const title = (c.title ?? "").trim();
    const body = (c.content_md ?? "").trim();
    if (title === "" && body === "") continue;
    out.push({ title: title || "Section", content_md: body, is_base: false, axis: null });
  }
  return out;
}

/** Sections de base vides (bible sans contenu). */
export function emptyBaseSections(): ClassifiedSection[] {
  return assemble(new Map(), []);
}

// ── Repli heuristique (aucun appel IA) ─────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Mots-clés de titre → clé de section de base (premier match l'emporte).
const KEYWORDS: Record<string, string[]> = {
  intro: ["introduction", "pitch", "presentation", "resume", "synopsis", "apercu"],
  cosmology: ["cosmologie", "magie", "regle", "monde", "univers", "mythe", "divin"],
  chronology: ["chronologie", "histoire", "timeline", "epoque", "ere", "calendrier"],
  characters: ["personnage", "protagoniste", "heros", "pnj", "figure"],
  factions: ["faction", "organisation", "ordre", "guilde", "camp", "clan", "maison"],
  plots: ["trame", "conflit", "intrigue", "quete", "enjeu", "tension", "guerre"],
  geography: ["geographie", "lieu", "carte", "region", "cite", "ville", "territoire"],
  tone: ["ton", "style", "ambiance", "registre", "esthetique"],
};

function matchBaseKey(title: string, taken: Set<string>): string | null {
  const n = normalize(title);
  for (const key of Object.keys(KEYWORDS)) {
    if (taken.has(key)) continue;
    if (KEYWORDS[key].some((kw) => n.includes(kw))) return key;
  }
  return null;
}

/** Découpe le canon en { préambule, sections H2 } sans casser les fences. */
function splitH2(canonMd: string): { preamble: string; sections: Array<{ title: string; body: string[] }> } {
  const pre: string[] = [];
  const sections: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | null = null;
  let inFence = false;
  let seenH1 = false;
  for (const line of canonMd.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      if (!seenH1 && /^# .+/.test(line) && current === null) { seenH1 = true; continue; }
      const h2 = line.match(/^## (.*)$/);
      if (h2) {
        current = { title: h2[1].trim(), body: [] };
        sections.push(current);
        continue;
      }
    }
    (current ? current.body : pre).push(line);
  }
  return { preamble: pre.join("\n").trim(), sections };
}

export function heuristicClassify(canonMd: string): ClassifiedSection[] {
  const { preamble, sections } = splitH2(canonMd);
  const baseContent = new Map<string, string>();
  const taken = new Set<string>();
  const custom: Array<{ title: string; content_md: string }> = [];

  if (preamble) { baseContent.set("intro", preamble); taken.add("intro"); }

  for (const s of sections) {
    const body = s.body.join("\n").trim();
    const key = matchBaseKey(s.title, taken);
    if (key) {
      taken.add(key);
      // Conserve le titre d'origine s'il diffère (le corps garde son sens).
      baseContent.set(key, body);
    } else {
      custom.push({ title: s.title || "Section", content_md: body });
    }
  }
  return assemble(baseContent, custom);
}

// ── Classification IA (avec repli) ─────────────────────────────────────────

interface Block {
  title: string;
  body: string;
}

const KEY_TO_TITLE = new Map(BASE_SECTIONS.map((s) => [s.key, s.title]));

/** Repli sans IA : chaque bloc rejoint une base par mot-clé de titre, sinon custom. */
function heuristicBlocks(preamble: string, blocks: Block[]): ClassifiedSection[] {
  const baseContent = new Map<string, string>();
  const taken = new Set<string>();
  const custom: Array<{ title: string; content_md: string }> = [];
  if (preamble) { baseContent.set("intro", preamble); taken.add("intro"); }
  for (const b of blocks) {
    const key = matchBaseKey(b.title, taken);
    if (key) { taken.add(key); baseContent.set(key, b.body); }
    else custom.push({ title: b.title || "Section", content_md: b.body });
  }
  return assemble(baseContent, custom);
}

/**
 * Classe une liste de BLOCS (titre + corps) dans les sections via un PLAN IA
 * (bloc → catégorie). Le contenu est réassemblé localement, jamais réécrit.
 * Repli heuristique si pas de clé, aucun bloc, ou échec. Ne jette jamais.
 */
async function classifyBlocks(
  apiKey: string | undefined,
  preamble: string,
  blocks: Block[],
): Promise<ClassifiedSection[]> {
  if (!apiKey || blocks.length === 0) return heuristicBlocks(preamble, blocks);

  try {
    const client = new Anthropic({ apiKey });
    // Sortie minuscule (juste le plan) : un create non-streamé de quelques
    // secondes suffit, aucun risque de troncature ni d'éviction.
    const response = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 2048,
      output_config: {
        format: { type: "json_schema", schema: MAPPING_SCHEMA },
      },
      messages: [{ role: "user", content: buildMappingPrompt(blocks) }],
    });
    if (response.stop_reason === "refusal") throw new Error("classify_refused");
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const payload = JSON.parse(text) as {
      assignments?: Array<{ index?: unknown; target?: unknown }>;
    };

    const validKeys = new Set(BASE_SECTIONS.map((s) => s.key));
    const targetByIndex = new Map<number, string>();
    for (const a of payload.assignments ?? []) {
      if (typeof a?.index === "number" && typeof a?.target === "string") {
        targetByIndex.set(a.index, a.target);
      }
    }

    // Réassemblage LOCAL : on déplace les blocs, on ne réécrit rien.
    const baseContent = new Map<string, string>();
    const custom: Array<{ title: string; content_md: string }> = [];
    if (preamble) baseContent.set("intro", preamble);

    blocks.forEach((b, i) => {
      const target = targetByIndex.get(i);
      if (target && target !== "custom" && validKeys.has(target)) {
        // Conserve le titre d'origine en sous-section (### ) pour ne rien perdre
        // quand plusieurs blocs atterrissent dans la même base — sauf si le titre
        // du bloc est déjà celui de la section cible (pas de doublon).
        const sameTitle = b.title.trim() === (KEY_TO_TITLE.get(target) ?? "");
        const piece = sameTitle
          ? b.body
          : b.body
            ? `### ${b.title}\n\n${b.body}`
            : `### ${b.title}`;
        const prev = baseContent.get(target);
        baseContent.set(target, prev ? `${prev}\n\n${piece}` : piece);
      } else {
        custom.push({ title: b.title || "Section", content_md: b.body });
      }
    });

    return assemble(baseContent, custom);
  } catch (err) {
    console.error("[sections] classification IA échouée, repli heuristique :", err);
    return heuristicBlocks(preamble, blocks);
  }
}

/**
 * Répartit un canon (découpé en blocs H2) dans les sections. IA si possible,
 * heuristique sinon. Utilisé pour migrer un canon brut (import).
 */
export async function classifyCanon(
  apiKey: string | undefined,
  canonMd: string,
): Promise<ClassifiedSection[]> {
  const trimmed = canonMd.trim();
  if (trimmed === "") return emptyBaseSections();
  const { preamble, sections } = splitH2(canonMd);
  const blocks = sections.map((s) => ({ title: s.title, body: s.body.join("\n").trim() }));
  return classifyBlocks(apiKey, preamble, blocks);
}

/**
 * Répartit des SECTIONS existantes (répartition à la demande) : 1 section = 1
 * bloc, pas de re-découpage du canon — les sous-titres ### internes restent
 * intacts. Sections vides ignorées (les 8 bases sont toujours produites).
 */
export async function classifySections(
  apiKey: string | undefined,
  sections: Array<{ title: string; content_md: string }>,
): Promise<ClassifiedSection[]> {
  const blocks = sections
    .filter((s) => (s.content_md ?? "").trim() !== "")
    .map((s) => ({ title: s.title, body: s.content_md.trim() }));
  if (blocks.length === 0) return emptyBaseSections();
  return classifyBlocks(apiKey, "", blocks);
}

/**
 * Garantit que la bible a ses sections (init paresseuse partagée). Vide →
 * classifie le canon (IA si `useAi` et clé présente, heuristique sinon), insère
 * et régénère le canon. Ne réindexe pas (l'appelant s'en charge selon
 * `initialized`). Anti-course : re-liste avant d'insérer.
 */
export async function ensureSections(
  db: D1Database,
  bible: BibleRow,
  opts: { apiKey?: string; useAi: boolean },
): Promise<{ rows: SectionRow[]; initialized: boolean }> {
  let rows = await listSections(db, bible.id);
  if (rows.length) return { rows, initialized: false };

  const classified = opts.useAi
    ? await classifyCanon(opts.apiKey, bible.canon_md ?? "")
    : heuristicClassify(bible.canon_md ?? "");

  rows = await listSections(db, bible.id);
  if (rows.length) return { rows, initialized: false };

  await insertSections(db, bible.id, classified);
  await regenerateCanon(db, bible.id, bible.title);
  return { rows: await listSections(db, bible.id), initialized: true };
}
