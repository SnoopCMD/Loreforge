// Annexe des tableaux de références (§8) : logique pure, et sa présence dans
// les deux prompts qui la consomment (richesse et MJ).

import { describe, expect, it } from "vitest";
import {
  buildMoodboardAnnex,
  MAX_MOODBOARD_CHARS,
  type MoodboardBrief,
} from "../src/bibles/moodboard-context";
import { buildRichnessPrompt } from "../src/richness/logic";
import { buildSystemPrompt } from "../src/sessions/prompt";

const board = (over: Partial<MoodboardBrief> = {}): MoodboardBrief => ({
  title: "Ruelles de néon",
  note: null,
  analysis_md: "Lumière froide, béton mouillé, XYZZY.",
  ...over,
});

describe("buildMoodboardAnnex", () => {
  it("rend une chaîne vide sans tableau analysé", () => {
    expect(buildMoodboardAnnex([])).toBe("");
    expect(buildMoodboardAnnex([board({ analysis_md: null })])).toBe("");
    expect(buildMoodboardAnnex([board({ analysis_md: "   " })])).toBe("");
  });

  it("reprend titre, intention et lecture d'ambiance", () => {
    const annex = buildMoodboardAnnex([board({ note: "Sale et vivant" })]);
    expect(annex).toContain("Ruelles de néon");
    expect(annex).toContain("Sale et vivant");
    expect(annex).toContain("XYZZY");
    // Cadrage explicite : l'ambiance n'est pas du canon.
    expect(annex).toContain("PAS du canon");
  });

  it("plafonne le volume total", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      board({ title: "T" + i, analysis_md: "y".repeat(2000) }),
    );
    expect(buildMoodboardAnnex(many).length).toBeLessThan(
      MAX_MOODBOARD_CHARS + 1000,
    );
  });
});

describe("annexe dans les prompts", () => {
  const annex = buildMoodboardAnnex([board()]);

  it("l'analyse de richesse la reçoit et la cantonne au ton", () => {
    const prompt = buildRichnessPrompt("# Univers", annex);
    expect(prompt).toContain("XYZZY");
    expect(prompt).toContain('l\'axe "tone"');
    // Sans annexe, aucune trace : le prompt d'origine ne change pas.
    expect(buildRichnessPrompt("# Univers")).not.toContain(
      "RÉFÉRENCES GRAPHIQUES",
    );
  });

  it("le prompt du MJ la reçoit et fait primer le canon", () => {
    const input = {
      bibleTitle: "Witchpunk",
      canonMd: "# Univers",
      scores: null,
      gaps: [],
      toneProfile: null,
      characterName: null,
      characterSheet: null,
      format: "one-shot",
      trame: null,
    };
    const prompt = buildSystemPrompt({ ...input, moodboardAnnex: annex });
    expect(prompt).toContain("XYZZY");
    expect(prompt).toContain("le canon gagne toujours");
    expect(buildSystemPrompt(input)).not.toContain("RÉFÉRENCES GRAPHIQUES");
  });
});
