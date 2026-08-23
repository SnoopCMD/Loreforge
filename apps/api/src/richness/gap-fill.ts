// Comblement d'une zone floue : la réponse de l'auteur est FONDUE dans les
// sections concernées, jamais collée à leur suite.
//
// La mécanique (choix des candidates, appel du modèle, validation de la
// sortie) est partagée avec la boucle canon — voir bibles/weave. Ce module
// n'apporte que le cadrage propre aux zones floues. Rien n'est écrit ici : la
// route propose, l'auteur relit et tranche (contrat de l'atelier d'écriture).

import { AXIS_TITLES } from "../bibles/merge";
import type { SectionRow } from "../bibles/sections";
import {
  describeCandidates,
  describeContext,
  runWeave,
  selectWeaveCandidates,
  WEAVE_RULES,
  type Weave,
  type WeaveEdit,
} from "../bibles/weave";
import type { Axis } from "./logic";

export {
  appendEdit,
  MAX_REWRITABLE_CHARS,
  MAX_WEAVE_EDITS as MAX_GAP_EDITS,
  parseWeave as parseGapFill,
  selectWeaveCandidates as selectGapCandidates,
} from "../bibles/weave";

export type GapEdit = WeaveEdit;
export type GapFill = Weave;

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
${describeCandidates(candidates, sections)}

Reste de la bible (contexte, non modifiable) :
${describeContext(sections, candidates)}

Pour chaque section réellement concernée — une, parfois deux ou trois, jamais
plus — renvoie son corps INTÉGRAL réécrit :
- La réponse de l'auteur est REFORMULÉE façon bible (concret, même voix que le
  reste, aucune méta, aucune mention de la question, de l'analyse ni de toi).
${WEAVE_RULES}

Respecte fidèlement la décision de l'auteur : ne la réinterprète pas, n'invente
rien au-delà de ce qu'elle implique.

"summary" : une phrase en français sur ce que cette réécriture change.

Réponds en JSON strict : { "summary", "edits": [ { "section_id", "content_md" }, … ] }.`;
}

/**
 * Demande au modèle la version réécrite des sections concernées. Lève
 * `weave_*` en cas de refus, de troncature ou de sortie inexploitable :
 * l'appelant se replie alors sur l'ajout en fin de section (rien n'est perdu).
 */
export async function fillGap(
  apiKey: string,
  bibleTitle: string,
  gap: { axis: Axis | string; description: string },
  answer: string,
  sections: SectionRow[],
): Promise<GapFill> {
  const candidates = selectWeaveCandidates(sections, gap.axis);
  if (candidates.length === 0) throw new Error("weave_no_candidate");

  return runWeave(
    apiKey,
    buildGapFillPrompt(
      bibleTitle,
      AXIS_TITLES[gap.axis] ?? gap.axis,
      gap.description,
      answer,
      sections,
      candidates,
    ),
    candidates,
  );
}
