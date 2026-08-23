// Comblement d'une zone floue : la réponse de l'auteur est FONDUE dans les
// sections concernées, jamais collée à leur suite.
//
// Le modèle reçoit le corps intégral des sections candidates et en renvoie la
// version réécrite : la réponse s'insère à l'endroit juste, reformulée façon
// bible, le reste du texte étant conservé. Rien n'est écrit ici — la route
// propose, l'auteur relit et tranche (même contrat que l'atelier d'écriture).

import Anthropic from "@anthropic-ai/sdk";
import { AXIS_TITLES } from "../bibles/merge";
import type { SectionRow } from "../bibles/sections";
import type { Axis } from "./logic";

export const GAP_FILL_MODEL = "claude-sonnet-5";
export const MAX_GAP_FILL_TOKENS = 8192;

/** Au-delà, une section ne peut plus être réécrite d'un bloc sans risque de
 * troncature : elle reste en contexte (extrait), mais hors des candidates. */
export const MAX_REWRITABLE_CHARS = 12_000;
/** Budget global des corps intégraux envoyés au modèle. */
const MAX_CANDIDATES_CHARS = 30_000;
/** Extrait des sections seulement montrées en contexte. */
const MAX_CONTEXT_EXCERPT = 400;
/** Au-delà, l'auteur ne relit plus : une zone floue touche peu de sections. */
export const MAX_GAP_EDITS = 3;
/**
 * Garde-fou anti-perte : une réécriture qui INTÈGRE du texte ne peut pas
 * réduire la section de moitié. En deçà, l'édition est refusée (le modèle a
 * élagué ou tronqué) et la section retombe sur l'ajout en fin de corps.
 */
const MIN_KEPT_RATIO = 0.5;
/** En dessous de cette taille, le ratio n'a pas de sens (section quasi vide). */
const RATIO_FLOOR_CHARS = 400;

/** Une section réécrite, telle que proposée à l'auteur. */
export interface GapEdit {
  section_id: string;
  title: string;
  /** Corps intégral de la section après intégration de la réponse. */
  content_md: string;
  /** Corps avant intégration (l'auteur compare avant de valider). */
  previous_md: string;
  /** "rewrite" = fondu par le modèle ; "append" = repli, ajout en fin. */
  mode: "rewrite" | "append";
}

export interface GapFill {
  summary: string;
  edits: GapEdit[];
}

function excerpt(body: string, max: number): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat === ""
    ? "(vide)"
    : flat.slice(0, max) + (flat.length > max ? "…" : "");
}

/**
 * Sections que le modèle a le droit de réécrire : celles de l'axe de la lacune
 * et leur descendance d'abord (c'est là que la réponse a le plus de chances
 * d'atterrir), puis les autres, dans l'ordre de la bible — le tout sous un
 * budget de caractères, corps INTÉGRAL uniquement (une section tronquée en
 * entrée reviendrait tronquée en sortie). Pure, donc testable.
 */
export function selectGapCandidates(
  sections: SectionRow[],
  axis: string,
): SectionRow[] {
  const writable = sections.filter((s) => s.kind !== "folder");
  const axisRoots = sections.filter((s) => s.axis === axis).map((s) => s.id);
  const inAxis = new Set(axisRoots);
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

/** Repli sûr : la réponse rejoint la fin de la section, comme avant. */
export function appendEdit(section: SectionRow, answer: string): GapEdit {
  const base = section.content_md.trim();
  const text = answer.trim();
  return {
    section_id: section.id,
    title: section.title,
    content_md: base === "" ? text : `${base}\n\n${text}`,
    previous_md: section.content_md,
    mode: "append",
  };
}

const GAP_FILL_SCHEMA = {
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
export function parseGapFill(
  payload: unknown,
  candidates: SectionRow[],
): GapFill | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as { summary?: unknown; edits?: unknown };
  if (!Array.isArray(raw.edits)) return null;

  const byId = new Map(candidates.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const edits: GapEdit[] = [];

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
    if (edits.length >= MAX_GAP_EDITS) break;
  }

  return {
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    edits,
  };
}

/** Corps intégral des sections réécrivables, tels qu'envoyés au modèle. */
function describeCandidates(candidates: SectionRow[]): string {
  if (candidates.length === 0) return "(aucune)";
  return candidates
    .map(
      (s) =>
        `[${s.id}] « ${s.title} »\n---\n${s.content_md.trim() || "(section vide)"}\n---`,
    )
    .join("\n\n");
}

/** Le reste de la bible : repères de cohérence, pas de réécriture possible. */
function describeContext(
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

export function buildGapFillPrompt(
  bibleTitle: string,
  axisLabel: string,
  description: string,
  answer: string,
  sections: SectionRow[],
  candidates: SectionRow[],
): string {
  return `Tu fais évoluer la bible de l'univers « ${bibleTitle} ». L'analyse de
richesse a signalé une zone floue ; l'auteur vient d'y répondre. Ta tâche :
RÉÉCRIRE les sections concernées pour que sa réponse y soit fondue.

Zone floue (axe ${axisLabel}) : ${description}

Réponse de l'auteur :
« ${answer.trim()} »

Sections réécrivables (corps intégral, identifiant entre crochets) :
${describeCandidates(candidates)}

Reste de la bible (contexte, non modifiable) :
${describeContext(sections, candidates)}

Pour chaque section réellement concernée — une, parfois deux ou trois, jamais
plus — renvoie son corps INTÉGRAL réécrit :
- La réponse de l'auteur est REFORMULÉE façon bible (concret, même voix que le
  reste, aucune méta, aucune mention de la question, de l'analyse ni de toi) et
  INSÉRÉE à l'endroit qui la porte : dans le paragraphe qui traite du sujet,
  quitte à le refondre. Ne la recopie jamais telle quelle en fin de section.
- Tout ce que la section disait déjà est conservé : tu réécris pour intégrer,
  pas pour élaguer. Corrige seulement ce que la réponse contredit ou précise.
- Le titre, la structure et le niveau des sous-titres restent ceux de la
  section ; n'ajoute pas d'en-tête de niveau 1 ni le titre de la section.
- Ne renvoie AUCUNE section que la réponse ne touche pas.

Respecte fidèlement la décision de l'auteur : ne la réinterprète pas, n'invente
rien au-delà de ce qu'elle implique.

"summary" : une phrase en français sur ce que cette réécriture change.

Réponds en JSON strict : { "summary", "edits": [ { "section_id", "content_md" }, … ] }.`;
}

/**
 * Demande au modèle la version réécrite des sections concernées. Lève
 * `gap_*` en cas de refus, de troncature ou de sortie inexploitable :
 * l'appelant se replie alors sur l'ajout en fin de section (rien n'est perdu).
 */
export async function fillGap(
  apiKey: string,
  bibleTitle: string,
  gap: { axis: Axis | string; description: string },
  answer: string,
  sections: SectionRow[],
): Promise<GapFill> {
  const candidates = selectGapCandidates(sections, gap.axis);
  if (candidates.length === 0) throw new Error("gap_no_candidate");

  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: GAP_FILL_MODEL,
    max_tokens: MAX_GAP_FILL_TOKENS,
    output_config: {
      format: { type: "json_schema", schema: GAP_FILL_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: buildGapFillPrompt(
          bibleTitle,
          AXIS_TITLES[gap.axis] ?? gap.axis,
          gap.description,
          answer,
          sections,
          candidates,
        ),
      },
    ],
  });

  let response;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("gap_bad_api_key");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`gap_api_error (${err.status}: ${err.message})`);
    }
    throw err;
  }
  if (response.stop_reason === "refusal") throw new Error("gap_refused");
  if (response.stop_reason === "max_tokens") throw new Error("gap_truncated");

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`gap_invalid_json (len=${text.length})`);
  }
  const parsed = parseGapFill(payload, candidates);
  if (!parsed || parsed.edits.length === 0) throw new Error("gap_no_edit");
  return parsed;
}
