import { describe, expect, it } from "vitest";
import {
  DEFAULT_TITLE,
  isUsableMarkdown,
  normalizeMarkdown,
  serializeToneProfile,
} from "../src/bibles/normalize";

describe("normalizeMarkdown", () => {
  it("extrait le titre du premier H1", () => {
    const { title, canonMd } = normalizeMarkdown("# Les Mondes Fêlés\n\nTexte.");
    expect(title).toBe("Les Mondes Fêlés");
    expect(canonMd).toBe("# Les Mondes Fêlés\n\nTexte.\n");
  });

  it("normalise CRLF, BOM et espaces traînants", () => {
    const { canonMd } = normalizeMarkdown("﻿# Titre  \r\n\r\nDu texte.  \r\n");
    expect(canonMd).toBe("# Titre\n\nDu texte.\n");
  });

  it("convertit les titres setext en ATX", () => {
    const { title, canonMd } = normalizeMarkdown(
      "Cosmogonie\n==========\n\nSection\n-------\n\nTexte.",
    );
    expect(title).toBe("Cosmogonie");
    expect(canonMd).toBe("# Cosmogonie\n\n## Section\n\nTexte.\n");
  });

  it("canonise les titres ATX (espaces, # de fermeture)", () => {
    const { canonMd } = normalizeMarkdown("#Titre#\n\n##   Sous-titre  ##");
    expect(canonMd).toBe("# Titre\n\n## Sous-titre\n");
  });

  it("démote les H1 supplémentaires en H2", () => {
    const { title, canonMd } = normalizeMarkdown(
      "# Univers\n\n# Personnages\n\n# Lieux",
    );
    expect(title).toBe("Univers");
    expect(canonMd).toBe("# Univers\n\n## Personnages\n\n## Lieux\n");
  });

  it("insère un H1 depuis le titre de repli quand il n'y en a pas", () => {
    const { title, canonMd } = normalizeMarkdown("Juste du texte.", "Ma Bible");
    expect(title).toBe("Ma Bible");
    expect(canonMd).toBe("# Ma Bible\n\nJuste du texte.\n");
  });

  it("utilise le titre par défaut sans H1 ni repli", () => {
    const { title } = normalizeMarkdown("Du texte.");
    expect(title).toBe(DEFAULT_TITLE);
  });

  it("compacte les lignes vides multiples", () => {
    const { canonMd } = normalizeMarkdown("# T\n\n\n\nA\n\n\nB\n\n\n");
    expect(canonMd).toBe("# T\n\nA\n\nB\n");
  });

  it("ne touche pas au contenu des blocs de code", () => {
    const raw = "# T\n\n```\n#pas un titre\ntrailing  \n\n\n\nlignes gardées\n```\n";
    const { canonMd } = normalizeMarkdown(raw);
    expect(canonMd).toContain("#pas un titre");
    expect(canonMd).toContain("trailing  ");
    expect(canonMd).toContain("\n\n\n\nlignes gardées");
  });

  it("un H1 dans un bloc de code ne devient pas le titre", () => {
    const { title } = normalizeMarkdown("```\n# Faux titre\n```\n\n# Vrai titre");
    expect(title).toBe("Vrai titre");
  });

  it("ne confond pas une règle horizontale avec un setext", () => {
    const { canonMd } = normalizeMarkdown("# T\n\n---\n\nTexte.");
    expect(canonMd).toBe("# T\n\n---\n\nTexte.\n");
  });
});

describe("isUsableMarkdown", () => {
  it("rejette le vide et les espaces", () => {
    expect(isUsableMarkdown("")).toBe(false);
    expect(isUsableMarkdown("   \n\t\n")).toBe(false);
    expect(isUsableMarkdown("x")).toBe(true);
  });
});

describe("serializeToneProfile", () => {
  it("accepte un objet et le sérialise", () => {
    expect(serializeToneProfile({ registre: "sombre" })).toBe(
      '{"registre":"sombre"}',
    );
  });

  it("accepte une chaîne JSON d'objet", () => {
    expect(serializeToneProfile('{"humour":2}')).toBe('{"humour":2}');
  });

  it("rejette tableaux, scalaires, null et JSON invalide", () => {
    expect(serializeToneProfile([1, 2])).toBeNull();
    expect(serializeToneProfile("pas du json")).toBeNull();
    expect(serializeToneProfile(42)).toBeNull();
    expect(serializeToneProfile(null)).toBeNull();
  });
});
