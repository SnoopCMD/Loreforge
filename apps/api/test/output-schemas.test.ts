// Garde-fou sur les schémas de sortie structurée : l'API n'accepte qu'un
// sous-ensemble de JSON Schema, et le refus arrive en 400 à l'exécution — donc
// en production, pas ici. Un `minItems: 2` a coûté une lecture d'ambiance ;
// ce test empêche la prochaine.

import { describe, expect, it } from "vitest";
import { MOODBOARD_OUTPUT_SCHEMA } from "../src/bibles/palette";
import { RICHNESS_OUTPUT_SCHEMA } from "../src/richness/logic";
import {
  SHEET_FIELD_OUTPUT_SCHEMA,
  SHEET_PAIRS_OUTPUT_SCHEMA,
} from "../src/characters/schema";

const SCHEMAS: Record<string, unknown> = {
  MOODBOARD_OUTPUT_SCHEMA,
  RICHNESS_OUTPUT_SCHEMA,
  SHEET_FIELD_OUTPUT_SCHEMA,
  SHEET_PAIRS_OUTPUT_SCHEMA,
};

/** Mots-clés que les sorties structurées refusent ou ignorent. */
const FORBIDDEN = ["maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum"];

/** Chemins de tous les nœuds objets du schéma, pour situer un manquement. */
function walk(node: unknown, path: string, visit: (n: Record<string, unknown>, p: string) => void) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`, visit));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  for (const [key, value] of Object.entries(obj)) {
    walk(value, `${path}.${key}`, visit);
  }
}

/** Manquements d'un schéma, chemin compris. */
function offencesOf(name: string, schema: unknown): string[] {
  const offences: string[] = [];
  walk(schema, name, (node, path) => {
    // minItems n'est supporté qu'à 0 ou 1.
    if ("minItems" in node && node.minItems !== 0 && node.minItems !== 1) {
      offences.push(`${path}.minItems = ${String(node.minItems)}`);
    }
    for (const key of FORBIDDEN) {
      if (key in node) offences.push(`${path}.${key}`);
    }
  });
  return offences;
}

describe("schémas de sortie structurée", () => {
  // Le garde-fou doit mordre : c'est exactement la forme qui a valu un 400.
  it("repère un schéma fautif", () => {
    const bad = {
      type: "object",
      properties: {
        palettes: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
      },
    };
    expect(offencesOf("bad", bad)).toEqual([
      "bad.properties.palettes.minItems = 2",
      "bad.properties.palettes.maxItems",
    ]);
  });

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} n'emploie que ce que l'API accepte`, () => {
      expect(offencesOf(name, schema)).toEqual([]);
    });
  }
});
