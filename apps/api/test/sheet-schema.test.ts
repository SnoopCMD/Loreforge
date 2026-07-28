// §6bis — logique pure des fiches dynamiques.

import { describe, expect, it } from "vitest";
import {
  BASE_FIELDS,
  normalizeSheetFields,
  pairsToSheet,
  parsePlayableCharacters,
} from "../src/characters/schema";

describe("normalizeSheetFields", () => {
  it("garde toujours les champs de base, même sur une sortie vide", () => {
    const { fields } = normalizeSheetFields([]);
    expect(fields.map((f) => f.key)).toEqual(BASE_FIELDS.map((f) => f.key));
    expect(fields[0].required).toBe(true); // name
  });

  it("fusionne les suggestions du modèle dans un champ de base et ajoute les champs spécifiques", () => {
    const { fields } = normalizeSheetFields([
      {
        key: "temperament", label: "Tempérament", type: "text",
        options: [], suggestions: ["Fervent", "Sceptique"], hint: "",
      },
      {
        key: "Dieu Patron", label: "Dieu patron", type: "select",
        options: ["Vhal", "Orin", "Inconnu"], suggestions: [], hint: "Choisi à la naissance",
      },
    ]);
    const temperament = fields.find((f) => f.key === "temperament")!;
    expect(temperament.suggestions).toEqual(["Fervent", "Sceptique"]);
    expect(temperament.type).toBe("text");
    const god = fields.find((f) => f.key === "dieu_patron")!;
    expect(god.type).toBe("select");
    expect(god.options).toEqual(["Vhal", "Orin", "Inconnu"]);
    expect(god.hint).toBe("Choisi à la naissance");
  });

  it("ignore doublons et entrées invalides, un select sans options devient text", () => {
    const { fields } = normalizeSheetFields([
      { key: "faction", label: "Allégeance", type: "select", options: [], suggestions: [], hint: "" },
      { key: "faction", label: "Doublon", type: "text", options: [], suggestions: [], hint: "" },
      { key: "", label: "Sans clé", type: "text", options: [], suggestions: [], hint: "" },
      42,
    ]);
    const factions = fields.filter((f) => f.key === "faction");
    expect(factions).toHaveLength(1);
    expect(factions[0].type).toBe("text");
    expect(fields.some((f) => f.key === "")).toBe(false);
  });

  it("fiche adaptative : conditions gardées, références cassées écartées", () => {
    const { fields } = normalizeSheetFields([
      {
        key: "classe", label: "Classe", type: "select",
        options: ["Mortel", "Dieu"], suggestions: [], hint: "",
      },
      {
        key: "dieu_patron", label: "Dieu patron", type: "select",
        options: ["Vhal", "Orin"], suggestions: [], hint: "",
        hide_if: [{ field: "Classe", values: ["Dieu"] }],
      },
      {
        key: "ecole", label: "École", type: "select",
        options: ["Brume", "Sel"], suggestions: [], hint: "",
        show_if: [
          { field: "voie_inexistante", values: ["Passeur"] }, // réf. cassée
          { field: "ecole", values: ["Brume"] }, // auto-référence
          { field: "classe", values: ["Mortel"] },
        ],
      },
    ]);
    const god = fields.find((f) => f.key === "dieu_patron")!;
    expect(god.hide_if).toEqual([{ field: "classe", values: ["Dieu"] }]);
    const school = fields.find((f) => f.key === "ecole")!;
    expect(school.show_if).toEqual([{ field: "classe", values: ["Mortel"] }]);
    // Les champs de base restent inconditionnels.
    expect(fields.find((f) => f.key === "name")!.hide_if).toEqual([]);
  });
});

describe("pairsToSheet", () => {
  it("convertit les paires en objet, ignore vides et doublons", () => {
    expect(
      pairsToSheet([
        { key: "name", value: "Kael" },
        { key: "name", value: "Autre" },
        { key: "concept", value: " Éclaireur des failles " },
        { key: "", value: "x" },
        { key: "vide", value: "" },
      ]),
    ).toEqual({ name: "Kael", concept: "Éclaireur des failles" });
  });
});

describe("parsePlayableCharacters", () => {
  it("déduplique par nom (insensible à la casse) et borne à 8", () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({
      name: i < 2 ? "kael" : `Perso ${i}`,
      sheet: [{ key: "concept", value: "..." }],
    }));
    const out = parsePlayableCharacters(raw);
    expect(out).toHaveLength(8);
    expect(out.filter((p) => p.name.toLowerCase() === "kael")).toHaveLength(1);
    expect(out[0].sheet).toEqual({ concept: "..." });
  });
});
