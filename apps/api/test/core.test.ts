// §8.3 — @app/core : logique front sans DOM (source : public/core.js).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE_COLORS,
  PALETTE_KEYS,
  createSpeechSegmenter,
  createSseParser,
  extractActionChips,
  mdToHtml,
  normalizeRoll,
  paletteCssVars,
  paletteVar,
  patchIsMine,
  choiceLabel,
  extractActionChipsFor,
  extractActionGroups,
  rollBonusText,
  rollPoolSize,
  // @ts-expect-error — module JS servi tel quel au front, sans types.
} from "../public/core.js";
import { DEFAULT_PALETTE, PALETTE_KEYS as SERVER_KEYS } from "../src/bibles/palette";
import {
  applySkillTiers,
  normalizeRollRequest,
  poolSize,
  resolveRoll,
} from "../src/sessions/rules";

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

  it("rend un tableau GFM en <table> (cellules inline, tout échappé)", () => {
    const md = [
      "| Nom *(provisoire)* | Concept | Nature |",
      "| --- | --- | --- |",
      "| **Vital** | Vie, harmonie | Le « bon » |",
      "| **Chaos** | Cruauté, <mort> | Le « mauvais » |",
    ].join("\n");
    const html = mdToHtml(md);
    expect(html).toContain('<div class="md-table"><table><thead>');
    expect(html).toContain("<th>Nom <i>(provisoire)</i></th>");
    expect(html).toContain("<td><b>Vital</b></td>");
    expect(html).toContain("<td>Cruauté, &lt;mort&gt;</td>");
    // 2 lignes de corps, le séparateur n'en fait pas partie.
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });

  it("complète les lignes courtes d'un tableau et ignore les pipes sans séparateur", () => {
    const table = mdToHtml("| A | B |\n| --- | --- |\n| seul |");
    expect(table).toContain("<td>seul</td><td></td>");
    // Une ligne à pipes isolée n'est pas un tableau : paragraphe brut.
    const notTable = mdToHtml("| pas | un | tableau |");
    expect(notTable).not.toContain("<table>");
    expect(notTable).toContain("<p>");
  });

  it("rend les citations > en blockquote et les #### en h4", () => {
    const html = mdToHtml(
      "#### Détail\n\n> Les noms sont provisoires.\n> Ils évolueront.\n\nSuite.",
    );
    expect(html).toContain("<h4>Détail</h4>");
    expect(html).toContain(
      "<blockquote><p>Les noms sont provisoires.<br>Ils évolueront.</p></blockquote>",
    );
    expect(html).toContain("<p>Suite.</p>");
  });

  it("sépare tableau et paragraphe adjacents sans ligne vide", () => {
    const html = mdToHtml("Avant.\n| A |\n| --- |\n| x |\nAprès.");
    expect(html).toContain("<p>Avant.</p>");
    expect(html).toContain("<td>x</td>");
    expect(html).toContain("<p>Après.</p>");
  });
});

describe("normalizeRoll / rollPoolSize (miroir front du moteur §6)", () => {
  it("rend affichable un résultat serveur sans le déformer", () => {
    const result = resolveRoll(
      normalizeRollRequest({
        reason: "crochetage",
        difficulty: "hard",
        stance: "disadvantage",
        bonus_dice: 1,
        skills: ["Doigts de fée"],
      }),
      [1, 6, 3],
    );
    expect(normalizeRoll(result)).toEqual(result);
  });

  it("rattrape un ancien état (raison seule, résultat mono-dé)", () => {
    expect(normalizeRoll("saut")).toMatchObject({
      reason: "saut",
      difficulty: "normal",
      stance: "neutral",
      bonus_dice: 0,
    });
    const legacy = normalizeRoll({
      value: 5,
      outcome: "clean_success",
      reason: "saut",
    });
    expect(legacy.dice).toEqual([
      { value: 5, success: false, cancelled: false, kept: true },
    ]);
    expect(legacy.threshold).toBe(4);
    expect(normalizeRoll(null)).toBeNull();
  });

  it("annonce la même poignée que le serveur", () => {
    const ledgers = [
      "",
      "temperament: x",
      "temperament: x ; ability: y",
      "temperament: x ; ability: y ; souffle",
      "weakness: soleil",
      "ability: y ; weakness: soleil",
    ];
    for (const stance of ["neutral", "advantage", "disadvantage"]) {
      for (const bonuses of ledgers) {
        const request = normalizeRollRequest({ reason: "x", stance, bonuses });
        expect(rollPoolSize(request)).toBe(poolSize(request));
      }
    }
  });

  it("dit d'où viennent les dés", () => {
    const request = normalizeRollRequest({
      reason: "pousser Reika à la faute",
      bonuses: "temperament: provocation ; ability: sigils",
    });
    expect(rollBonusText(normalizeRoll(request))).toBe(
      "+1 tempérament · +1 capacité",
    );
    expect(
      rollBonusText(
        normalizeRoll(
          normalizeRollRequest({ reason: "plein soleil", bonuses: "weakness: soleil" }),
        ),
      ),
    ).toBe("-1 faiblesse");
    // Le palier qui donne le dé est montré au joueur.
    expect(
      rollBonusText(
        normalizeRoll(
          applySkillTiers(
            normalizeRollRequest({ reason: "franchir le vide", skills: ["Acrobatie"] }),
            [{ name: "Acrobatie", tier: "maîtrise" }],
          ),
        ),
      ),
    ).toBe("+1 compétence (Acrobatie, maîtrise)");
    // Rien à afficher quand aucun bonus n'a joué.
    expect(rollBonusText(normalizeRoll("saut"))).toBe("");
  });
});

describe("palettes d'ambiance", () => {
  /** Palette valide minimale : les huit clés, couleurs distinctes. */
  const palette = (over: Record<string, string> = {}) => ({
    name: "Braise et cendre",
    mood: "Un feu qui s'éteint.",
    colors: { ...DEFAULT_PALETTE_COLORS, ...over },
  });

  it("parle des mêmes couleurs que le serveur", () => {
    // Le front pose les variables, le serveur les valide : un désaccord sur les
    // clés ferait passer des palettes muettes.
    expect(PALETTE_KEYS).toEqual([...SERVER_KEYS]);
    expect(DEFAULT_PALETTE_COLORS).toEqual(DEFAULT_PALETTE.colors);
  });

  it("nomme les variables CSS comme styles.css", () => {
    expect(paletteVar("void")).toBe("--void");
    expect(paletteVar("parchment_dim")).toBe("--parchment-dim");
  });

  it("rend les huit couples variable/valeur, en minuscules", () => {
    const vars = paletteCssVars(palette({ ember: "#FF0088" }));
    expect(vars).toHaveLength(8);
    expect(vars[0]).toEqual(["--void", DEFAULT_PALETTE_COLORS.void]);
    expect(vars).toContainEqual(["--ember", "#ff0088"]);
  });

  it("ne rend rien d'une palette absente, incomplète ou mal formée", () => {
    expect(paletteCssVars(null)).toEqual([]);
    expect(paletteCssVars(undefined)).toEqual([]);
    expect(paletteCssVars({})).toEqual([]);
    const partial = palette();
    delete (partial.colors as Record<string, string>).line;
    expect(paletteCssVars(partial)).toEqual([]);
    // Tout ou rien : une seule couleur invalide et l'ambiance d'origine reste.
    expect(paletteCssVars(palette({ arcane: "rouge" }))).toEqual([]);
    expect(paletteCssVars(palette({ arcane: "#12" }))).toEqual([]);
  });
});

describe("patchIsMine — à qui s'adresse un patch d'état", () => {
  // Le serveur adresse chaque patch à un personnage. L'auteur d'un tour les
  // recevait par SSE et se les appliquait TOUS : on lui réclamait le jet d'un
  // autre, et la poignée se calculait sur SA fiche — trois dés annoncés, un
  // seul lancé, et le joueur concerné restait bloqué avec son jet en attente.
  it("à une table, ne retient que les patchs de MON personnage", () => {
    const moi = { myCharacterId: "siss", table: true };
    expect(patchIsMine({ character_id: "siss", souffle: 2 }, moi)).toBe(true);
    expect(patchIsMine({ character_id: "mo", pending_roll: "…" }, moi)).toBe(false);
  });

  it("garde les patchs collectifs, qui ne visent personne", () => {
    // Les faits établis n'appartiennent à aucun personnage.
    expect(
      patchIsMine({ facts: ["Karnos existe."] }, { myCharacterId: "siss", table: true }),
    ).toBe(true);
  });

  it("en solo, tout est à moi — y compris la clé @solo", () => {
    // Une partie sans fiche s'indexe sur « @solo » : ce n'est pas un
    // character_id, et le rapprocher du mien écarterait mes propres patchs.
    expect(patchIsMine({ character_id: "@solo", souffle: 1 }, {})).toBe(true);
    expect(
      patchIsMine({ character_id: "kael" }, { myCharacterId: null, table: false }),
    ).toBe(true);
  });
});

describe("choiceLabel — une réplique n'est pas une option", () => {
  // En français, un dialogue s'ouvre sur un tiret cadratin. Le confondre avec
  // une puce d'options faisait disparaître de l'écran les dernières répliques
  // de chaque scène : « fins de phrase manquantes », sans rien dans les logs.
  it("refuse le tiret cadratin et le tiret demi-cadratin", () => {
    expect(choiceLabel("— Tu ne devrais pas être là.")).toBeNull();
    expect(choiceLabel("– Personne ne revient d'là-bas.")).toBeNull();
  });

  it("reconnaît les vraies options du MJ", () => {
    expect(choiceLabel("- Forcer la porte")).toBe("Forcer la porte");
    expect(choiceLabel("1. Reculer sans bruit.")).toBe("Reculer sans bruit");
    expect(choiceLabel("• Appeler Siss")).toBe("Appeler Siss");
  });

  it("n'extrait aucune option d'une scène qui finit en dialogue", () => {
    const scene = [
      "La membrane palpite.",
      "",
      "— Ne regarde pas trop longtemps.",
      "— Trop tard.",
    ].join("\n");
    expect(extractActionChips(scene)).toEqual([]);
  });

  it("extrait toujours les options quand ce sont vraiment les siennes", () => {
    const scene = [
      "La porte cède d'un cran.",
      "",
      "- Forcer le passage",
      "- Écouter derrière",
    ].join("\n");
    expect(extractActionChips(scene)).toEqual([
      "Forcer le passage",
      "Écouter derrière",
    ]);
  });
});

describe("options par personnage — chacun reçoit les siennes", () => {
  const scene = [
    "La membrane palpite.",
    "",
    "Mira :",
    "- écouter derrière la porte",
    "- reculer sans bruit",
    "",
    "Kaelen :",
    "- forcer le passage",
    "- couvrir Mira",
  ].join("\n");

  it("groupe les options sous le nom qui les porte", () => {
    expect(extractActionGroups(scene)).toEqual([
      { name: "Mira", chips: ["écouter derrière la porte", "reculer sans bruit"] },
      { name: "Kaelen", chips: ["forcer le passage", "couvrir Mira"] },
    ]);
  });

  it("ne rend à chacun que son bloc", () => {
    expect(extractActionChipsFor(scene, "Kaelen")).toEqual([
      "forcer le passage",
      "couvrir Mira",
    ]);
    // Accents et casse ne doivent pas priver un joueur de ses options.
    expect(extractActionChipsFor(scene, "mira")).toEqual([
      "écouter derrière la porte",
      "reculer sans bruit",
    ]);
    // Un spectateur sans personnage n'a rien à cliquer.
    expect(extractActionChipsFor(scene, null)).toEqual([]);
  });

  it("le solo est inchangé : pas de bloc nommé, tout est à moi", () => {
    const solo = ["La porte cède.", "", "- Forcer", "- Écouter"].join("\n");
    expect(extractActionGroups(solo)).toEqual([
      { name: null, chips: ["Forcer", "Écouter"] },
    ]);
    expect(extractActionChipsFor(solo, null)).toEqual(["Forcer", "Écouter"]);
    expect(extractActionChipsFor(solo, "Kael")).toEqual(["Forcer", "Écouter"]);
  });

  it("une scène qui finit en dialogue ne propose toujours rien", () => {
    const dialogue = ["— Ne regarde pas.", "— Trop tard."].join("\n");
    expect(extractActionGroups(dialogue)).toEqual([]);
    expect(extractActionChipsFor(dialogue, "Mira")).toEqual([]);
  });
});
