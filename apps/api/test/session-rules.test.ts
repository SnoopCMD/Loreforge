import { describe, expect, it } from "vitest";
import {
  addFact,
  applySkillUpdate,
  applySouffleDelta,
  describeOutcome,
  initialGameState,
  MAX_FACTS,
  normalizeTier,
  outcomeForRoll,
  rollD6,
  SOUFFLE_MAX,
  type SkillEntry,
} from "../src/sessions/rules";

describe("outcomeForRoll (SPEC §6)", () => {
  it("1-2 échec avec complication, 3-4 réussite avec coût, 5-6 franche", () => {
    expect(outcomeForRoll(1)).toBe("failure_complication");
    expect(outcomeForRoll(2)).toBe("failure_complication");
    expect(outcomeForRoll(3)).toBe("success_cost");
    expect(outcomeForRoll(4)).toBe("success_cost");
    expect(outcomeForRoll(5)).toBe("clean_success");
    expect(outcomeForRoll(6)).toBe("clean_success");
  });

  it("libellés français pour l'injection prompt", () => {
    expect(describeOutcome("failure_complication")).toBe(
      "échec avec complication",
    );
    expect(describeOutcome("success_cost")).toBe("réussite avec coût");
    expect(describeOutcome("clean_success")).toBe("réussite franche");
  });
});

describe("rollD6", () => {
  it("reste dans [1, 6]", () => {
    for (let i = 0; i < 500; i++) {
      const value = rollD6();
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("applySouffleDelta", () => {
  it("borne le Souffle dans [0, 3]", () => {
    expect(applySouffleDelta(3, -1)).toBe(2);
    expect(applySouffleDelta(0, -1)).toBe(0);
    expect(applySouffleDelta(3, 1)).toBe(SOUFFLE_MAX);
    expect(applySouffleDelta(1, 5)).toBe(SOUFFLE_MAX);
    expect(applySouffleDelta(2, -10)).toBe(0);
  });
});

describe("initialGameState", () => {
  it("3 Souffle, aucun fait, aucune compétence, aucun jet", () => {
    expect(initialGameState()).toEqual({
      souffle: SOUFFLE_MAX,
      facts: [],
      skills: [],
      pending_roll: null,
      last_roll: null,
      turn_count: 0,
    });
  });
});

describe("normalizeTier", () => {
  it("tolère accents, casse et synonymes", () => {
    expect(normalizeTier("Maîtrise")).toBe("maîtrise");
    expect(normalizeTier("maitrise")).toBe("maîtrise");
    expect(normalizeTier("INNE")).toBe("inné");
    expect(normalizeTier("novice")).toBe("découverte");
    expect(normalizeTier("decouverte")).toBe("découverte");
    expect(normalizeTier("légendaire")).toBeNull();
  });
});

describe("applySkillUpdate (mémoire des compétences)", () => {
  it("ajoute une nouvelle compétence avec note", () => {
    const skills: SkillEntry[] = [];
    expect(
      applySkillUpdate(skills, "Marche-faille", "apprentissage", "3 m max"),
    ).toBe(true);
    expect(skills).toEqual([
      { name: "Marche-faille", tier: "apprentissage", note: "3 m max" },
    ]);
  });

  it("fait progresser mais ne régresse jamais", () => {
    const skills: SkillEntry[] = [
      { name: "Marche-faille", tier: "maîtrise" },
    ];
    expect(applySkillUpdate(skills, "marche-faille", "découverte")).toBe(false);
    expect(skills[0].tier).toBe("maîtrise");
    expect(applySkillUpdate(skills, "Marche-Faille", "inné")).toBe(true);
    expect(skills[0].tier).toBe("inné");
    expect(skills).toHaveLength(1); // upsert par nom, accents/casse ignorés
  });

  it("ignore palier inconnu ou nom vide", () => {
    const skills: SkillEntry[] = [];
    expect(applySkillUpdate(skills, "Feu", "cosmique")).toBe(false);
    expect(applySkillUpdate(skills, "  ", "maîtrise")).toBe(false);
    expect(skills).toEqual([]);
  });
});

describe("addFact", () => {
  it("ajoute, déduplique et borne en FIFO", () => {
    const facts: string[] = [];
    expect(addFact(facts, "Karnos est tombée.")).toBe(true);
    expect(addFact(facts, "Karnos est tombée.")).toBe(false);
    expect(addFact(facts, "  ")).toBe(false);
    for (let i = 0; i < MAX_FACTS + 10; i++) addFact(facts, `fait ${i}`);
    expect(facts).toHaveLength(MAX_FACTS);
    expect(facts[facts.length - 1]).toBe(`fait ${MAX_FACTS + 9}`);
    expect(facts).not.toContain("Karnos est tombée."); // sorti en FIFO
  });
});
