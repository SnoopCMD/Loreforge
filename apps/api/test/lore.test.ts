import { describe, expect, it } from "vitest";
import {
  buildFiche,
  buildLoreUserMessage,
  collectCanonSources,
  collectLoreSources,
  collectSessionSources,
  loreSignature,
  normalizeKind,
  toProse,
  type SessionInvention,
} from "../src/sessions/lore";

const CANON = `# Les Mondes Fêlés

La magie vient des failles entre les Mondes.

## La Garde Blanche

La Garde Blanche est l'ordre militaire qui scelle les failles. Ses chevaliers
portent le sel-de-lune. Elle répond au Commandant Aurélio Kass.

## Karnos

Karnos est une cité-pont bâtie au-dessus de la plus grande faille connue.

## Casting secondaire

| Nom | Masque | Statut |
|---|---|---|
| **Russell** | Lézard | À développer. |
| *(Lynx)* | Lynx | Slot réservé — personnage à créer. |`;

describe("collectCanonSources (§7) — matière première, pas la fiche", () => {
  it("préfère la section dont le titre porte le terme", () => {
    const sources = collectCanonSources(CANON, "Garde Blanche");
    expect(sources.join(" ")).toContain("ordre militaire qui scelle les failles");
    expect(sources.join(" ")).not.toContain("cité-pont");
  });

  it("remonte le paragraphe mentionnant un terme sans section dédiée", () => {
    expect(collectCanonSources(CANON, "Aurélio Kass").join(" ")).toContain(
      "Aurélio Kass",
    );
  });

  it("remonte une ligne de tableau avec son en-tête de colonnes", () => {
    const sources = collectCanonSources(CANON, "Russell");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain("| Nom | Masque | Statut |");
    expect(sources[0]).toContain("Russell");
    // La ligne du Lynx (autre slot) ne pollue pas la fiche de Russell.
    expect(sources[0]).not.toContain("Lynx");
  });

  it("vide quand le terme est absent du canon", () => {
    expect(collectCanonSources(CANON, "les Ombres Grises")).toEqual([]);
  });
});

describe("collectSessionSources", () => {
  const inventions: SessionInvention[] = [
    { axis: "geography", content: "Le village de Karnos borde la faille.", turn: 1 },
    { axis: "characters", content: "Vieil Orin, cartographe aveugle de la cité.", turn: 3 },
  ];

  it("remonte la narration la plus récente citant le terme", () => {
    const narration = [
      "Rien d'utile ici.",
      "Le Fossoyeur traverse la place. Sa pelle racle les pavés. Nul ne le regarde.",
    ];
    const sources = collectSessionSources([], narration, "Fossoyeur");
    expect(sources[0]).toContain("Sa pelle racle les pavés");
  });

  it("remonte aussi les inventions loggées", () => {
    expect(collectSessionSources(inventions, [], "Orin").join(" ")).toContain(
      "cartographe aveugle",
    );
  });

  it("vide quand rien ne matche", () => {
    expect(collectSessionSources(inventions, ["nuit calme"], "la Source")).toEqual([]);
  });
});

describe("loreSignature — fraîcheur du cache", () => {
  it("change dès qu'un nouveau tour parle du terme", () => {
    const before = collectLoreSources(CANON, [], ["Une ombre passe."], "Fossoyeur");
    const after = collectLoreSources(
      CANON,
      [],
      ["Une ombre passe.", "Le Fossoyeur relève la tête."],
      "Fossoyeur",
    );
    expect(loreSignature(before)).not.toBe(loreSignature(after));
  });

  it("stable tant que rien ne bouge", () => {
    const a = collectLoreSources(CANON, [], ["Karnos dort."], "Karnos");
    const b = collectLoreSources(CANON, [], ["Karnos dort."], "Karnos");
    expect(loreSignature(a)).toBe(loreSignature(b));
  });
});

describe("buildLoreUserMessage", () => {
  it("porte le terme, le canon et la narration de session", () => {
    const sources = collectLoreSources(
      CANON,
      [],
      ["Le Fossoyeur traverse la place."],
      "Fossoyeur",
    );
    const msg = buildLoreUserMessage({
      term: "Fossoyeur",
      kind: "personnage",
      sources,
      bibleTitle: "Les Mondes Fêlés",
      characterName: "Ilyara",
    });
    expect(msg).toContain("Terme : Fossoyeur");
    expect(msg).toContain("Ilyara");
    expect(msg).toContain("traverse la place");
    expect(msg).toContain("(rien)"); // canon muet sur ce terme
  });
});

describe("toProse — aucun contenu brut n'atteint le popup", () => {
  it("aplatit une ligne de tableau markdown", () => {
    const out = toProse("||**Russell**|Lézard|À développer.||");
    expect(out).not.toContain("|");
    expect(out).not.toContain("**");
    expect(out).toContain("Russell");
  });

  it("retire titres, puces et emphase", () => {
    const out = toProse("## Karnos\n\n- *cité-pont*\n- au-dessus de la faille");
    expect(out).toBe("Karnos cité-pont au-dessus de la faille");
  });

  it("laisse la prose intacte", () => {
    const prose =
      "Le Fossoyeur arpente la place, pelle à l'épaule. Personne ne croise son regard.";
    expect(toProse(prose)).toBe(prose);
  });
});

describe("buildFiche", () => {
  it("marque in_canon selon la présence de sources de bible", () => {
    const withCanon = buildFiche(
      "Karnos",
      "lieu",
      collectLoreSources(CANON, [], [], "Karnos"),
      "Karnos est une cité suspendue au-dessus du vide.",
    );
    expect(withCanon.in_canon).toBe(true);
    expect(withCanon.kind).toBe("lieu");

    const invented = buildFiche(
      "Fossoyeur",
      null,
      collectLoreSources(CANON, [], ["Le Fossoyeur passe."], "Fossoyeur"),
      "Une silhouette voûtée, pelle à l'épaule.",
    );
    expect(invented.in_canon).toBe(false);
    expect(invented.kind).toBe("concept");
  });

  it("normalise le kind", () => {
    expect(normalizeKind("PERSONNAGE")).toBe("personnage");
    expect(normalizeKind("machin")).toBe("concept");
    expect(normalizeKind(null)).toBe("concept");
  });
});
