// Fusion d'une proposition de canon acceptée dans canon_md (SPEC §5).
// Logique pure, testée unitairement : les ajouts canonisés sont regroupés
// en fin de bible sous une section dédiée, un sous-titre par axe.

export const AXIS_TITLES: Record<string, string> = {
  cosmology: "Cosmologie",
  characters: "Personnages",
  plots: "Trames",
  tone: "Ton",
  geography: "Géographie",
};

const SECTION_HEADING = "## Canonisé en session";

export function mergeProposal(
  canonMd: string,
  contentMd: string,
  axis: string,
): string {
  const label = AXIS_TITLES[axis] ?? axis;
  let out = canonMd.replace(/\s+$/, "");
  if (!hasSectionHeading(out)) {
    out += `\n\n${SECTION_HEADING}`;
  }
  return `${out}\n\n### ${label}\n\n${contentMd.trim()}\n`;
}

function hasSectionHeading(md: string): boolean {
  return md
    .split(/\r?\n/)
    .some((line) => line.trimEnd() === SECTION_HEADING);
}
