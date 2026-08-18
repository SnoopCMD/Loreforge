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
import {
  initialGameState,
  normalizeRollRequest,
  resolveRoll,
} from "../src/sessions/rules";

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

// Repli hors ligne du tri de pertinence : sans contexte qui recoupe une
// lacune, il ne propose RIEN — le tri normal passe par setup-relevance.ts.
describe("buildSetupQuestions (SPEC §4) — repli par mots-clés", () => {
  it("ne pose que les lacunes que le contexte touche, max 3", () => {
    const questions = buildSetupQuestions(scores, gaps, {
      trame: "Dresser la carte des Mondes depuis la capitale.",
    });
    expect(questions.length).toBeLessThanOrEqual(MAX_SETUP_QUESTIONS);
    expect(questions[0]).toContain("Aucune carte des Mondes.");
    expect(questions[1]).toContain("La capitale n'est pas décrite.");
    // Ni le ton ni la magie ne sont dans le fil rouge : on n'en parle pas.
    expect(questions.join(" ")).not.toContain("violence");
    expect(questions.join(" ")).not.toContain("magie");
  });

  it("aucune question sans scores ni sans lacune ouverte", () => {
    expect(buildSetupQuestions(null, gaps)).toEqual([]);
    expect(buildSetupQuestions(scores, [])).toEqual([]);
  });

  it("contexte muet : silence plutôt qu'un lot de questions hors sujet", () => {
    // Régression (mise en place gaspillée) : l'ancien repli « axe le plus
    // faible » faisait trancher six Gardiens à une partie de gangs urbains.
    expect(buildSetupQuestions(scores, gaps)).toEqual([]);
  });

  it("selectSetupGaps garde l'alignement lacune ↔ question (boucle canon)", () => {
    const context = { trame: "Dresser la carte des Mondes." };
    const selected = selectSetupGaps(scores, gaps, context);
    expect(selected.map(gapQuestion)).toEqual(
      buildSetupQuestions(scores, gaps, context),
    );
    // Chaque lacune retenue conserve sa description d'origine : c'est la clé
    // (source_comment) qui la retirera de gaps_json à l'acceptation.
    expect(selected[0]).toEqual(gaps[0]);
  });

  it("une lacune filtrée (déjà répondue) ne génère plus de question", () => {
    const open = gaps.filter(
      (g) => g.description !== "Aucune carte des Mondes.",
    );
    const context = { trame: "Dresser la carte des Mondes depuis la capitale." };
    const questions = buildSetupQuestions(scores, open, context);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("La capitale n'est pas décrite.");
    expect(questions.join(" ")).not.toContain("Aucune carte des Mondes.");
  });
});

describe("questions de mise en place recentrées sur le contexte", () => {
  const trames: RichnessGap[] = [
    { axis: "plots", description: "La trame du Passeur n'a pas de dénouement." },
    { axis: "geography", description: "Le Gué des Cendres n'est pas décrit." },
    { axis: "plots", description: "Le siège de Valmyre n'a pas de camp désigné." },
    { axis: "characters", description: "Les motivations de Dame Orlanne sont floues." },
  ];
  const richScores: RichnessScores = {
    cosmology: 7, characters: 3, plots: 5, tone: 6, geography: 4,
  };

  it("un fil rouge ne fait poser que les flous qu'il traverse", () => {
    const questions = buildSetupQuestions(richScores, trames, {
      trame: "Escorter un convoi au Gué des Cendres pour le compte du Passeur.",
    });
    // Passeur et Gué des Cendres sont dans le fil rouge ; Valmyre et Orlanne
    // n'ont rien à voir avec cette partie — leur tour viendra.
    expect(questions.join(" ")).toContain("La trame du Passeur");
    expect(questions.join(" ")).toContain("Le Gué des Cendres");
    expect(questions.join(" ")).not.toContain("Valmyre");
    expect(questions.join(" ")).not.toContain("Orlanne");
  });

  it("le personnage compte aussi, mais moins que le fil rouge", () => {
    const questions = buildSetupQuestions(richScores, trames, {
      trame: "Lever le siège de Valmyre.",
      characterName: "Dame Orlanne",
    });
    // Le siège (fil rouge, poids 2) passe devant Orlanne (personnage, poids 1).
    expect(questions[0]).toContain("Valmyre");
    expect(questions[1]).toContain("Orlanne");
    expect(questions.join(" ")).not.toContain("Passeur");
  });

  it("hors sujet complet : aucune question plutôt que trois inutiles", () => {
    const questions = buildSetupQuestions(richScores, trames, {
      trame: "Ouvrir une taverne et n'ennuyer personne.",
    });
    expect(questions).toEqual([]);
  });

  it("ignore les mots vides et l'accentuation", () => {
    // « dans / pour / sans » ne doivent rien faire matcher ; « Gue » sans
    // accent doit retrouver « Gué ».
    const questions = buildSetupQuestions(richScores, trames, {
      trame: "Sans plus attendre, aller dans le Gue des Cendres.",
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Le Gué des Cendres");
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
    expect(prompt).toContain('<roll reason="ce qui est tenté"');
    expect(prompt).toContain('difficulty="easy|normal|hard"');
    expect(prompt).toContain('stance="advantage|neutral|disadvantage"');
    expect(prompt).toContain('<invention axis="...">');
    expect(prompt).toContain("Trame libre");
  });

  it("porte le fil rouge de la session comme intention directrice", () => {
    const guided = buildSystemPrompt({
      ...input,
      trame: "Retrouver la trace de la Garde Blanche.",
    });
    expect(guided).toContain("Retrouver la trace de la Garde Blanche.");
    expect(guided).toContain("intention directrice");
    expect(guided).not.toContain("Trame libre");
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
  // L'état est désormais indexé par personnage : le Souffle et les acquis
  // appartiennent à quelqu'un, les faits restent collectifs.
  const state = {
    ...initialGameState("kael"),
    facts: ["Karnos existe."],
  };
  state.characters.kael = {
    souffle: 2,
    skills: [
      { name: "Marche-faille", tier: "maîtrise" as const, note: "3 m max" },
    ],
    pending_roll: null,
    last_roll: null,
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
    const ctx = buildTurnContext(state, { canonExcerpts: "[Extrait — Karnos]\nLa cité..." });
    expect(ctx).toContain("Extraits de la bible");
    expect(ctx).toContain("La cité...");
  });

  it("tolère un état de personnage sans skills", () => {
    const legacy = initialGameState("kael");
    (legacy.characters.kael as { skills?: unknown }).skills = undefined;
    expect(buildTurnContext(legacy)).toContain("(aucune pour l'instant)");
  });

  it("ne nomme les personnages qu'à partir de deux — le solo est inchangé", () => {
    const solo = buildTurnContext(state, {
      characters: [{ key: "kael", name: "Kael", state: state.characters.kael }],
    });
    expect(solo).not.toContain("Kael —");

    const table = buildTurnContext(state, {
      characters: [
        { key: "kael", name: "Kael", state: state.characters.kael },
        {
          key: "mira",
          name: "Mira",
          state: { souffle: 3, skills: [], pending_roll: null, last_roll: null },
        },
      ],
    });
    expect(table).toContain("Kael —");
    expect(table).toContain("Mira —");
    // Chacun son Souffle, dans le même bloc.
    expect(table).toContain("Souffle : 2/3");
    expect(table).toContain("Souffle : 3/3");
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
  it("injecte le résultat du jet et ses conditions au tour suivant", () => {
    const msg = buildTurnMessage(
      "Je saute.",
      resolveRoll(
        normalizeRollRequest({
          reason: "saut",
          difficulty: "hard",
          stance: "advantage",
          bonus_dice: 1,
          skills: ["Acrobatie"],
        }),
        [2, 5, 3],
      ),
    );
    expect(msg).toBe(
      "[Jet saut — difficulté difficile (réussite à 5+), avantage, " +
        "compétences : Acrobatie : 3 dés 2 (annulé), 5*, 3 → dé retenu 5, " +
        "réussite]\n\nJe saute.",
    );
    expect(buildTurnMessage("Je marche.", null)).toBe("Je marche.");
  });

  it("saisie vide + jet = tour de continuation (le jet seul)", () => {
    const msg = buildTurnMessage(
      "",
      resolveRoll(normalizeRollRequest("frappe"), [1]),
    );
    expect(msg).toBe(
      "[Jet frappe — difficulté normale (réussite à 4+), neutre : 1 dé 1* " +
        "→ dé retenu 1, échec critique]",
    );
  });

  it("apparie questions et réponses de mise en place", () => {
    const msg = buildSetupMessage(["Q1 ?", "Q2 ?"], ["Réponse 1", ""]);
    expect(msg).toContain("Q : Q1 ?\nR : Réponse 1");
    expect(msg).toContain("Q : Q2 ?\nR : (le joueur te laisse décider)");
    expect(msg).toContain("scène 1");
  });
});
