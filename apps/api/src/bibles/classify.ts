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
// Au-delà, on ne renvoie pas toute la bible au modèle (coût/latence) : le repli
// heuristique redistribue par titres sans appel IA.
const MAX_CLASSIFY_CHARS = 40_000;

export interface ClassifiedSection {
  title: string;
  content_md: string;
  is_base: boolean;
  axis: Axis | null;
}

const CLASSIFY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["base", "custom"],
  properties: {
    base: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "content_md"],
        properties: {
          key: { type: "string" },
          content_md: { type: "string" },
        },
      },
    },
    custom: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "content_md"],
        properties: {
          title: { type: "string" },
          content_md: { type: "string" },
        },
      },
    },
  },
} as const;

function buildClassifyPrompt(canonMd: string): string {
  const list = BASE_SECTIONS.map((s) => `- ${s.key} : « ${s.title} »`).join("\n");
  return `Tu réorganises la bible d'un univers de jeu de rôle dans des sections
prédéfinies. Voici les sections de base (clé : intitulé) :
${list}

Consignes :
- Répartis TOUT le contenu ci-dessous dans ces sections, sans rien perdre.
- PRÉSERVE le texte tel quel (Markdown) : ne réécris pas, ne résume pas, ne
  paraphrase pas. Découpe et déplace, c'est tout.
- Un passage qui ne correspond à aucune section de base va dans "custom" avec un
  titre court et clair.
- Laisse content_md vide ("") pour une section de base sans contenu pertinent.

Contenu de la bible :
---
${canonMd}
---

Réponds en JSON strict : { "base": [{ "key", "content_md" }], "custom": [{ "title", "content_md" }] }.`;
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

/**
 * Répartit `canonMd` dans les sections. IA si possible (clé présente, bible pas
 * trop grosse), repli heuristique sinon. Ne jette jamais : renvoie toujours au
 * moins les 8 sections de base.
 */
export async function classifyCanon(
  apiKey: string | undefined,
  canonMd: string,
): Promise<ClassifiedSection[]> {
  const trimmed = canonMd.trim();
  if (trimmed === "") return emptyBaseSections();
  if (!apiKey || trimmed.length > MAX_CLASSIFY_CHARS) {
    return heuristicClassify(canonMd);
  }

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: CLASSIFY_MODEL,
      max_tokens: 16000,
      output_config: {
        format: { type: "json_schema", schema: CLASSIFY_OUTPUT_SCHEMA },
      },
      messages: [{ role: "user", content: buildClassifyPrompt(canonMd) }],
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error("classify_refused");

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const payload = JSON.parse(text) as {
      base?: Array<{ key?: unknown; content_md?: unknown }>;
      custom?: Array<{ title?: unknown; content_md?: unknown }>;
    };

    const validKeys = new Set(BASE_SECTIONS.map((s) => s.key));
    const baseContent = new Map<string, string>();
    for (const b of payload.base ?? []) {
      if (typeof b?.key === "string" && validKeys.has(b.key) && typeof b.content_md === "string") {
        // Concatène si le modèle répète une clé.
        const prev = baseContent.get(b.key);
        baseContent.set(b.key, prev ? `${prev}\n\n${b.content_md}` : b.content_md);
      }
    }
    const custom = (payload.custom ?? [])
      .filter((c) => typeof c?.content_md === "string")
      .map((c) => ({
        title: typeof c.title === "string" ? c.title : "Section",
        content_md: c.content_md as string,
      }));

    return assemble(baseContent, custom);
  } catch (err) {
    console.error("[sections] classification IA échouée, repli heuristique :", err);
    return heuristicClassify(canonMd);
  }
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
