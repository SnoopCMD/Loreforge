import { describe, expect, it } from "vitest";
import {
  AXES,
  buildRichnessPrompt,
  computeGlobal,
  MAX_CANON_CHARS,
  parseRichnessPayload,
} from "../src/richness/logic";

const validPayload = {
  cosmology: 9,
  characters: 6,
  plots: 8,
  tone: 5,
  geography: 4,
  gaps: [
    { axis: "geography", description: "Aucune carte des Mondes." },
    { axis: "tone", description: "Registre de violence implicite." },
  ],
};

describe("parseRichnessPayload", () => {
  it("accepte une sortie conforme", () => {
    const result = parseRichnessPayload(validPayload);
    expect(result).not.toBeNull();
    expect(result?.scores.cosmology).toBe(9);
    expect(result?.gaps).toHaveLength(2);
  });

  it("ramène les scores hors bornes dans [0, 10] et arrondit", () => {
    const result = parseRichnessPayload({
      ...validPayload,
      cosmology: 15,
      characters: -3,
      plots: 7.6,
    });
    expect(result?.scores.cosmology).toBe(10);
    expect(result?.scores.characters).toBe(0);
    expect(result?.scores.plots).toBe(8);
  });

  it("rejette un axe manquant ou non numérique", () => {
    const { cosmology: _omitted, ...missing } = validPayload;
    expect(parseRichnessPayload(missing)).toBeNull();
    expect(parseRichnessPayload({ ...validPayload, tone: "fort" })).toBeNull();
    expect(parseRichnessPayload({ ...validPayload, plots: NaN })).toBeNull();
  });

  it("rejette des gaps mal formés", () => {
    expect(parseRichnessPayload({ ...validPayload, gaps: "aucun" })).toBeNull();
    expect(
      parseRichnessPayload({
        ...validPayload,
        gaps: [{ axis: "meteo", description: "x" }],
      }),
    ).toBeNull();
    expect(
      parseRichnessPayload({
        ...validPayload,
        gaps: [{ axis: "tone", description: "   " }],
      }),
    ).toBeNull();
  });

  it("rejette null et les scalaires", () => {
    expect(parseRichnessPayload(null)).toBeNull();
    expect(parseRichnessPayload("json")).toBeNull();
  });
});

describe("computeGlobal", () => {
  it("moyenne arrondie des 5 axes", () => {
    expect(
      computeGlobal({ cosmology: 9, characters: 6, plots: 8, tone: 5, geography: 4 }),
    ).toBe(6); // 32/5 = 6.4
    expect(
      computeGlobal({ cosmology: 10, characters: 10, plots: 10, tone: 10, geography: 10 }),
    ).toBe(10);
    expect(
      computeGlobal({ cosmology: 0, characters: 0, plots: 0, tone: 0, geography: 0 }),
    ).toBe(0);
  });
});

describe("buildRichnessPrompt", () => {
  it("contient le canon et les 5 axes", () => {
    const prompt = buildRichnessPrompt("# Mon Univers\n\nLore unique XYZZY.");
    expect(prompt).toContain("XYZZY");
    for (const axis of AXES) expect(prompt).toContain(axis);
  });

  it("tronque les bibles trop grandes", () => {
    const prompt = buildRichnessPrompt("x".repeat(MAX_CANON_CHARS + 5000));
    // Marge = taille des instructions du prompt (hors bible), généreuse.
    expect(prompt.length).toBeLessThan(MAX_CANON_CHARS + 4000);
    expect(prompt).toContain("bible tronquée");
  });
});
