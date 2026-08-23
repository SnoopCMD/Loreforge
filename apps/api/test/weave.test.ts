// Tissage : la mécanique partagée par le comblement des zones floues et la
// boucle canon. Les deux appelants envoient au modèle le corps intégral des
// sections candidates ; ce module décide lesquelles, et à quel niveau de titre.

import { describe, expect, it } from "vitest";
import {
  describeCandidates,
  describeContext,
  MAX_SECTION_BODY_CHARS,
  selectWeaveCandidates,
  validateEdits,
} from "../src/bibles/weave";
import { buildCanonizePrompt } from "../src/bibles/canonize";
import type { SectionRow } from "../src/bibles/sections";

function section(over: Partial<SectionRow> = {}): SectionRow {
  return {
    id: "geo",
    bible_id: "b1",
    title: "Géographie & lieux",
    content_md: "Les lieux s'organisent autour des failles.",
    is_base: 1,
    axis: "geography",
    sort_order: 0,
    updated_at: 0,
    parent_id: null,
    kind: "section",
    ...over,
  };
}

describe("describeCandidates", () => {
  it("annonce le niveau de titre de chaque section, et celui d'un sous-titre", () => {
    const rows = [
      section(),
      section({ id: "asie", title: "Asie", parent_id: "geo", axis: null }),
    ];
    const out = describeCandidates(rows, rows);
    // Racine : titrée en ## — un sous-titre dans son corps s'écrit ###.
    expect(out).toContain("« Géographie & lieux » (titrée en ## ; un sous-titre dans son corps s'écrit donc ###)");
    // Enfant : d'un cran plus bas des deux côtés.
    expect(out).toContain("« Asie » (titrée en ### ; un sous-titre dans son corps s'écrit donc ####)");
  });

  it("envoie le corps INTÉGRAL, jamais un extrait", () => {
    const body = "Un détail rare. " + "x".repeat(2000);
    expect(describeCandidates([section({ content_md: body })], [])).toContain(body);
  });

  it("une section vide se dit, elle ne se devine pas", () => {
    expect(describeCandidates([section({ content_md: "  " })], [])).toContain("(section vide)");
  });
});

describe("describeContext", () => {
  it("résume en extrait ce qui n'est pas réécrivable", () => {
    const geo = section();
    const ton = section({ id: "ton", title: "Ton & style", axis: "tone", content_md: "Sombre." });
    const out = describeContext([geo, ton], [geo]);
    expect(out).toContain("« Ton & style » : Sombre.");
    expect(out).not.toContain("Géographie & lieux");
  });
});

describe("buildCanonizePrompt", () => {
  it("porte l'élément, l'axe, les sections et la règle de tranchage des notes", () => {
    const rows = [section()];
    const prompt = buildCanonizePrompt(
      "Les Mondes Fêlés",
      "Géographie",
      "### Nagi-Teï\n\nUn quartier dense d'Asie.",
      rows,
      rows,
    );
    expect(prompt).toContain("Les Mondes Fêlés");
    expect(prompt).toContain("axe Géographie");
    expect(prompt).toContain("Nagi-Teï");
    expect(prompt).toContain("Les lieux s'organisent autour des failles.");
    // La consigne qui distingue « intégrer » de « faire suivre ».
    expect(prompt).toContain("À développer");
    expect(prompt).toContain("la note disparaît");
    // Aucune trace de la session dans le texte réécrit.
    expect(prompt).toContain("aucune trace de la session");
  });
});

describe("selectWeaveCandidates", () => {
  it("l'axe d'abord, puis le reste de la bible", () => {
    const rows = [
      section({ id: "ton", title: "Ton", axis: "tone" }),
      section(),
    ];
    expect(selectWeaveCandidates(rows, "geography").map((s) => s.id)).toEqual([
      "geo",
      "ton",
    ]);
  });
});

describe("validateEdits", () => {
  const rows = [
    section(),
    section({ id: "dossier", title: "Lieux", kind: "folder" }),
  ];

  it("garde les corps relus, fusionnés par section", () => {
    const out = validateEdits(rows, [
      { section_id: "geo", content_md: "  Premier.  " },
      { section_id: "geo", content_md: "Dernier mot." },
    ]);
    expect("updates" in out && [...out.updates]).toEqual([["geo", "Dernier mot."]]);
  });

  it("refuse une section inconnue ou un dossier — jamais d'écriture au hasard", () => {
    expect(validateEdits(rows, [{ section_id: "ailleurs", content_md: "x" }])).toEqual({
      error: "unknown_section",
    });
    expect(validateEdits(rows, [{ section_id: "dossier", content_md: "x" }])).toEqual({
      error: "unknown_section",
    });
  });

  it("refuse un corps vide, démesuré, ou une liste vide", () => {
    expect(validateEdits(rows, [{ section_id: "geo", content_md: "   " }])).toEqual({
      error: "invalid_edits",
    });
    expect(
      validateEdits(rows, [
        { section_id: "geo", content_md: "x".repeat(MAX_SECTION_BODY_CHARS + 1) },
      ]),
    ).toEqual({ error: "invalid_edits" });
    expect(validateEdits(rows, [])).toEqual({ error: "invalid_edits" });
    expect(validateEdits(rows, "pas un tableau")).toEqual({ error: "invalid_edits" });
  });
});
