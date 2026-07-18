// M6 — RAG bible : logique pure (seuil, chunking, re-ranking, assemblage).

import { describe, expect, it } from "vitest";
import {
  assembleExcerpts,
  buildRagQuery,
  CHUNK_CHARS,
  chunkCanon,
  needsRag,
  RAG_THRESHOLD_CHARS,
  rerankMatches,
} from "../src/rag/logic";

function bigCanon(): string {
  const sections: string[] = ["# L'Empire des Brumes"];
  for (let i = 0; i < 40; i++) {
    sections.push(
      `## Province ${i}`,
      `La province ${i} s'étend sur des lieues. ${"Ses collines ondulent sous un ciel de cendre. ".repeat(60)}`,
    );
  }
  return sections.join("\n\n");
}

describe("needsRag", () => {
  it("déclenche au-delà du seuil seulement", () => {
    expect(needsRag("x".repeat(RAG_THRESHOLD_CHARS))).toBe(false);
    expect(needsRag("x".repeat(RAG_THRESHOLD_CHARS + 1))).toBe(true);
  });
});

describe("chunkCanon", () => {
  it("découpe en chunks bornés, indexés, avec section et recouvrement", () => {
    const chunks = chunkCanon(bigCanon());
    expect(chunks.length).toBeGreaterThan(10);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
    // Taille bornée (marge : une ligne peut dépasser le seuil de découpe).
    for (const c of chunks) expect(c.text.length).toBeLessThan(CHUNK_CHARS * 2.5);
    // Les sections suivent les titres.
    expect(chunks.some((c) => c.section.startsWith("Province"))).toBe(true);
    // Recouvrement : le début d'un chunk reprend la fin du précédent.
    const tail = chunks[1].text.slice(0, 80);
    expect(chunks[0].text).toContain(tail.split("\n")[0].slice(0, 40));
  });

  it("est déterministe", () => {
    const canon = bigCanon();
    expect(chunkCanon(canon)).toEqual(chunkCanon(canon));
  });
});

describe("rerankMatches", () => {
  const chunks = [
    { index: 0, section: "Cosmologie", text: "Les brumes dévorent la lumière." },
    { index: 1, section: "La trame du Sel", text: "Le commerce du sel unit les provinces." },
    { index: 2, section: "Personnages", text: "Kael la Cendrée garde la porte." },
  ];

  it("dope trame et personnages en scène, rend l'ordre du canon", () => {
    const matches = [
      { index: 0, score: 0.80, section: "Cosmologie" },
      { index: 1, score: 0.75, section: "La trame du Sel" },
      { index: 2, score: 0.74, section: "Personnages" },
    ];
    const kept = rerankMatches(matches, chunks, {
      trame: "le commerce du sel",
      names: ["Kael"],
    }, 2);
    // 1 (0.75+0.08, « commerce ») et 2 (0.74+0.08, « Kael ») dépassent
    // 0 (0.80) — et l'ordre rendu est celui du canon.
    expect(kept).toEqual([1, 2]);
  });

  it("sans indices, garde simplement les meilleurs scores", () => {
    const matches = [
      { index: 2, score: 0.9, section: "" },
      { index: 0, score: 0.5, section: "" },
      { index: 1, score: 0.7, section: "" },
    ];
    expect(rerankMatches(matches, chunks, { trame: null, names: [] }, 2)).toEqual([1, 2]);
  });
});

describe("assemblage et requête", () => {
  it("assemble les extraits avec rappel de section", () => {
    const out = assembleExcerpts(
      [
        { index: 0, section: "Cosmologie", text: "A" },
        { index: 1, section: "", text: "B" },
      ],
      [0, 1],
    );
    expect(out).toContain("[Extrait — Cosmologie]\nA");
    expect(out).toContain("[Extrait — début de la bible]\nB");
    expect(out).toContain("[...]");
  });

  it("la requête combine action, trame et personnages", () => {
    const q = buildRagQuery("Je fouille la crypte", {
      trame: "La route du sel",
      names: ["Kael"],
    });
    expect(q).toContain("Je fouille la crypte");
    expect(q).toContain("Trame : La route du sel");
    expect(q).toContain("Kael");
  });
});
