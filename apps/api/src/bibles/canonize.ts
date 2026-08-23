// Boucle canon : une invention acceptée entre DANS la bible.
//
// Elle était jusqu'ici recopiée en fin de section derrière un « Canonisé en
// session : » — un bloc à part, souvent posé loin de la note qu'il venait
// justement combler, et dont les sous-titres se retrouvaient collés au fil du
// texte. Elle est maintenant tissée : le modèle réécrit les sections que
// l'invention touche pour l'y fondre (voir weave). Repli sur l'ajout en fin
// de section si le modèle est indisponible — une acceptation ne doit jamais
// perdre son texte.

import { AXIS_TITLES } from "./merge";
import type { SectionRow } from "./sections";
import {
  describeCandidates,
  describeContext,
  runWeave,
  selectWeaveCandidates,
  WEAVE_RULES,
  type Weave,
} from "./weave";

export function buildCanonizePrompt(
  bibleTitle: string,
  axisLabel: string,
  contentMd: string,
  sections: SectionRow[],
  candidates: SectionRow[],
): string {
  return `Tu fais évoluer la bible de l'univers « ${bibleTitle} ». Un élément
inventé en session vient d'être canonisé par l'auteur : il fait désormais
partie de l'univers. Ta tâche : RÉÉCRIRE les sections concernées pour qu'il y
soit fondu, à sa place, comme s'il avait toujours été là.

Élément canonisé (axe ${axisLabel}) :
---
${contentMd.trim()}
---

Sections réécrivables (corps intégral, identifiant entre crochets) :
${describeCandidates(candidates, sections)}

Reste de la bible (contexte, non modifiable) :
${describeContext(sections, candidates)}

Pour chaque section réellement concernée — une, parfois deux ou trois, jamais
plus — renvoie son corps INTÉGRAL réécrit :
- L'élément garde son sens et ses noms propres, mais épouse la voix de la
  section : aucune trace de la session, du jet de dés ni de la canonisation.
${WEAVE_RULES}

N'invente rien au-delà de ce que l'élément canonisé établit : ce qu'il laisse
explicitement ouvert le reste.

"summary" : une phrase en français sur ce que cette canonisation change.

Réponds en JSON strict : { "summary", "edits": [ { "section_id", "content_md" }, … ] }.`;
}

/**
 * Tisse un élément canonisé dans les sections qu'il touche. Lève `weave_*` si
 * le modèle est indisponible ou sa sortie inexploitable — l'appelant se replie
 * alors sur l'ajout en fin de section.
 */
export async function weaveCanonized(
  apiKey: string,
  bibleTitle: string,
  axis: string,
  contentMd: string,
  sections: SectionRow[],
): Promise<Weave> {
  const candidates = selectWeaveCandidates(sections, axis);
  if (candidates.length === 0) throw new Error("weave_no_candidate");

  return runWeave(
    apiKey,
    buildCanonizePrompt(
      bibleTitle,
      AXIS_TITLES[axis] ?? axis,
      contentMd,
      sections,
      candidates,
    ),
    candidates,
  );
}
