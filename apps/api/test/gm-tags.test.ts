import { describe, expect, it } from "vitest";
import {
  extractGmEvents,
  GmStreamParser,
  stripGmTags,
  type GmTagEvent,
} from "../src/sessions/tags";

/** Rejoue `raw` découpé en chunks et agrège texte + événements. */
function replay(chunks: string[]): { text: string; events: GmTagEvent[] } {
  const parser = new GmStreamParser();
  let text = "";
  const events: GmTagEvent[] = [];
  for (const chunk of chunks) {
    const out = parser.feed(chunk);
    text += out.text;
    events.push(...out.events);
  }
  const out = parser.flush();
  text += out.text;
  events.push(...out.events);
  return { text, events };
}

describe("GmStreamParser", () => {
  it("laisse passer le texte sans balise", () => {
    const { text, events } = replay(["La brume ", "monte sur le fleuve."]);
    expect(text).toBe("La brume monte sur le fleuve.");
    expect(events).toEqual([]);
  });

  it("extrait <roll reason=.../> et le retire de la narration", () => {
    const { text, events } = replay([
      'Tu sautes vers la corniche. <roll reason="saut périlleux"/>',
    ]);
    expect(text).toBe("Tu sautes vers la corniche. ");
    expect(events).toEqual([
      { type: "roll_request", reason: "saut périlleux" },
    ]);
  });

  it("gère une balise coupée entre deux deltas de streaming", () => {
    const { text, events } = replay([
      "Le pont craque. <ro",
      'll reason="traversée"',
      "/> Tu retiens ton souffle.",
    ]);
    expect(text).toBe("Le pont craque.  Tu retiens ton souffle.");
    expect(events).toEqual([{ type: "roll_request", reason: "traversée" }]);
  });

  it("masque le contenu d'une invention et le loggue, même coupée", () => {
    const { text, events } = replay([
      "Le prêtre te tend une amulette.",
      '<invention axis="geo',
      'graphy">Le village de Karnos borde',
      " la faille.</inven",
      "tion> Il sourit.",
    ]);
    expect(text).toBe("Le prêtre te tend une amulette. Il sourit.");
    expect(events).toEqual([
      {
        type: "invention",
        axis: "geography",
        content: "Le village de Karnos borde la faille.",
      },
    ]);
  });

  it("extrait souffle_delta et scene_break", () => {
    const { text, events } = replay([
      'Tu brûles ton élan. <souffle delta="-1"/><scene_break/>Ailleurs...',
    ]);
    expect(text).toBe("Tu brûles ton élan. Ailleurs...");
    expect(events).toEqual([
      { type: "souffle_delta", delta: -1 },
      { type: "scene_break" },
    ]);
  });

  it("restitue les '<' qui ne sont pas des balises connues", () => {
    const { text, events } = replay(["2 < 3, et <intrigue> reste du texte"]);
    expect(text).toBe("2 < 3, et <intrigue> reste du texte");
    expect(events).toEqual([]);
  });

  it("un préfixe plausible non refermé redevient du texte au flush", () => {
    const { text, events } = replay(["fin abrupte <roll reason=\"x"]);
    expect(text).toBe('fin abrupte <roll reason="x');
    expect(events).toEqual([]);
  });

  it("loggue une invention jamais refermée au flush, sans l'afficher", () => {
    const { text, events } = replay([
      'Avant. <invention axis="plots">Un pacte secret',
    ]);
    expect(text).toBe("Avant. ");
    expect(events).toEqual([
      { type: "invention", axis: "plots", content: "Un pacte secret" },
    ]);
  });
});

describe("stripGmTags / extractGmEvents", () => {
  const raw =
    'Il pleut. <souffle delta="+1"/><invention axis="tone">Humour noir.</invention> Fin. <roll reason="fuite"/>';

  it("stripGmTags rend la narration propre", () => {
    expect(stripGmTags(raw)).toBe("Il pleut.  Fin. ");
  });

  it("extractGmEvents retrouve tous les événements d'un texte stocké", () => {
    expect(extractGmEvents(raw)).toEqual([
      { type: "souffle_delta", delta: 1 },
      { type: "invention", axis: "tone", content: "Humour noir." },
      { type: "roll_request", reason: "fuite" },
    ]);
  });
});
