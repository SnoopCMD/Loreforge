// Tri des zones floues par pertinence pour LA session qui démarre (SPEC §4).

import { describe, expect, it } from "vitest";
import type { RichnessGap } from "../src/richness/logic";
import {
  buildRelevanceMessage,
  parseRelevance,
  RELEVANCE_THRESHOLD,
  selectRelevantGaps,
} from "../src/sessions/setup-relevance";

// Cas réel : bible d'univers ouvert, session de guerre de gangs nocturnes.
const GAPS: RichnessGap[] = [
  {
    axis: "characters",
    description: "Cinq des six Gardiens n'ont ni nom ni créature définis.",
  },
  {
    axis: "cosmology",
    description: "On ignore si l'on peut tuer un Gardien sans tuer sa créature.",
  },
  {
    axis: "geography",
    description: "Le quartier frontière n'a pas de plan ni de limites claires.",
  },
  {
    axis: "characters",
    description: "Les gangs nocturnes n'ont ni chefs ni territoires nommés.",
  },
];

const CONTEXT = {
  characterName: "Nyss",
  characterSheet: '{"concept":"vampire videuse de club-frontière"}',
  trame: "Une guerre de gangs éclate autour du club.",
  format: "oneshot",
};

const verdict = (rows: Array<[string, number]>, adHoc = null as unknown) =>
  parseRelevance(
    {
      gaps: rows.map(([gap_id, relevance]) => ({ gap_id, relevance, why: "" })),
      ad_hoc: adHoc,
    },
    GAPS,
  );

describe("buildRelevanceMessage", () => {
  it("porte les lacunes numérotées et tout le contexte de session", () => {
    const msg = buildRelevanceMessage(GAPS, CONTEXT);
    expect(msg).toContain("g1 [characters] Cinq des six Gardiens");
    expect(msg).toContain("g4 [characters] Les gangs nocturnes");
    expect(msg).toContain("vampire videuse de club-frontière");
    expect(msg).toContain("guerre de gangs éclate");
    expect(msg).toContain("oneshot");
  });

  it("dit explicitement ce qui manque plutôt que de laisser un trou", () => {
    const msg = buildRelevanceMessage(GAPS, {});
    expect(msg).toContain("aucun fil rouge posé");
    expect(msg).toContain("fiche non renseignée");
  });
});

describe("selectRelevantGaps", () => {
  it("écarte les lacunes hors sujet même quand leur axe est faible", () => {
    // Les Gardiens (g1, g2) ne seront pas croisés : la partie est urbaine.
    const kept = selectRelevantGaps(
      verdict([
        ["g1", 2],
        ["g2", 1],
        ["g3", 8],
        ["g4", 9],
      ]),
    );
    expect(kept.map((g) => g.description)).toEqual([
      "Les gangs nocturnes n'ont ni chefs ni territoires nommés.",
      "Le quartier frontière n'a pas de plan ni de limites claires.",
    ]);
  });

  it("ne complète pas jusqu'à trois avec des lacunes faibles", () => {
    const kept = selectRelevantGaps(
      verdict([
        ["g1", 5],
        ["g2", 5],
        ["g3", 5],
        ["g4", 10],
      ]),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].axis).toBe("characters");
  });

  it("plafonne à trois questions", () => {
    const kept = selectRelevantGaps(
      verdict([
        ["g1", 7],
        ["g2", 8],
        ["g3", 9],
        ["g4", 10],
      ]),
    );
    expect(kept).toHaveLength(3);
    expect(kept.map((g) => g.description)).not.toContain(
      "Cinq des six Gardiens n'ont ni nom ni créature définis.",
    );
  });

  it("aucune lacune pertinente : silence, ou question ad hoc si la session en appelle une", () => {
    const silent = verdict([
      ["g1", 0],
      ["g2", 0],
      ["g3", 3],
      ["g4", 4],
    ]);
    expect(selectRelevantGaps(silent)).toEqual([]);

    const adHoc = verdict(
      [
        ["g1", 0],
        ["g3", 2],
      ],
      {
        axis: "cosmology",
        description:
          "Les règles du vampirisme (sang, seuil, lumière) ne sont pas définies.",
      },
    );
    expect(selectRelevantGaps(adHoc)).toEqual([
      {
        axis: "cosmology",
        description:
          "Les règles du vampirisme (sang, seuil, lumière) ne sont pas définies.",
      },
    ]);
  });

  it("une lacune pertinente l'emporte sur la question ad hoc", () => {
    const kept = selectRelevantGaps(
      verdict([["g4", RELEVANCE_THRESHOLD]], {
        axis: "cosmology",
        description: "Les règles du vampirisme ne sont pas définies.",
      }),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].description).toContain("gangs nocturnes");
  });
});

describe("parseRelevance — une réponse abîmée ne fait pas poser n'importe quoi", () => {
  it("ignore les identifiants inconnus, les doublons et les scores absurdes", () => {
    const parsed = parseRelevance(
      {
        gaps: [
          { gap_id: "g9", relevance: 10, why: "n'existe pas" },
          { gap_id: "g4", relevance: 99, why: "hors bornes" },
          { gap_id: "g4", relevance: 0, why: "doublon ignoré" },
          { gap_id: "g3", relevance: "beaucoup", why: "score illisible" },
        ],
        ad_hoc: { axis: "inconnu", description: "axe hors liste" },
      },
      GAPS,
    );
    expect(parsed.scored).toHaveLength(2);
    expect(parsed.scored[0].relevance).toBe(10);
    expect(parsed.scored[1].relevance).toBe(0);
    expect(parsed.adHoc).toBeNull();
  });

  it("une réponse vide ne fait rien poser", () => {
    expect(selectRelevantGaps(parseRelevance(null, GAPS))).toEqual([]);
    expect(selectRelevantGaps(parseRelevance({}, GAPS))).toEqual([]);
  });
});
