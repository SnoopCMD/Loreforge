import { describe, expect, it } from "vitest";
import {
  defineFromCanon,
  defineFromInventions,
  normalizeKind,
  resolveLore,
  type SessionInvention,
} from "../src/sessions/lore";

const CANON = `# Les Mondes Fêlés

La magie vient des failles entre les Mondes.

## La Garde Blanche

La Garde Blanche est l'ordre militaire qui scelle les failles. Ses chevaliers
portent le sel-de-lune. Elle répond au Commandant Aurélio Kass.

## Karnos

Karnos est une cité-pont bâtie au-dessus de la plus grande faille connue.`;

describe("defineFromCanon (§7)", () => {
  it("préfère la section dont le titre porte le terme", () => {
    const def = defineFromCanon(CANON, "Garde Blanche");
    expect(def).toContain("ordre militaire qui scelle les failles");
    expect(def).not.toContain("cité-pont"); // pas la section Karnos
  });

  it("retombe sur le 1er paragraphe mentionnant le terme", () => {
    const def = defineFromCanon(CANON, "Aurélio Kass");
    expect(def).toContain("Aurélio Kass");
  });

  it("null quand le terme est absent du canon", () => {
    expect(defineFromCanon(CANON, "les Ombres Grises")).toBeNull();
  });
});

describe("defineFromInventions", () => {
  const inventions: SessionInvention[] = [
    { axis: "geography", content: "Le village de Karnos borde la faille.", turn: 1 },
    { axis: "characters", content: "Vieil Orin, cartographe aveugle de la cité.", turn: 3 },
  ];

  it("trouve l'invention la plus récente mentionnant le terme", () => {
    expect(defineFromInventions(inventions, "Orin")).toContain("cartographe aveugle");
  });

  it("null quand aucune invention ne matche", () => {
    expect(defineFromInventions(inventions, "la Source")).toBeNull();
  });
});

describe("resolveLore — jamais de terme mort", () => {
  it("canon d'abord (in_canon = true)", () => {
    const fiche = resolveLore(CANON, [], "Karnos", "lieu");
    expect(fiche.in_canon).toBe(true);
    expect(fiche.kind).toBe("lieu");
    expect(fiche.definition).toContain("cité-pont");
  });

  it("repli inventions de session (in_canon = false)", () => {
    const inv: SessionInvention[] = [
      { axis: "characters", content: "Nyra, la contrebandière des brumes.", turn: 2 },
    ];
    const fiche = resolveLore(CANON, inv, "Nyra", "personnage");
    expect(fiche.in_canon).toBe(false);
    expect(fiche.definition).toContain("contrebandière");
  });

  it("repli générique quand rien n'est connu", () => {
    const fiche = resolveLore(CANON, [], "Le Chœur Muet", "concept");
    expect(fiche.in_canon).toBe(false);
    expect(fiche.definition).toContain("Le Chœur Muet");
    expect(fiche.definition).toContain("au fil de cette session");
  });

  it("normalise le kind vers 'concept' par défaut", () => {
    expect(normalizeKind("PERSONNAGE")).toBe("personnage");
    expect(normalizeKind("machin")).toBe("concept");
    expect(normalizeKind(null)).toBe("concept");
  });
});
