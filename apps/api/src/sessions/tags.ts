// Extraction des balises émises par le MJ dans le flux de narration
// (SPEC §4 et §7) : logique pure, incrémentale (les balises peuvent être
// coupées entre deux deltas de streaming), testable unitairement.
//
// Balises reconnues :
//   <invention axis="...">...</invention>  invisible pour le joueur, loggée
//   <lore term="..." kind="...">...</lore>  terme d'univers cliquable (§7) :
//       le texte visible RESTE dans la narration, mais enveloppé de marqueurs
//       de contrôle (DC1/DC2/DC3) OPEN·term·SEP·visible·CLOSE que le front
//       transforme en <button class="lore"> ; la définition est résolue à la
//       demande, une fois par session (KV), au clic.
//   <roll reason="..." difficulty="..." stance="..." dice="..."
//         bonuses="temperament: ... ; ability: ..." skills="..."/>
//       demande de jet serveur, avec ses conditions (§6). La poignée se
//       calcule depuis bonuses, jamais depuis le nombre annoncé dans dice.
//   <souffle delta="-1" character="Mira"/> dépense/regain de Souffle. À une
//       table, `character` dit DE QUI ; en solo il est inutile et absent.
//   <scene_break/>                         rupture de scène (event SSE)
//   <turn_mode value="simultaneous"/> ou
//   <turn_mode value="sequential" order="Kaelen,Mira,Théa"/>
//       régime de résolution du tour (M8) : c'est le MJ qui sait quand un
//       combat commence, pas le joueur.
//   <skill name="..." tier="..." note="..."/>  acquis/progression d'une
//       compétence du personnage (note optionnelle), invisible pour le joueur
//   <fait texte="..."/>                    fait établi à mémoriser (invisible)
// Tout autre usage de '<' (dialogue, comparaison...) est restitué tel quel.

import { normalizeRollRequest, type RollRequest } from "./rules";

// Marqueurs lore (mêmes codes que public/core.js : LORE_OPEN/SEP/CLOSE).
export const LORE_OPEN = String.fromCharCode(17); // DC1
export const LORE_SEP = String.fromCharCode(18); // DC2
export const LORE_CLOSE = String.fromCharCode(19); // DC3
const LORE_CTRL = new RegExp("[" + LORE_OPEN + LORE_SEP + LORE_CLOSE + "]", "g");
/** Enveloppe un terme lore résolu dans le flux : OPEN·term·SEP·kind·SEP·visible·CLOSE. */
export function wrapLore(term: string, kind: string, visible: string): string {
  const clean = (s: string) => s.replace(LORE_CTRL, "");
  return (
    LORE_OPEN +
    clean(term) +
    LORE_SEP +
    clean(kind) +
    LORE_SEP +
    clean(visible) +
    LORE_CLOSE
  );
}

export type GmTagEvent =
  | { type: "invention"; axis: string; content: string }
  | { type: "roll_request"; request: RollRequest; character?: string }
  | { type: "souffle_delta"; delta: number; character?: string }
  | { type: "scene_break" }
  | {
      type: "skill_update";
      name: string;
      tier: string;
      note?: string;
      character?: string;
    }
  | { type: "fact"; text: string }
  | { type: "turn_mode"; value: "simultaneous" | "sequential"; order: string[] };

export interface ParsedChunk {
  /** Narration visible par le joueur (balises retirées). */
  text: string;
  events: GmTagEvent[];
}

// Au-delà, un '<' jamais refermé est rendu comme du texte (évite de
// retenir indéfiniment le flux sur une fausse balise).
const MAX_TAG_LEN = 400;

const OPEN_INVENTION = /^<invention\s+axis="([^"]*)"\s*>/;
// term obligatoire ; kind optionnel, dans n'importe quel ordre.
const OPEN_LORE =
  /^<lore(?=\s)(?=[^>]*\bterm="([^"]*)")(?:[^>]*\bkind="([^"]*)")?[^>]*>/;
// Attributs libres, dans n'importe quel ordre : reason (obligatoire de fait),
// difficulty, stance, dice, skills. Tout attribut inconnu est ignoré.
const ROLL = /^<roll(?=\s)([^>]*?)\/>/;
const ATTR = /(\w+)="([^"]*)"/g;
// delta obligatoire ; character optionnel (table), dans n'importe quel ordre.
const SOUFFLE =
  /^<souffle(?=\s)(?=[^>]*\bdelta="([+-]?\d+)")(?:[^>]*\bcharacter="([^"]*)")?[^>]*\/>/;
const SCENE_BREAK = /^<scene_break\s*\/>/;
// name et tier obligatoires ; note et character optionnels, ordre libre.
// Tous les attributs sont capturés par lookahead : consommer `note` puis
// `character` en séquence perdait `character` dès qu'il était écrit en
// premier — et le MJ écrit ses balises dans l'ordre qui lui chante.
const SKILL =
  /^<skill(?=\s)(?=[^>]*\bname="([^"]*)")(?=[^>]*\btier="([^"]*)")(?=(?:[^>]*\bnote="([^"]*)")?)(?=(?:[^>]*\bcharacter="([^"]*)")?)[^>]*\/>/;
const FAIT = /^<fait\s+texte="([^"]*)"\s*\/>/;
// value obligatoire ; order optionnel (séquentiel), ordre libre.
const TURN_MODE =
  /^<turn_mode(?=\s)(?=[^>]*\bvalue="([^"]*)")(?:[^>]*\border="([^"]*)")?[^>]*\/>/;
const CLOSE_INVENTION = "</invention>";
const CLOSE_LORE = "</lore>";

const TAG_NAMES = [
  "invention",
  "lore",
  "roll",
  "souffle",
  "scene_break",
  "skill",
  "fait",
  "turn_mode",
];

/** Le début de buffer (commençant par '<') peut-il encore devenir une balise ? */
function couldBeTag(buf: string): boolean {
  const body = buf.slice(1);
  for (const name of TAG_NAMES) {
    if (name.startsWith(body)) return true; // ex. "<inv"
    // Nom complet, attributs en cours : plausible tant que '>' absent.
    if (body.startsWith(name) && !body.includes(">")) return true;
  }
  return false;
}

/** Longueur du plus long préfixe de `tag` en suffixe de `s` (tag partiel). */
function partialSuffixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

type TagMatch = {
  length: number;
  event?: GmTagEvent;
  openInvention?: string;
  openLore?: { term: string; kind: string };
};

function matchTag(buf: string): TagMatch | "incomplete" | null {
  let m: RegExpMatchArray | null;
  if ((m = buf.match(OPEN_INVENTION))) {
    return { length: m[0].length, openInvention: m[1] };
  }
  if ((m = buf.match(OPEN_LORE))) {
    return { length: m[0].length, openLore: { term: m[1], kind: m[2] ?? "" } };
  }
  if ((m = buf.match(ROLL))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = a[2];
    return {
      length: m[0].length,
      event: {
        type: "roll_request",
        ...(attrs.character ? { character: attrs.character } : {}),
        request: normalizeRollRequest({
          reason: attrs.reason,
          difficulty: attrs.difficulty,
          stance: attrs.stance,
          bonus_dice: attrs.dice,
          bonuses: attrs.bonuses,
          skills: (attrs.skills ?? "").split(/\s*[,;]\s*/),
        }),
      },
    };
  }
  if ((m = buf.match(SOUFFLE))) {
    return {
      length: m[0].length,
      event: {
        type: "souffle_delta",
        delta: Number(m[1]),
        ...(m[2] ? { character: m[2] } : {}),
      },
    };
  }
  if ((m = buf.match(SCENE_BREAK))) {
    return { length: m[0].length, event: { type: "scene_break" } };
  }
  if ((m = buf.match(SKILL))) {
    return {
      length: m[0].length,
      event: {
        type: "skill_update",
        name: m[1],
        tier: m[2],
        ...(m[3] !== undefined ? { note: m[3] } : {}),
        ...(m[4] ? { character: m[4] } : {}),
      },
    };
  }
  if ((m = buf.match(FAIT))) {
    return { length: m[0].length, event: { type: "fact", text: m[1] } };
  }
  if ((m = buf.match(TURN_MODE))) {
    // Tout ce qui n'est pas explicitement séquentiel est simultané : c'est le
    // régime par défaut (dialogue, exploration), et une valeur inconnue ne
    // doit pas bloquer la table dans un tour par tour dont personne n'a voulu.
    const value = m[1] === "sequential" ? "sequential" : "simultaneous";
    const order = (m[2] ?? "")
      .split(/\s*,\s*/)
      .map((n) => n.trim())
      .filter(Boolean);
    return { length: m[0].length, event: { type: "turn_mode", value, order } };
  }
  if (buf.length <= MAX_TAG_LEN && couldBeTag(buf)) return "incomplete";
  return null;
}

export class GmStreamParser {
  private buf = "";
  private invention: { axis: string; content: string } | null = null;
  private lore: { term: string; kind: string; content: string } | null = null;

  /** Ingère un delta de streaming, rend le texte sûr et les événements. */
  feed(chunk: string): ParsedChunk {
    this.buf += chunk;
    return this.drain(false);
  }

  /** À appeler en fin de flux : vide le buffer résiduel. */
  flush(): ParsedChunk {
    return this.drain(true);
  }

  private drain(final: boolean): ParsedChunk {
    let text = "";
    const events: GmTagEvent[] = [];

    while (this.buf.length > 0) {
      if (this.invention) {
        const close = this.buf.indexOf(CLOSE_INVENTION);
        if (close >= 0) {
          this.invention.content += this.buf.slice(0, close);
          events.push({
            type: "invention",
            axis: this.invention.axis,
            content: this.invention.content.trim(),
          });
          this.buf = this.buf.slice(close + CLOSE_INVENTION.length);
          this.invention = null;
          continue;
        }
        // Retenir un éventuel début de balise fermante coupée.
        const keep = final ? 0 : partialSuffixLen(this.buf, CLOSE_INVENTION);
        this.invention.content += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }

      if (this.lore) {
        // Le texte visible du terme RESTE dans la narration, enveloppé de
        // marqueurs quand la balise se referme.
        const close = this.buf.indexOf(CLOSE_LORE);
        if (close >= 0) {
          this.lore.content += this.buf.slice(0, close);
          text += wrapLore(this.lore.term, this.lore.kind, this.lore.content);
          this.buf = this.buf.slice(close + CLOSE_LORE.length);
          this.lore = null;
          continue;
        }
        const keep = final ? 0 : partialSuffixLen(this.buf, CLOSE_LORE);
        this.lore.content += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }

      const lt = this.buf.indexOf("<");
      if (lt < 0) {
        text += this.buf;
        this.buf = "";
        break;
      }
      if (lt > 0) {
        text += this.buf.slice(0, lt);
        this.buf = this.buf.slice(lt);
      }

      const match = matchTag(this.buf);
      if (match === "incomplete") {
        if (!final) break; // attendre la suite du flux
        text += "<";
        this.buf = this.buf.slice(1);
        continue;
      }
      if (match === null) {
        text += "<";
        this.buf = this.buf.slice(1);
        continue;
      }
      this.buf = this.buf.slice(match.length);
      if (match.event) events.push(match.event);
      if (match.openInvention !== undefined) {
        this.invention = { axis: match.openInvention, content: "" };
      }
      if (match.openLore !== undefined) {
        this.lore = {
          term: match.openLore.term,
          kind: match.openLore.kind,
          content: "",
        };
      }
    }

    if (final && this.invention) {
      // Invention jamais refermée : loggée quand même, pas montrée.
      events.push({
        type: "invention",
        axis: this.invention.axis,
        content: this.invention.content.trim(),
      });
      this.invention = null;
    }

    if (final && this.lore) {
      // Lore jamais refermé : on ne perd pas le texte, on le rend en clair
      // (sans bouton, faute de fermeture fiable).
      text += this.lore.content;
      this.lore = null;
    }

    return { text, events };
  }
}

/** Version non-incrémentale : narration nettoyée d'un texte complet. */
export function stripGmTags(raw: string): string {
  const parser = new GmStreamParser();
  const a = parser.feed(raw);
  const b = parser.flush();
  return a.text + b.text;
}

/** Événements d'un texte complet (relecture d'un tour stocké). */
export function extractGmEvents(raw: string): GmTagEvent[] {
  const parser = new GmStreamParser();
  const a = parser.feed(raw);
  const b = parser.flush();
  return [...a.events, ...b.events];
}
