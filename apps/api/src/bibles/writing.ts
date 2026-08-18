// Session d'écriture assistée : la discussion avec l'IA autour d'une bible, et
// la transformation du fil en entrées prêtes à rejoindre les sections.
//
// Deux temps, deux appels de nature différente :
//  1. la discussion — streamée, ton d'atelier, l'IA questionne et reformule ;
//  2. l'intégration — sortie JSON stricte, un bloc par section visée.
// Rien n'est écrit dans la bible ici : l'écriture reste le fait des routes,
// après validation de l'auteur.

import Anthropic from "@anthropic-ai/sdk";
import type { SectionRow } from "./sections";

/** Discussion : réponses courtes et nombreuses — un modèle réactif. */
export const WRITING_MODEL = "claude-sonnet-5";
/** Intégration : reformulation fidèle, sortie structurée. */
export const INTEGRATION_MODEL = "claude-sonnet-5";

export const MAX_WRITING_TOKENS = 2048;
export const MAX_INTEGRATION_TOKENS = 8192;

/** Le canon peut être volumineux : on borne ce qui part au modèle. */
const MAX_CANON_CHARS = 40_000;
/** Extrait de section montré dans le sommaire (repérage, pas relecture). */
const MAX_SECTION_EXCERPT = 300;
/** Tours envoyés au modèle (le fil complet, lui, reste en base). */
export const MAX_HISTORY_MESSAGES = 40;

export interface WritingMessage {
  role: "user" | "assistant";
  content: string;
}

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + "\n\n[… tronqué …]" : t;
}

/**
 * Sommaire des sections destiné au modèle : l'identifiant est repris tel quel
 * dans les entrées d'intégration, c'est lui qui décide où le texte atterrit.
 */
export function describeSections(sections: SectionRow[]): string {
  if (sections.length === 0) return "(aucune section — tout est à créer)";
  return sections
    .map((s) => {
      const body = s.content_md.trim();
      const excerpt =
        body === ""
          ? "(vide)"
          : body.slice(0, MAX_SECTION_EXCERPT).replace(/\s+/g, " ") +
            (body.length > MAX_SECTION_EXCERPT ? "…" : "");
      const kind = s.kind === "folder" ? " [dossier]" : "";
      return `- [${s.id}] « ${s.title} »${kind} : ${excerpt}`;
    })
    .join("\n");
}

/** Consigne permanente de l'atelier : creuser, puis rendre écrivable. */
export function buildWritingSystem(
  bibleTitle: string,
  canonMd: string,
  sections: SectionRow[],
): string {
  return `Tu es le partenaire d'écriture de l'auteur de l'univers « ${bibleTitle} ».
Vous êtes en session d'écriture : un atelier, pas une narration de jeu.

L'auteur arrive avec des idées en vrac — notes jetées, intuitions, fragments,
questions. Ton rôle :
- ACCUEILLIR le vrac sans le corriger d'emblée : reformule d'abord ce que tu as
  compris, en une ou deux phrases, pour qu'il valide.
- CREUSER : pose une ou deux questions à la fois, jamais une liste. Les bonnes
  questions sont concrètes (qui, où, depuis quand, à quel prix) et visent ce
  qui manque pour que l'idée devienne jouable.
- RELIER au canon existant : signale ce que l'idée confirme, complète ou
  contredit. Une contradiction se dit franchement, en citant le canon.
- PROPOSER : quand une idée tient debout, écris-en la version « bible » —
  concrète, sans méta, sans référence à votre discussion — dans un bloc de
  citation Markdown (>) pour qu'elle se repère d'un coup d'œil.

Reste bref (150 mots au plus, sauf quand l'auteur demande un texte long) et
écris en français. Ne prétends jamais avoir modifié la bible : c'est l'auteur
qui déclenche l'intégration, à la fin, et qui valide chaque bloc.

Sections de la bible (identifiant entre crochets) :
${describeSections(sections)}

Canon actuel :
---
${clamp(canonMd, MAX_CANON_CHARS)}
---`;
}

/**
 * Discussion streamée. Renvoie le flux brut du SDK : l'appelant assemble le
 * texte et le persiste (voir writing-routes).
 */
export function streamWritingReply(
  apiKey: string,
  system: string,
  messages: WritingMessage[],
): Promise<AsyncIterable<Anthropic.MessageStreamEvent>> {
  const client = new Anthropic({ apiKey });
  return client.messages.create({
    model: WRITING_MODEL,
    max_tokens: MAX_WRITING_TOKENS,
    system: [{ type: "text", text: system }],
    messages: messages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    stream: true,
  });
}

// ── Intégration : le fil devient des entrées de bible ─────────────────────

/** Une entrée prête à rejoindre la bible, telle que proposée à l'auteur. */
export interface WritingEntry {
  /** Section visée ; "" = nouvelle section (le titre fait foi). */
  section_id: string;
  /** Titre de la section visée, ou de celle à créer. */
  title: string;
  content_md: string;
}

export interface WritingIntegration {
  summary: string;
  entries: WritingEntry[];
}

/** Au-delà, l'auteur ne relit plus rien : l'intégration doit rester tranchable. */
export const MAX_ENTRIES = 12;

const INTEGRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "entries"],
  properties: {
    summary: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section_id", "title", "content_md"],
        properties: {
          section_id: { type: "string" },
          title: { type: "string" },
          content_md: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Valide la sortie d'intégration : une entrée ne survit qu'avec du contenu, et
 * un `section_id` inconnu (ou celui d'un dossier) retombe sur « nouvelle
 * section » plutôt que d'écrire au hasard. Pure, donc testable.
 */
export function parseIntegrationPayload(
  payload: unknown,
  sections: SectionRow[],
): WritingIntegration | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as { summary?: unknown; entries?: unknown };
  if (!Array.isArray(raw.entries)) return null;

  const writable = new Set(
    sections.filter((s) => s.kind !== "folder").map((s) => s.id),
  );
  const byId = new Map(sections.map((s) => [s.id, s]));

  const entries: WritingEntry[] = [];
  for (const item of raw.entries) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as {
      section_id?: unknown;
      title?: unknown;
      content_md?: unknown;
    };
    const content = typeof e.content_md === "string" ? e.content_md.trim() : "";
    if (content === "") continue;
    const id =
      typeof e.section_id === "string" && writable.has(e.section_id)
        ? e.section_id
        : "";
    const title = id
      ? (byId.get(id)?.title ?? "")
      : typeof e.title === "string" && e.title.trim() !== ""
        ? e.title.trim()
        : "Notes d'atelier";
    entries.push({ section_id: id, title, content_md: content });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return {
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    entries,
  };
}

/**
 * Relit le fil de la discussion et en tire les textes à intégrer : un bloc par
 * section visée, reformulé façon bible. Ce qui est resté en question ouverte
 * est laissé de côté — l'auteur n'a pas tranché.
 * Lève `writing_*` en cas de refus, de troncature ou de sortie inexploitable.
 */
export async function extractIntegration(
  apiKey: string,
  bibleTitle: string,
  canonMd: string,
  sections: SectionRow[],
  messages: WritingMessage[],
): Promise<WritingIntegration> {
  const client = new Anthropic({ apiKey });
  const transcript = messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => `${m.role === "user" ? "AUTEUR" : "PARTENAIRE"} : ${m.content}`)
    .join("\n\n");

  const prompt = `Voici une session d'écriture entre l'auteur de l'univers
« ${bibleTitle} » et son partenaire d'écriture. Tu dois en tirer ce qui doit
rejoindre la bible.

Sections existantes (identifiant entre crochets) :
${describeSections(sections)}

Canon actuel :
---
${clamp(canonMd, MAX_CANON_CHARS)}
---

Discussion :
---
${clamp(transcript, MAX_CANON_CHARS)}
---

Produis les entrées à intégrer. Pour chacune :
- "section_id" : l'identifiant EXACT de la section où le texte doit rejoindre
  le reste. Laisse la chaîne vide UNIQUEMENT si aucune section existante ne
  convient — donne alors dans "title" le nom de la section à créer.
- "title" : le titre de la section visée (informatif si section_id est donné).
- "content_md" : le texte prêt à être collé dans la bible. Markdown simple.
  Reformule façon bible : concret, cohérent avec le canon, à la même voix que
  lui. Aucune méta, aucune mention de la discussion, de l'auteur ni de toi.
  N'invente rien que l'auteur n'ait validé ou dit.

Règles :
- Regroupe par section : une seule entrée par section visée, même si plusieurs
  moments de la discussion l'alimentent.
- Ignore ce qui est resté en question ouverte, en hypothèse écartée, ou en
  simple bavardage : l'auteur ne l'a pas tranché.
- Si la discussion CONTREDIT le canon, écris la version que l'auteur a
  retenue : c'est lui qui tranche à l'intégration.
- Si rien n'est intégrable, renvoie "entries" vide et dis-le dans "summary".

"summary" : une phrase en français sur ce que cette intégration apporte.

Réponds en JSON strict : { "summary", "entries": [ { "section_id", "title", "content_md" }, … ] }.`;

  const stream = client.messages.stream({
    model: INTEGRATION_MODEL,
    max_tokens: MAX_INTEGRATION_TOKENS,
    output_config: {
      format: { type: "json_schema", schema: INTEGRATION_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("writing_bad_api_key");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`writing_api_error (${err.status}: ${err.message})`);
    }
    throw err;
  }
  if (response.stop_reason === "refusal") throw new Error("writing_refused");
  if (response.stop_reason === "max_tokens") {
    throw new Error("writing_truncated");
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`writing_invalid_json (len=${text.length})`);
  }
  const parsed = parseIntegrationPayload(payload, sections);
  if (!parsed) throw new Error("writing_invalid_payload");
  return parsed;
}

// ── Titre du fil ──────────────────────────────────────────────────────────

/** Longueur du titre déduit du premier message (liste des sessions). */
const MAX_TITLE = 60;

/** Titre d'une session d'écriture, déduit de la première phrase de l'auteur. */
export function deriveTitle(firstMessage: string): string {
  const flat = firstMessage.trim().replace(/\s+/g, " ");
  if (flat === "") return "Session d'écriture";
  if (flat.length <= MAX_TITLE) return flat;
  const cut = flat.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut) + "…";
}
