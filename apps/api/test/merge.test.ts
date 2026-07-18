// M5 — fusion pure d'une proposition acceptée dans canon_md.

import { describe, expect, it } from "vitest";
import { mergeProposal } from "../src/bibles/merge";

const CANON = "# Les Mondes Fêlés\n\nLa magie vient des failles.\n";

describe("mergeProposal", () => {
  it("crée la section « Canonisé en session » au premier accept", () => {
    const out = mergeProposal(CANON, "La cité-pont de Vhal.", "geography");
    expect(out).toBe(
      "# Les Mondes Fêlés\n\nLa magie vient des failles." +
        "\n\n## Canonisé en session\n\n### Géographie\n\nLa cité-pont de Vhal.\n",
    );
  });

  it("ne duplique pas la section aux accepts suivants", () => {
    const first = mergeProposal(CANON, "La cité-pont de Vhal.", "geography");
    const second = mergeProposal(first, "Maître Orin, cartographe.", "characters");
    expect(second.match(/## Canonisé en session/g)).toHaveLength(1);
    expect(second).toContain("### Géographie\n\nLa cité-pont de Vhal.");
    expect(second.trimEnd().endsWith("### Personnages\n\nMaître Orin, cartographe.")).toBe(true);
  });

  it("garde tel quel un axe inconnu", () => {
    const out = mergeProposal(CANON, "Contenu.", "mystery");
    expect(out).toContain("### mystery\n\nContenu.");
  });

  it("ignore une mention de la section en pleine ligne de texte", () => {
    const canon = "# Titre\n\nOn parle du ## Canonisé en session ailleurs.\n";
    const out = mergeProposal(canon, "Ajout.", "tone");
    expect(out).toContain("\n## Canonisé en session\n");
  });
});
