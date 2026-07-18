import { describe, expect, it } from "vitest";
import type { RichnessGap, RichnessScores } from "../src/richness/logic";
import {
  buildSetupMessage,
  buildSetupQuestions,
  buildSystemPrompt,
  buildTurnMessage,
  MAX_SETUP_QUESTIONS,
} from "../src/sessions/prompt";
import { initialGameState } from "../src/sessions/rules";

const scores: RichnessScores = {
  cosmology: 9,
  characters: 6,
  plots: 8,
  tone: 4,
  geography: 3,
};

const gaps: RichnessGap[] = [
  { axis: "geography", description: "Aucune carte des Mondes." },
  { axis: "tone", description: "Niveau de violence non explicité." },
  { axis: "geography", description: "La capitale n'est pas décrite." },
  { axis: "cosmology", description: "Origine de la magie floue." },
];

describe("buildSetupQuestions (SPEC §4)", () => {
  it("priorise les axes faibles par score croissant, max 3 questions", () => {
    const questions = buildSetupQuestions(scores, gaps);
    expect(questions).toHaveLength(MAX_SETUP_QUESTIONS);
    // geography (3) avant tone (4) ; cosmology (9) jamais.
    expect(questions[0]).toContain("Aucune carte des Mondes.");
    expect(questions[1]).toContain("La capitale n'est pas décrite.");
    expect(questions[2]).toContain("Niveau de violence non explicité.");
    for (const q of questions) expect(q).not.toContain("magie");
  });

  it("aucune question sans scores ni pour des axes ≥ 5", () => {
    expect(buildSetupQuestions(null, gaps)).toEqual([]);
    const strong = { ...scores, tone: 8, geography: 9 };
    expect(buildSetupQuestions(strong, gaps)).toEqual([]);
  });
});

describe("buildSystemPrompt (SPEC §7)", () => {
  const prompt = buildSystemPrompt({
    bibleTitle: "Les Mondes Fêlés",
    canonMd: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
    scores,
    gaps,
    toneProfile: null,
    characterName: "Kael",
    characterSheet: '{"pouvoir":"marche-faille"}',
    format: "oneshot",
    trame: null,
    state: { ...initialGameState(), souffle: 2, facts: ["Karnos existe."] },
  });

  it("contient le canon, le titre et les règles dérivées par axe", () => {
    expect(prompt).toContain("« Les Mondes Fêlés »");
    expect(prompt).toContain("La magie vient des failles.");
    expect(prompt).toContain("Axes ≥ 8 (cosmology, plots)");
    expect(prompt).toContain("Axes ≤ 4 (tone, geography)");
  });

  it("contient l'état courant, la fiche et le contrat de balises", () => {
    expect(prompt).toContain("Souffle actuel : 2/3");
    expect(prompt).toContain("Karnos existe.");
    expect(prompt).toContain("Kael");
    expect(prompt).toContain('<roll reason="..."/>');
    expect(prompt).toContain('<invention axis="...">');
    expect(prompt).toContain("trame libre");
  });

  it("ton par défaut si tone_profile absent", () => {
    expect(prompt).toContain("registre par défaut");
  });
});

describe("buildTurnMessage / buildSetupMessage", () => {
  it("injecte le résultat du d6 au tour suivant", () => {
    const msg = buildTurnMessage("Je saute.", {
      value: 4,
      outcome: "success_cost",
      reason: "saut",
    });
    expect(msg).toBe("[Jet d6 (saut) : 4 → réussite avec coût]\n\nJe saute.");
    expect(buildTurnMessage("Je marche.", null)).toBe("Je marche.");
  });

  it("saisie vide + jet = tour de continuation (le jet seul)", () => {
    const msg = buildTurnMessage("", {
      value: 1,
      outcome: "failure_complication",
      reason: "frappe",
    });
    expect(msg).toBe("[Jet d6 (frappe) : 1 → échec avec complication]");
  });

  it("apparie questions et réponses de mise en place", () => {
    const msg = buildSetupMessage(["Q1 ?", "Q2 ?"], ["Réponse 1", ""]);
    expect(msg).toContain("Q : Q1 ?\nR : Réponse 1");
    expect(msg).toContain("Q : Q2 ?\nR : (le joueur te laisse décider)");
    expect(msg).toContain("scène 1");
  });
});
