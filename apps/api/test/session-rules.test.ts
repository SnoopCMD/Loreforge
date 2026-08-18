import { describe, expect, it } from "vitest";
import {
  addFact,
  applySkillTiers,
  applySkillUpdate,
  bonusDice,
  applySouffleDelta,
  describeOutcome,
  DIFFICULTY_THRESHOLD,
  initialGameState,
  isSuccess,
  MAX_BONUS_DICE,
  MAX_FACTS,
  MAX_POOL,
  mergeSkills,
  normalizeBonuses,
  normalizeRollRequest,
  normalizeTier,
  outcomeForValue,
  performRoll,
  poolSize,
  resolveRoll,
  sanitizeSkills,
  rollD6,
  SOUFFLE_MAX,
  type SkillEntry,
} from "../src/sessions/rules";

const req = (over: Record<string, unknown> = {}) =>
  normalizeRollRequest({ reason: "test", ...over });

describe("outcomeForValue (difficulté)", () => {
  it("facile : 1-2 échec, 3-6 réussite", () => {
    expect(DIFFICULTY_THRESHOLD.easy).toBe(3);
    expect(outcomeForValue(1, "easy")).toBe("critical_failure");
    expect(outcomeForValue(2, "easy")).toBe("failure");
    expect(outcomeForValue(3, "easy")).toBe("success");
    expect(outcomeForValue(5, "easy")).toBe("success");
    expect(outcomeForValue(6, "easy")).toBe("critical_success");
  });

  it("normal : 1-3 échec, 4-6 réussite", () => {
    expect(outcomeForValue(1, "normal")).toBe("critical_failure");
    expect(outcomeForValue(3, "normal")).toBe("failure");
    expect(outcomeForValue(4, "normal")).toBe("success");
    expect(outcomeForValue(6, "normal")).toBe("critical_success");
  });

  it("difficile : 1-4 échec, 5-6 réussite", () => {
    expect(outcomeForValue(4, "hard")).toBe("failure");
    expect(outcomeForValue(5, "hard")).toBe("success");
    expect(outcomeForValue(6, "hard")).toBe("critical_success");
    expect(outcomeForValue(1, "hard")).toBe("critical_failure");
  });

  it("issue binaire, critiques inclus", () => {
    expect(isSuccess("success")).toBe(true);
    expect(isSuccess("critical_success")).toBe(true);
    expect(isSuccess("failure")).toBe(false);
    expect(isSuccess("critical_failure")).toBe(false);
  });

  it("libellés français pour l'injection prompt", () => {
    expect(describeOutcome("critical_failure")).toBe("échec critique");
    expect(describeOutcome("failure")).toBe("échec");
    expect(describeOutcome("success")).toBe("réussite");
    expect(describeOutcome("critical_success")).toBe("réussite critique");
  });
});

describe("poolSize (dice pool + posture)", () => {
  it("1 dé de base, +1 par compétence, +1 pour avantage/désavantage", () => {
    expect(poolSize(req())).toBe(1);
    expect(poolSize(req({ bonus_dice: 2 }))).toBe(3);
    expect(poolSize(req({ stance: "advantage" }))).toBe(2);
    expect(poolSize(req({ stance: "disadvantage" }))).toBe(2);
    expect(poolSize(req({ bonus_dice: 2, stance: "advantage" }))).toBe(4);
  });

  it("borné à MAX_POOL", () => {
    expect(
      poolSize(req({ bonus_dice: 99, stance: "advantage" })),
    ).toBe(MAX_POOL);
  });
});

describe("resolveRoll", () => {
  it("un seul dé : l'issue vient de lui", () => {
    const r = resolveRoll(req({ difficulty: "hard" }), [4]);
    expect(r.value).toBe(4);
    expect(r.outcome).toBe("failure");
    expect(r.dice).toEqual([
      { value: 4, success: false, cancelled: false, kept: true },
    ]);
  });

  it("avantage : garde le meilleur dé", () => {
    const r = resolveRoll(req({ stance: "advantage" }), [2, 4]);
    expect(r.value).toBe(4);
    expect(r.outcome).toBe("success");
    expect(r.dice.find((d) => d.kept)?.value).toBe(4);
  });

  it("désavantage : garde le moins bon dé", () => {
    const r = resolveRoll(req({ stance: "disadvantage" }), [2, 4]);
    expect(r.value).toBe(2);
    expect(r.outcome).toBe("failure");
  });

  it("un 5 ou un 6 annule un dé raté (même en désavantage)", () => {
    const r = resolveRoll(req({ stance: "disadvantage" }), [1, 5]);
    expect(r.cancelled).toBe(1);
    expect(r.dice[0].cancelled).toBe(true);
    // Le 1 annulé sort du pool : le pire dé restant est le 5.
    expect(r.value).toBe(5);
    expect(r.outcome).toBe("success");
  });

  it("les annulations vont aux pires ratés d'abord, une par 5/6", () => {
    const r = resolveRoll(req({ stance: "disadvantage" }), [1, 3, 2, 6]);
    expect(r.cancelled).toBe(1);
    expect(r.dice.map((d) => d.cancelled)).toEqual([true, false, false, false]);
    expect(r.value).toBe(2);
    expect(r.outcome).toBe("failure");
  });

  it("deux 5/6 annulent deux ratés", () => {
    const r = resolveRoll(req({ stance: "disadvantage" }), [1, 2, 5, 6]);
    expect(r.cancelled).toBe(2);
    expect(r.value).toBe(5);
    expect(r.outcome).toBe("success");
  });

  it("dice pool sans posture : le meilleur dé restant décide", () => {
    const r = resolveRoll(req({ bonus_dice: 2 }), [1, 3, 6]);
    expect(r.value).toBe(6);
    expect(r.outcome).toBe("critical_success");
    expect(r.threshold).toBe(4);
  });

  it("critique sur 1 quel que soit le seuil", () => {
    expect(resolveRoll(req({ difficulty: "easy" }), [1]).outcome).toBe(
      "critical_failure",
    );
  });

  it("conserve les conditions du jet dans le résultat", () => {
    const r = resolveRoll(
      req({ difficulty: "hard", stance: "advantage", bonus_dice: 1, skills: ["Escalade"] }),
      [3, 5, 2],
    );
    expect(r.reason).toBe("test");
    expect(r.difficulty).toBe("hard");
    expect(r.stance).toBe("advantage");
    expect(r.bonus_dice).toBe(1);
    expect(r.skills).toEqual(["Escalade"]);
  });
});

describe("normalizeRollRequest", () => {
  it("valeurs par défaut sûres", () => {
    expect(normalizeRollRequest(null)).toEqual({
      reason: "action risquée",
      difficulty: "normal",
      stance: "neutral",
      bonus_dice: 0,
      bonuses: [],
      skills: [],
    });
  });

  it("accepte l'ancien format (raison seule) et les valeurs invalides", () => {
    expect(normalizeRollRequest("saut périlleux").reason).toBe(
      "saut périlleux",
    );
    const r = normalizeRollRequest({
      reason: "  x  ",
      difficulty: "impossible",
      stance: "godmode",
      bonus_dice: "12",
      skills: "pas un tableau",
    });
    expect(r).toEqual({
      reason: "x",
      difficulty: "normal",
      stance: "neutral",
      bonus_dice: MAX_BONUS_DICE,
      bonuses: [],
      skills: [],
    });
  });
});

describe("barème des dés (§6) — la fiche décide, pas l'humeur du MJ", () => {
  it("chaque bonus vaut un dé, la faiblesse en retire un", () => {
    expect(bonusDice(normalizeBonuses("temperament: provocation"))).toBe(1);
    expect(
      bonusDice(
        normalizeBonuses("temperament: provocation ; ability: sigils ; souffle"),
      ),
    ).toBe(3);
    expect(bonusDice(normalizeBonuses("ability: sigils ; weakness: soleil"))).toBe(0);
  });

  it("lit les libellés français, accentués ou non, et ignore l'inconnu", () => {
    expect(normalizeBonuses("Tempérament: bravade ; Capacité: sigils")).toEqual([
      { source: "temperament", why: "bravade" },
      { source: "ability", why: "sigils" },
    ]);
    expect(normalizeBonuses("chance ; météo favorable")).toEqual([]);
  });

  it("ne compte pas deux fois la même source", () => {
    const bonuses = normalizeBonuses(
      "temperament: provocation ; temperament: audace",
    );
    expect(bonuses).toHaveLength(1);
    expect(bonusDice(bonuses)).toBe(1);
  });

  it("la poignée vient des bonus, pas du nombre annoncé par le MJ", () => {
    // Cas observé : action alignée tempérament + capacité annoncée à 1 dé.
    const r = normalizeRollRequest({
      reason: "pousser Reika à révéler la faille du sigil",
      bonus_dice: 1,
      bonuses: "temperament: pousser à la faute ; ability: sigils",
      skills: ["comédie", "provocation", "lecture sociale"],
    });
    expect(r.bonus_dice).toBe(2);
    expect(poolSize(r)).toBe(3);
  });

  it("une faiblesse ne prive jamais du jet", () => {
    const r = normalizeRollRequest({
      reason: "affronter le soleil de midi",
      bonuses: "weakness: vampire au grand jour",
    });
    expect(r.bonus_dice).toBe(-1);
    expect(poolSize(r)).toBe(1);
  });

  it("le palier des compétences engagées pèse sur la poignée", () => {
    const acquired: SkillEntry[] = [
      { name: "Acrobatie", tier: "maîtrise" },
      { name: "Crochetage", tier: "apprentissage" },
    ];
    const base = normalizeRollRequest({
      reason: "franchir le vide",
      skills: ["Acrobatie"],
    });
    const withTier = applySkillTiers(base, acquired);
    expect(withTier.bonus_dice).toBe(1);
    expect(withTier.bonuses).toEqual([
      { source: "skill", why: "Acrobatie, maîtrise" },
    ]);

    // Un acquis encore fragile ne donne pas de dé.
    const learning = applySkillTiers(
      normalizeRollRequest({ reason: "crocheter", skills: ["Crochetage"] }),
      acquired,
    );
    expect(learning.bonus_dice).toBe(0);
    expect(learning.bonuses).toEqual([]);
  });

  it("retire un bonus de compétence réclamé sans acquis derrière", () => {
    const claimed = normalizeRollRequest({
      reason: "escalade",
      bonuses: "temperament: casse-cou ; skill: Escalade",
      skills: ["Escalade"],
    });
    expect(claimed.bonus_dice).toBe(2);
    const checked = applySkillTiers(claimed, [
      { name: "Escalade", tier: "découverte" },
    ]);
    expect(checked.bonus_dice).toBe(1);
    expect(checked.bonuses).toEqual([
      { source: "temperament", why: "casse-cou" },
    ]);
  });

  it("garde le meilleur palier quand plusieurs compétences sont engagées", () => {
    const r = applySkillTiers(
      normalizeRollRequest({
        reason: "duel de sigils",
        skills: ["Sigils", "Esquive"],
      }),
      [
        { name: "Esquive", tier: "maîtrise" },
        { name: "Sigils", tier: "inné" },
      ],
    );
    expect(r.bonuses).toEqual([{ source: "skill", why: "Sigils, inné" }]);
  });

  it("le cumul peut dépasser le plafond, la poignée est écrêtée", () => {
    const r = applySkillTiers(
      normalizeRollRequest({
        reason: "tout donner",
        bonuses: "temperament: x ; ability: y ; souffle",
        skills: ["Sigils"],
        stance: "advantage",
      }),
      [{ name: "Sigils", tier: "inné" }],
    );
    expect(r.bonus_dice).toBe(4);
    expect(poolSize(r)).toBe(MAX_POOL);
  });

  it("plafonne la poignée à MAX_POOL", () => {
    const r = normalizeRollRequest({
      reason: "tout donner",
      bonuses: "temperament: x ; ability: y ; souffle: point dépensé",
      stance: "advantage",
    });
    expect(r.bonus_dice).toBe(3);
    expect(poolSize(r)).toBe(MAX_POOL);
  });
});

describe("rollD6 / performRoll", () => {
  it("reste dans [1, 6]", () => {
    for (let i = 0; i < 500; i++) {
      const value = rollD6();
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("lance autant de dés que la poignée et retient exactement un dé", () => {
    for (let i = 0; i < 100; i++) {
      const request = req({ bonus_dice: 2, stance: "advantage" });
      const r = performRoll(request);
      expect(r.dice).toHaveLength(4);
      expect(r.dice.filter((d) => d.kept)).toHaveLength(1);
      expect(r.value).toBe(r.dice.find((d) => d.kept)!.value);
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

describe("sanitizeSkills (skills_json / PUT client)", () => {
  it("nettoie entrées cassées, normalise paliers, fusionne doublons", () => {
    expect(
      sanitizeSkills([
        { name: "Feu", tier: "maitrise", note: "flamme nue" },
        { name: "Feu", tier: "découverte" }, // doublon plus faible : ignoré
        { name: "Vol", tier: "cosmique" }, // palier inconnu : écarté
        "pas un objet",
        { name: 42, tier: "inné" },
        null,
      ]),
    ).toEqual([{ name: "Feu", tier: "maîtrise", note: "flamme nue" }]);
    expect(sanitizeSkills("oops")).toEqual([]);
    expect(sanitizeSkills(undefined)).toEqual([]);
  });
});

describe("mergeSkills (fin de session → personnage)", () => {
  it("upsert sans régression, sans muter la liste persistée", () => {
    const saved: SkillEntry[] = [
      { name: "Marche-faille", tier: "maîtrise", note: "3 m" },
      { name: "Chant", tier: "découverte" },
    ];
    const merged = mergeSkills(saved, [
      { name: "marche-faille", tier: "découverte" }, // régression : ignorée
      { name: "Chant", tier: "apprentissage", note: "voix claire" },
      { name: "Forge", tier: "découverte" },
    ]);
    expect(merged).toEqual([
      { name: "Marche-faille", tier: "maîtrise", note: "3 m" },
      { name: "Chant", tier: "apprentissage", note: "voix claire" },
      { name: "Forge", tier: "découverte" },
    ]);
    expect(saved[1]).toEqual({ name: "Chant", tier: "découverte" });
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
