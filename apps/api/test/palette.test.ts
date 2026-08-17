// Palettes d'ambiance : le modèle écrit ce qu'il veut dans une chaîne — le
// schéma de sortie ne sait pas contraindre un format. La tolérance de lecture
// est donc la seule chose qui empêche une lecture d'ambiance de mourir sur une
// couleur mal écrite.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE,
  describeAnalysisPayload,
  normalizeHex,
  parseAnalysisPayload,
  parsePalette,
  PALETTE_KEYS,
} from "../src/bibles/palette";

const colors = (over: Record<string, unknown> = {}) => ({
  void: "#12081f",
  nebula: "#2a1548",
  arcane: "#7c3aed",
  spirit: "#67e8f9",
  ember: "#f97316",
  parchment: "#f3ede4",
  parchment_dim: "#b8aecb",
  line: "#4b2f7a",
  ...over,
});

describe("normalizeHex", () => {
  it("accepte les formes que le modèle écrit vraiment", () => {
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("aabbcc")).toBe("#aabbcc"); // dièse oublié
    expect(normalizeHex("#aabbccff")).toBe("#aabbcc"); // alpha ignoré
    expect(normalizeHex("rgb(18, 8, 31)")).toBe("#12081f");
    expect(normalizeHex("rgba(18 8 31 / 0.5)")).toBe("#12081f");
    expect(normalizeHex("rgb(100%, 0%, 0%)")).toBe("#ff0000");
  });

  it("refuse ce qui n'est pas une couleur", () => {
    expect(normalizeHex("noir profond")).toBe(null);
    expect(normalizeHex("#12345")).toBe(null);
    expect(normalizeHex("rgb(12)")).toBe(null);
    expect(normalizeHex(null)).toBe(null);
  });
});

describe("parsePalette", () => {
  it("emprunte au défaut jusqu'à deux couleurs illisibles", () => {
    const palette = parsePalette({
      name: "Néon mouillé",
      mood: "Ruelles trempées",
      colors: colors({ ember: "orange brûlé", line: undefined }),
    });
    expect(palette).not.toBe(null);
    expect(palette!.colors.ember).toBe(DEFAULT_PALETTE.colors.ember);
    expect(palette!.colors.line).toBe(DEFAULT_PALETTE.colors.line);
    expect(palette!.colors.arcane).toBe("#7c3aed"); // les siennes sont gardées
  });

  it("écarte la palette au-delà : ce ne serait plus la sienne", () => {
    expect(
      parsePalette({
        name: "Vide",
        colors: colors({ ember: "x", line: "y", spirit: "z" }),
      }),
    ).toBe(null);
  });
});

describe("parseAnalysisPayload", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    analysis_md: "Lumière froide, béton mouillé.",
    palettes: [{ name: "Néon", mood: "Nuit", colors: colors() }],
    ...over,
  });

  it("accepte une lecture d'ambiance complète", () => {
    const result = parseAnalysisPayload(payload());
    expect(result?.palettes).toHaveLength(1);
  });

  it("dit ce qui manque quand elle refuse", () => {
    // Une palette dont trop de couleurs sont hors format.
    const bad = payload({
      palettes: [
        { name: "Flou", colors: colors({ void: "noir", nebula: "gris", arcane: "violet" }) },
      ],
    });
    expect(parseAnalysisPayload(bad)).toBe(null);
    const said = describeAnalysisPayload(bad);
    expect(said).toContain("1 palette(s)");
    expect(said).toContain("void");
    expect(said).toContain("arcane");

    expect(describeAnalysisPayload(payload({ analysis_md: "  " }))).toBe(
      "analysis_md vide",
    );
  });

  it("nomme toutes les couleurs quand il n'y a pas de palette du tout", () => {
    const said = describeAnalysisPayload(payload({ palettes: [] }));
    for (const key of PALETTE_KEYS) expect(said).toContain(key);
  });
});
