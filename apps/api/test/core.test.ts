// §8.3 — @app/core : logique front sans DOM (source : public/core.js).

import { describe, expect, it } from "vitest";
import {
  createSpeechSegmenter,
  createSseParser,
  extractActionChips,
  mdToHtml,
  // @ts-expect-error — module JS servi tel quel au front, sans types.
} from "../public/core.js";

/** Rejoue un texte dans le segmenteur en le coupant en petits deltas. */
function speak(text: string, step = 5): string[] {
  const seg = createSpeechSegmenter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    for (const s of seg.push(text.slice(i, i + step))) out.push(s);
  }
  for (const s of seg.flush()) out.push(s);
  return out;
}

describe("createSseParser", () => {
  it("découpe les frames même coupées en plein milieu par les chunks", () => {
    const events: Array<[string, unknown]> = [];
    const parser = createSseParser((e: string, d: unknown) => events.push([e, d]));
    parser.push('event: narration\ndata: {"te');
    parser.push('xt":"Bonjour"}\n\nevent: do');
    parser.push('ne\ndata: {"turn":2}\n\n');
    expect(events).toEqual([
      ["narration", { text: "Bonjour" }],
      ["done", { turn: 2 }],
    ]);
  });
});

describe("extractActionChips", () => {
  it("extrait les options finales du tour MJ", () => {
    const text =
      "La porte grince.\n\nQue fais-tu ?\n- Pousser la porte\n- Écouter derrière ;\n3) Reculer dans l'ombre.";
    expect(extractActionChips(text)).toEqual([
      "Pousser la porte",
      "Écouter derrière",
      "Reculer dans l'ombre",
    ]);
  });

  it("reste muet sans liste finale ou avec trop d'options", () => {
    expect(extractActionChips("Rien à proposer ici.")).toEqual([]);
    expect(extractActionChips("- Une seule option")).toEqual([]);
    const seven = Array.from({ length: 7 }, (_, i) => `- Option numéro ${i}`).join("\n");
    expect(extractActionChips("Choix :\n" + seven)).toEqual([]);
  });

  it("tolère jusqu'à 6 options, gras et libellés longs compris", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- Option ${i}`).join("\n");
    expect(extractActionChips(six)).toHaveLength(6);
    const long = "- " + "Négocier ".repeat(15).trim(); // > 120 caractères
    const text = "- **Fuir** vers la forêt\n" + long;
    expect(extractActionChips(text)).toEqual([
      "**Fuir** vers la forêt",
      "Négocier ".repeat(15).trim(),
    ]);
  });
});

describe("createSpeechSegmenter", () => {
  it("découpe en phrases quel que soit le découpage des deltas", () => {
    const text =
      "La pluie masque le bruit. Skorn ne bouge pas — son regard se durcit.\n\n" +
      "Le silence retombe, lourd.";
    const expected = [
      "La pluie masque le bruit.",
      "Skorn ne bouge pas — son regard se durcit.",
      "Le silence retombe, lourd.",
    ];
    expect(speak(text, 3)).toEqual(expected);
    expect(speak(text, 1)).toEqual(expected);
    expect(speak(text, 1000)).toEqual(expected);
  });

  it("ne lit pas les options finales (puces/numéros) ni le « 1. » seul", () => {
    const text =
      "Tu débouches dans la cour. Que fais-tu ?\n\n" +
      "- Foncer vers le van\n" +
      "2. Attendre dans l'ombre\n" +
      "3) Interpeller l'homme au tatouage";
    expect(speak(text, 4)).toEqual([
      "Tu débouches dans la cour.",
      "Que fais-tu ?",
    ]);
  });

  it("ne coupe pas sur une décimale et garde le reliquat jusqu'au flush", () => {
    const seg = createSpeechSegmenter();
    expect(seg.push("Il reste 3.5 litres")).toEqual([]); // pas de fin de phrase
    expect(seg.push(" d'eau. Puis ")).toEqual(["Il reste 3.5 litres d'eau."]);
    expect(seg.flush()).toEqual(["Puis"]);
  });
});

describe("mdToHtml", () => {
  it("rend titres, listes et gras — tout échappé", () => {
    const html = mdToHtml("## Résumé\n\n- Un **fait**\n\n<script>x</script>");
    expect(html).toContain("<h2>Résumé</h2>");
    expect(html).toContain("<li>Un <b>fait</b></li>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
