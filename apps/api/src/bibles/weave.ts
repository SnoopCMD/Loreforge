// Tissage : faire entrer un texte DANS les sections d'une bible, au lieu de
// l'empiler à leur suite.
//
// Deux appelants, même mécanique : le comblement d'une zone floue (la réponse
// de l'auteur) et la boucle canon (une invention canonisée). Le modèle reçoit
// le corps intégral des sections candidates et en renvoie la version réécrite ;
// ce module choisit les candidates, appelle le modèle et valide sa sortie.
// Il n'écrit jamais en base : l'appelant décide quoi faire des éditions.

import Anthropic from "@anthropic-ai/sdk";
import { MAX_SECTION_DEPTH, sectionDepth, type SectionRow } from "./sections";

export const WEAVE_MODEL = "claude-sonnet-5";
export const MAX_WEAVE_TOKENS = 8192;

/** Au-delà, une section ne peut plus être réécrite d'un bloc sans risque de
 * troncature : elle reste en contexte (extrait), mais hors des candidates. */
export const MAX_REWRITABLE_CHARS = 12_000;
/** Budget global des corps intégraux envoyés au modèle. */
const MAX_CANDIDATES_CHARS = 30_000;
/** Extrait des sections seulement montrées en contexte. */
const MAX_CONTEXT_EXCERPT = 400;
/** Au-delà, l'auteur ne relit plus : un ajout touche peu de sections. */
export const MAX_WEAVE_EDITS = 3;
/**
 * Garde-fou anti-perte : une réécriture qui INTÈGRE du texte ne peut pas
 * réduire la section de moitié. En deçà, l'édition est refusée (le modèle a
 * élagué ou tronqué) et l'appelant se replie sur l'ajout en fin de corps.
 */
const MIN_KEPT_RATIO = 0.5;
/** En dessous de cette taille, le ratio n'a pas de sens (section quasi vide). */
const RATIO_FLOOR_CHARS = 400;

/** Une section réécrite. */
export interface WeaveEdit {
  section_id: string;
  title: string;
  /** Corps intégral de la section après intégration. */
  content_md: string;
  /** Corps avant intégration (pour comparer, ou revenir en arrière). */
  previous_md: string;
  /** "rewrite" = fondu par le modèle ; "append" = repli, ajout en fin. */
  mode: "rewrite" | "append";
}

export interface Weave {
  summary: string;
  edits: WeaveEdit[];
}

function excerpt(body: string, max: number): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat === ""
    ? "(vide)"
    : flat.slice(0, max) + (flat.length > max ? "…" : "");
}

/**
 * Sections que le modèle a le droit de réécrire : celles de l'axe concerné et
 * leur descendance d'abord (c'est là que le texte a le plus de chances
 * d'atterrir), puis les autres, dans l'ordre de la bible — le tout sous un
 * budget de caractères, corps INTÉGRAL uniquement (une section tronquée en
 * entrée reviendrait tronquée en sortie). Pure, donc testable.
 */
export function selectWeaveCandidates(
  sections: SectionRow[],
  axis: string,
): SectionRow[] {
  const writable = sections.filter((s) => s.kind !== "folder");
  const inAxis = new Set(sections.filter((s) => s.axis === axis).map((s) => s.id));
  // Descendance des sections de l'axe (sous-dossiers par trame, par lieu…).
  let grown = true;
  while (grown) {
    grown = false;
    for (const s of sections) {
      if (s.parent_id && inAxis.has(s.parent_id) && !inAxis.has(s.id)) {
        inAxis.add(s.id);
        grown = true;
      }
    }
  }

  const ordered = [
    ...writable.filter((s) => inAxis.has(s.id)),
    ...writable.filter((s) => !inAxis.has(s.id)),
  ];

  const picked: SectionRow[] = [];
  let budget = MAX_CANDIDATES_CHARS;
  for (const s of ordered) {
    const size = s.content_md.trim().length;
    if (size > MAX_REWRITABLE_CHARS) continue;
    if (size > budget) continue;
    budget -= size;
    picked.push(s);
  }
  return picked;
}

/** Repli sûr : le texte rejoint la fin de la section, comme avant. */
export function appendEdit(section: SectionRow, text: string): WeaveEdit {
  const base = section.content_md.trim();
  const add = text.trim();
  return {
    section_id: section.id,
    title: section.title,
    content_md: base === "" ? add : `${base}\n\n${add}`,
    previous_md: section.content_md,
    mode: "append",
  };
}

const WEAVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "edits"],
  properties: {
    summary: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section_id", "content_md"],
        properties: {
          section_id: { type: "string" },
          content_md: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Valide la sortie du modèle : une édition ne survit qu'en visant une section
 * candidate (jamais un dossier, jamais une section tronquée en entrée), avec
 * un corps non vide qui ne perd pas la moitié de la section. Les doublons sont
 * fusionnés sur la première occurrence. Pure, donc testable.
 */
export function parseWeave(
  payload: unknown,
  candidates: SectionRow[],
): Weave | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as { summary?: unknown; edits?: unknown };
  if (!Array.isArray(raw.edits)) return null;

  const byId = new Map(candidates.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const edits: WeaveEdit[] = [];

  for (const item of raw.edits) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as { section_id?: unknown; content_md?: unknown };
    if (typeof e.section_id !== "string") continue;
    const section = byId.get(e.section_id);
    if (!section || seen.has(section.id)) continue;
    const content = typeof e.content_md === "string" ? e.content_md.trim() : "";
    if (content === "") continue;
    const before = section.content_md.trim();
    if (
      before.length > RATIO_FLOOR_CHARS &&
      content.length < before.length * MIN_KEPT_RATIO
    ) {
      continue; // réécriture amputée : on préfère ne rien proposer pour elle.
    }
    seen.add(section.id);
    edits.push({
      section_id: section.id,
      title: section.title,
      content_md: content,
      previous_md: section.content_md,
      mode: "rewrite",
    });
    if (edits.length >= MAX_WEAVE_EDITS) break;
  }

  return {
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    edits,
  };
}

/** Corps intégral des sections réécrivables, tels qu'envoyés au modèle. */
export function describeCandidates(
  candidates: SectionRow[],
  all: SectionRow[],
): string {
  if (candidates.length === 0) return "(aucune)";
  return candidates
    .map((s) => {
      // Le niveau de titre de la section : un sous-titre ajouté dans son corps
      // doit descendre d'un cran, sinon il casse la hiérarchie du canon.
      const level = Math.min(2 + sectionDepth(all, s.id), MAX_SECTION_DEPTH + 2);
      const sub = "#".repeat(Math.min(level + 1, 6));
      return (
        `[${s.id}] « ${s.title} » (titrée en ${"#".repeat(level)} ; ` +
        `un sous-titre dans son corps s'écrit donc ${sub})\n---\n` +
        `${s.content_md.trim() || "(section vide)"}\n---`
      );
    })
    .join("\n\n");
}

/** Le reste de la bible : repères de cohérence, pas de réécriture possible. */
export function describeContext(
  sections: SectionRow[],
  candidates: SectionRow[],
): string {
  const picked = new Set(candidates.map((s) => s.id));
  const rest = sections.filter((s) => !picked.has(s.id));
  if (rest.length === 0) return "(aucune)";
  return rest
    .map((s) => `- « ${s.title} » : ${excerpt(s.content_md, MAX_CONTEXT_EXCERPT)}`)
    .join("\n");
}

/**
 * Consignes de tissage partagées par les deux appelants : ce qui distingue
 * « intégrer » de « faire suivre ». Le texte à fondre et le cadrage propre à
 * chaque flux sont fournis par l'appelant.
 */
export const WEAVE_RULES = `- Le texte est INSÉRÉ à l'endroit qui le porte : dans le paragraphe qui traite
  du sujet, quitte à le refondre. Ne le recopie jamais tel quel en fin de
  section, et n'ajoute aucune mention de sa provenance.
- S'il RÉPOND à une question ouverte du texte (« À développer : … », « Piste :
  … », « reste à trancher ») : tranche-la sur place — la note disparaît,
  remplacée par ce qu'elle réclamait. C'est tout l'intérêt de l'ajout.
- Tout ce que la section disait déjà est conservé : tu réécris pour intégrer,
  pas pour élaguer. Ne corrige que ce que le texte contredit ou précise.
- Respecte le niveau de titre indiqué pour chaque section : un nouveau
  sous-ensemble nommé devient un vrai sous-titre du bon niveau, jamais un
  titre inséré au fil du texte.
- Ne renvoie AUCUNE section que le texte ne touche pas.`;

/**
 * Appelle le modèle et valide sa sortie. Lève `weave_*` en cas de refus, de
 * troncature ou de sortie inexploitable : l'appelant se replie alors sur
 * l'ajout en fin de section (rien n'est perdu).
 */
export async function runWeave(
  apiKey: string,
  prompt: string,
  candidates: SectionRow[],
): Promise<Weave> {
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: WEAVE_MODEL,
    max_tokens: MAX_WEAVE_TOKENS,
    output_config: { format: { type: "json_schema", schema: WEAVE_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("weave_bad_api_key");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`weave_api_error (${err.status}: ${err.message})`);
    }
    throw err;
  }
  if (response.stop_reason === "refusal") throw new Error("weave_refused");
  if (response.stop_reason === "max_tokens") throw new Error("weave_truncated");

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`weave_invalid_json (len=${text.length})`);
  }
  const parsed = parseWeave(payload, candidates);
  if (!parsed || parsed.edits.length === 0) throw new Error("weave_no_edit");
  return parsed;
}
