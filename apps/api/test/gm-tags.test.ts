import { describe, expect, it } from "vitest";
import {
  extractGmEvents,
  GmStreamParser,
  stripGmTags,
  wrapLore,
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

  it("extrait <roll .../> et le retire de la narration", () => {
    const { text, events } = replay([
      'Tu sautes vers la corniche. <roll reason="saut périlleux"/>',
    ]);
    expect(text).toBe("Tu sautes vers la corniche. ");
    expect(events).toEqual([
      {
        type: "roll_request",
        request: {
          reason: "saut périlleux",
          difficulty: "normal",
          stance: "neutral",
          bonus_dice: 0,
          skills: [],
        },
      },
    ]);
  });

  it("lit les conditions du jet (difficulté, posture, dice pool)", () => {
    const { events } = replay([
      '<roll reason="crochetage" difficulty="hard" stance="disadvantage" ',
      'dice="2" skills="Doigts de fée, Sang-froid"/>',
    ]);
    expect(events).toEqual([
      {
        type: "roll_request",
        request: {
          reason: "crochetage",
          difficulty: "hard",
          stance: "disadvantage",
          bonus_dice: 2,
          skills: ["Doigts de fée", "Sang-froid"],
        },
      },
    ]);
  });

  it("gère une balise coupée entre deux deltas de streaming", () => {
    const { text, events } = replay([
      "Le pont craque. <ro",
      'll reason="traversée"',
      "/> Tu retiens ton souffle.",
    ]);
    expect(text).toBe("Le pont craque.  Tu retiens ton souffle.");
    expect(events[0]).toMatchObject({
      type: "roll_request",
      request: { reason: "traversée", difficulty: "normal" },
    });
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

  it("garde le texte d'un <lore> visible, enveloppé de marqueurs", () => {
    const { text, events } = replay([
      "Tu croises la ",
      '<lore term="Garde Blanche" kind="faction">Garde Blanche</lore>',
      " au pont.",
    ]);
    expect(text).toBe(
      "Tu croises la " +
        wrapLore("Garde Blanche", "faction", "Garde Blanche") +
        " au pont.",
    );
    expect(events).toEqual([]);
  });

  it("gère un <lore> coupé entre plusieurs deltas de streaming", () => {
    const { text } = replay([
      'Le <lore term="Commandant Kass" kind="perso',
      'nnage">Commandant',
      " Kass</lo",
      "re> te salue.",
    ]);
    expect(text).toBe(
      "Le " +
        wrapLore("Commandant Kass", "personnage", "Commandant Kass") +
        " te salue.",
    );
  });

  it("un <lore> jamais refermé rend son texte en clair au flush", () => {
    const { text } = replay(['Vers <lore term="la Source">la Source']);
    expect(text).toBe("Vers la Source");
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

  it("extrait <skill .../> avec note optionnelle, même coupée en streaming", () => {
    const { text, events } = replay([
      "Tu sens la faille répondre. <sk",
      'ill name="Marche-faille" tier="apprentis',
      'sage" note="3 m max"/> Le froid se dissipe.',
    ]);
    expect(text).toBe("Tu sens la faille répondre.  Le froid se dissipe.");
    expect(events).toEqual([
      {
        type: "skill_update",
        name: "Marche-faille",
        tier: "apprentissage",
        note: "3 m max",
      },
    ]);
  });

  it("extrait <skill .../> sans note et <fait .../>", () => {
    const { text, events } = replay([
      '<skill name="Chant du fleuve" tier="maîtrise"/>Voilà.',
      '<fait texte="Le pont de Karnos est détruit."/>',
    ]);
    expect(text).toBe("Voilà.");
    expect(events).toEqual([
      { type: "skill_update", name: "Chant du fleuve", tier: "maîtrise" },
      { type: "fact", text: "Le pont de Karnos est détruit." },
    ]);
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
    const events = extractGmEvents(raw);
    expect(events.slice(0, 2)).toEqual([
      { type: "souffle_delta", delta: 1 },
      { type: "invention", axis: "tone", content: "Humour noir." },
    ]);
    expect(events[2]).toMatchObject({
      type: "roll_request",
      request: { reason: "fuite" },
    });
  });
});
