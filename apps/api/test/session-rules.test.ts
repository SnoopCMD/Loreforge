import { describe, expect, it } from "vitest";
import {
  applySouffleDelta,
  describeOutcome,
  initialGameState,
  outcomeForRoll,
  rollD6,
  SOUFFLE_MAX,
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
  it("3 Souffle, aucun fait, aucun jet", () => {
    expect(initialGameState()).toEqual({
      souffle: SOUFFLE_MAX,
      facts: [],
      pending_roll: null,
      last_roll: null,
      turn_count: 0,
    });
  });
});
