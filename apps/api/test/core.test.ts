// §8.3 — @app/core : logique front sans DOM (source : public/core.js).

import { describe, expect, it } from "vitest";
// @ts-expect-error — module JS servi tel quel au front, sans types.
import { createSseParser, extractActionChips, mdToHtml } from "../public/core.js";

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
    const five = Array.from({ length: 5 }, (_, i) => `- Option numéro ${i}`).join("\n");
    expect(extractActionChips("Choix :\n" + five)).toEqual([]);
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
