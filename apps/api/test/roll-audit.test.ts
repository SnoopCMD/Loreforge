// Garde-fou du nombre de dés (§6) : la fiche doit compter, même quand le MJ
// l'oublie. Cas de référence : la vampire roublarde qui pousse Reika à la faute.

import { describe, expect, it } from "vitest";
import {
  applyRollAudit,
  buildRollAuditMessage,
  needsRollAudit,
  sheetTraits,
} from "../src/sessions/roll-audit";
import { normalizeRollRequest, poolSize } from "../src/sessions/rules";

const SHEET = JSON.stringify({
  name: "Nyss",
  concept: "vampire videuse de club-frontière",
  temperament:
    "roublarde et provocatrice, elle aime pousser ses adversaires à la faute avant de frapper",
  ability: "force et vitesse vampiriques, maîtrise des sigils",
  weakness: "le soleil, et le sang qu'elle refuse de prendre de force",
});

const TRAITS = sheetTraits(SHEET);

const ACTION = normalizeRollRequest({
  reason: "pousser Reika à révéler la faille du sigil en feignant l'inquiétude",
  skills: ["comédie", "provocation", "lecture sociale"],
});

describe("sheetTraits", () => {
  it("lit les clés canoniques de la fiche", () => {
    expect(TRAITS.temperament).toContain("provocatrice");
    expect(TRAITS.ability).toContain("sigils");
    expect(TRAITS.weakness).toContain("soleil");
  });

  it("retrouve les champs d'un schéma dérivé de la bible", () => {
    const traits = sheetTraits({
      "Caractère": "impulsive",
      "Capacité principale": "chant des pierres",
      "Faille intime": "sa sœur",
    });
    expect(traits.temperament).toBe("impulsive");
    expect(traits.ability).toBe("chant des pierres");
    expect(traits.weakness).toBe("sa sœur");
  });

  it("encaisse une fiche absente, vide ou illisible", () => {
    const empty = { temperament: null, ability: null, weakness: null };
    expect(sheetTraits(null)).toEqual(empty);
    expect(sheetTraits("pas du json")).toEqual(empty);
    expect(sheetTraits("{}")).toEqual(empty);
  });
});

describe("needsRollAudit", () => {
  it("vérifie quand un bonus de fiche possible n'a pas été appliqué", () => {
    expect(needsRollAudit(ACTION, TRAITS)).toBe(true);
  });

  it("ne vérifie pas un jet déjà crédité des deux bonus", () => {
    const request = normalizeRollRequest({
      reason: ACTION.reason,
      bonuses: "temperament: provocation ; ability: sigils",
    });
    expect(needsRollAudit(request, TRAITS)).toBe(false);
  });

  it("ne vérifie pas quand la fiche est muette", () => {
    expect(needsRollAudit(ACTION, sheetTraits(null))).toBe(false);
  });
});

describe("buildRollAuditMessage", () => {
  it("donne l'action, ses registres et les deux traits", () => {
    const msg = buildRollAuditMessage({
      reason: ACTION.reason,
      skills: ACTION.skills,
      traits: TRAITS,
    });
    expect(msg).toContain("pousser Reika");
    expect(msg).toContain("comédie, provocation, lecture sociale");
    expect(msg).toContain("provocatrice");
    expect(msg).toContain("sigils");
  });
});

describe("applyRollAudit", () => {
  it("rattrape le cas observé : 1 dé alors que deux bonus étaient dus", () => {
    expect(poolSize(ACTION)).toBe(1);
    const fixed = applyRollAudit(
      ACTION,
      {
        temperament: { applies: true, why: "elle pousse à la faute" },
        ability: { applies: true, why: "la faille du sigil" },
      },
      TRAITS,
    );
    expect(fixed.bonus_dice).toBe(2);
    expect(poolSize(fixed)).toBe(3);
    expect(fixed.bonuses).toEqual([
      { source: "temperament", why: "elle pousse à la faute" },
      { source: "ability", why: "la faille du sigil" },
    ]);
  });

  it("n'ajoute que ce que la vérification confirme", () => {
    const fixed = applyRollAudit(
      ACTION,
      {
        temperament: { applies: true, why: "provocation" },
        ability: { applies: false, why: "" },
      },
      TRAITS,
    );
    expect(fixed.bonus_dice).toBe(1);
    expect(fixed.bonuses).toHaveLength(1);
  });

  it("ne retire jamais un bonus déjà accordé et n'invente pas de malus", () => {
    const request = normalizeRollRequest({
      reason: ACTION.reason,
      bonuses: "temperament: provocation",
    });
    const fixed = applyRollAudit(
      request,
      {
        temperament: { applies: false, why: "" },
        ability: { applies: false, why: "" },
        weakness: { applies: true, why: "le soleil" },
      },
      TRAITS,
    );
    expect(fixed).toEqual(request);
    expect(fixed.bonuses.some((b) => b.source === "weakness")).toBe(false);
  });

  it("une réponse illisible laisse le jet intact", () => {
    expect(applyRollAudit(ACTION, null, TRAITS)).toEqual(ACTION);
    expect(applyRollAudit(ACTION, { temperament: "oui" }, TRAITS)).toEqual(ACTION);
  });
});
