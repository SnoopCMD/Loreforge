import { describe, expect, it } from "vitest";
import type { RichnessGap, RichnessScores } from "../src/richness/logic";
import {
  buildSetupMessage,
  buildSetupQuestions,
  buildSystemPrompt,
  buildTurnContext,
  buildTurnMessage,
  gapQuestion,
  MAX_SETUP_QUESTIONS,
  selectSetupGaps,
  turnEndsOpen,
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

  it("selectSetupGaps garde l'alignement lacune ↔ question (boucle canon)", () => {
    const selected = selectSetupGaps(scores, gaps);
    expect(selected.map(gapQuestion)).toEqual(buildSetupQuestions(scores, gaps));
    // Chaque lacune retenue conserve sa description d'origine : c'est la clé
    // (source_comment) qui la retirera de gaps_json à l'acceptation.
    expect(selected[0]).toEqual(gaps[0]);
  });

  it("une lacune filtrée (déjà répondue) ne génère plus de question", () => {
    const open = gaps.filter(
      (g) => g.description !== "Aucune carte des Mondes.",
    );
    const questions = buildSetupQuestions(scores, open);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toContain("La capitale n'est pas décrite.");
    expect(questions.join(" ")).not.toContain("Aucune carte des Mondes.");
  });
});

describe("buildSystemPrompt (SPEC §7)", () => {
  const input = {
    bibleTitle: "Les Mondes Fêlés",
    canonMd: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
    scores,
    gaps,
    toneProfile: null,
    characterName: "Kael",
    characterSheet: '{"pouvoir":"marche-faille"}',
    format: "oneshot",
    trame: null,
  };
  const prompt = buildSystemPrompt(input);

  it("contient le canon, le titre et les règles dérivées par axe", () => {
    expect(prompt).toContain("« Les Mondes Fêlés »");
    expect(prompt).toContain("La magie vient des failles.");
    expect(prompt).toContain("Axes ≥ 8 (cosmology, plots)");
    expect(prompt).toContain("Axes ≤ 4 (tone, geography)");
  });

  it("contient la fiche et le contrat de balises", () => {
    expect(prompt).toContain("Kael");
    expect(prompt).toContain('<roll reason="..."/>');
    expect(prompt).toContain('<invention axis="...">');
    expect(prompt).toContain("trame libre");
  });

  it("annonce le système de compétences et la mémoire des faits", () => {
    expect(prompt).toContain('<skill name="Nom de la compétence"');
    expect(prompt).toContain("découverte");
    expect(prompt).toContain("inné : l'usage n'appelle JAMAIS de jet");
    expect(prompt).toContain('<fait texte="');
    expect(prompt).toContain("CONTEXTE DU TOUR");
  });

  it("est stable : ne contient ni Souffle courant ni faits de session", () => {
    // Le prompt système est le préfixe mis en cache : l'état volatile n'y a
    // pas sa place (il voyage dans buildTurnContext).
    expect(prompt).not.toContain("Souffle actuel");
    expect(buildSystemPrompt(input)).toBe(prompt);
  });

  it("ton par défaut si tone_profile absent", () => {
    expect(prompt).toContain("registre par défaut");
  });

  it("annonce le glossaire cliquable et la règle de fin de tour non négociable", () => {
    expect(prompt).toContain('<lore term="Nom canonique"');
    expect(prompt).toContain("NON NÉGOCIABLE");
  });
});

describe("buildTurnContext (état volatile par tour)", () => {
  const state = {
    ...initialGameState(),
    souffle: 2,
    facts: ["Karnos existe."],
    skills: [
      { name: "Marche-faille", tier: "maîtrise" as const, note: "3 m max" },
    ],
  };

  it("contient Souffle, faits et compétences avec palier", () => {
    const ctx = buildTurnContext(state);
    expect(ctx).toContain("Souffle : 2/3");
    expect(ctx).toContain("- Karnos existe.");
    expect(ctx).toContain("- Marche-faille — maîtrise (3 m max)");
    expect(ctx).toContain("[FIN DU CONTEXTE]");
    expect(ctx).not.toContain("Extraits de la bible");
  });

  it("inclut les extraits RAG quand fournis", () => {
    const ctx = buildTurnContext(state, "[Extrait — Karnos]\nLa cité...");
    expect(ctx).toContain("Extraits de la bible");
    expect(ctx).toContain("La cité...");
  });

  it("tolère un état d'ancienne session sans skills", () => {
    const legacy = { ...initialGameState(), skills: undefined } as never;
    expect(buildTurnContext(legacy)).toContain("(aucune pour l'instant)");
  });
});

describe("turnEndsOpen (garde-fou §7)", () => {
  it("accepte une question dans les 2 dernières phrases", () => {
    expect(turnEndsOpen("La porte grince. Que fais-tu ?")).toBe(true);
    expect(
      turnEndsOpen("Tu hésites. La brume avance. Oses-tu la traverser ?"),
    ).toBe(true);
  });

  it("accepte une fin sur ≥ 2 options listées", () => {
    expect(
      turnEndsOpen("Deux chemins s'ouvrent.\n- Le pont\n- La barque"),
    ).toBe(true);
    expect(turnEndsOpen("Choisis.\n1) Frapper\n2) Fuir\n3) Parler")).toBe(true);
  });

  it("rejette une scène descriptive fermée sans relance", () => {
    expect(
      turnEndsOpen("La nuit tombe sur Karnos. Les torches s'éteignent une à une."),
    ).toBe(false);
    expect(turnEndsOpen("Une seule option.\n- Avancer")).toBe(false);
  });

  it("une question trop en amont ne suffit pas", () => {
    expect(
      turnEndsOpen(
        "Tu te demandes où aller ? Tu marches. Le silence retombe sur la salle.",
      ),
    ).toBe(false);
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
