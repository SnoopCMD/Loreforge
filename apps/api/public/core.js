// @app/core — logique partagée SANS dépendance DOM (SPEC §8.3).
// Servi tel quel au front web (ES module) et ré-exporté par packages/core
// pour la future app native Expo. Tout ce qui touche au document reste
// dans app.js.

// ── Libellés ─────────────────────────────────────────────────────────────

export const AXIS_LABELS = {
  cosmology: "Cosmologie",
  characters: "Personnages",
  plots: "Trames",
  tone: "Ton",
  geography: "Géographie",
};

export const AXES = Object.keys(AXIS_LABELS);

// Issue binaire + critiques (§6). Les trois premières clés sont l'ancien
// système : d'anciennes sessions peuvent encore les porter dans leur état.
export const OUTCOME_LABELS = {
  critical_failure: "Échec critique",
  failure: "Échec",
  success: "Réussite",
  critical_success: "Réussite critique",
  failure_complication: "Échec, et une complication",
  success_cost: "Réussite, mais à un coût",
  clean_success: "Réussite franche",
};

export const DIFFICULTY_LABELS = {
  easy: "Facile",
  normal: "Normale",
  hard: "Difficile",
};

/** Seuil de réussite d'un dé, par difficulté (miroir de src/sessions/rules). */
export const DIFFICULTY_THRESHOLD = { easy: 3, normal: 4, hard: 5 };

export const STANCE_LABELS = {
  advantage: "Avantage",
  neutral: "Neutre",
  disadvantage: "Désavantage",
};

/**
 * Normalise un jet (demande ou résultat) venant du serveur, y compris les
 * états d'anciennes sessions où `pending_roll` n'était qu'une chaîne.
 */
export function normalizeRoll(roll) {
  if (!roll) return null;
  if (typeof roll === "string") {
    return { reason: roll, difficulty: "normal", stance: "neutral", bonus_dice: 0, skills: [] };
  }
  const difficulty = DIFFICULTY_LABELS[roll.difficulty] ? roll.difficulty : "normal";
  return {
    ...roll,
    reason: roll.reason || "action risquée",
    difficulty,
    stance: STANCE_LABELS[roll.stance] ? roll.stance : "neutral",
    bonus_dice: Number(roll.bonus_dice) || 0,
    skills: Array.isArray(roll.skills) ? roll.skills : [],
    threshold: roll.threshold || DIFFICULTY_THRESHOLD[difficulty],
    // Ancien résultat mono-dé : on lui fabrique sa poignée d'un dé.
    dice:
      Array.isArray(roll.dice) && roll.dice.length
        ? roll.dice
        : roll.value
          ? [{ value: roll.value, success: false, cancelled: false, kept: true }]
          : [],
  };
}

/** Taille de la poignée annoncée avant le jet (miroir de poolSize). */
export function rollPoolSize(request) {
  const extra = request.stance === "neutral" ? 0 : 1;
  return Math.min(6, 1 + (Number(request.bonus_dice) || 0) + extra);
}

export const FORMAT_LABELS = {
  oneshot: "One-shot",
  mini: "Mini-campagne",
  campaign: "Campagne",
};

export const SHEET_LABELS = {
  name: "Nom",
  concept: "Concept",
  power: "Pouvoir",
  temperament: "Tempérament",
  ability: "Capacité",
  weakness: "Faiblesse",
  hook: "Accroche",
  bond: "Lien",
  resources: "Ressources",
};

export const labelFor = (key) =>
  SHEET_LABELS[key] ||
  (key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, " ");

// Repli quand la bible n'a pas encore de schéma (§6bis).
export const GENERIC_FIELDS = [
  { key: "name", label: "Nom", type: "text", required: true, options: [], suggestions: [], hint: null },
  { key: "concept", label: "Concept en une phrase", type: "text", required: true, options: [], suggestions: [], hint: null },
  { key: "temperament", label: "Tempérament", type: "text", required: false, options: [], suggestions: [], hint: null },
  { key: "ability", label: "Capacité principale", type: "text", required: false, options: [], suggestions: [], hint: null },
  { key: "weakness", label: "Faiblesse ou coût", type: "text", required: false, options: [], suggestions: [], hint: null },
  { key: "hook", label: "Accroche narrative", type: "text", required: false, options: [], suggestions: [], hint: "Ce que le personnage veut, fuit ou cache." },
];

// ── Parseur de frames SSE (POST + ReadableStream, pas d'EventSource) ─────

/**
 * Parseur incrémental : `push(texte)` découpe les frames `event:/data:`
 * complètes et appelle onEvent(event, data). Les frontières de chunks
 * peuvent tomber n'importe où, y compris au milieu d'une frame.
 */
export function createSseParser(onEvent) {
  let buf = "";
  return {
    push(text) {
      buf += text;
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        onEvent(event, data ? JSON.parse(data) : {});
      }
    },
  };
}

// ── Mini-renderer Markdown (résumés de fin — tout est échappé) ───────────

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Lore cliquable (§7) : le serveur remplace <lore term kind>V</lore> par un
// marqueur en caractères de contrôle (invisibles, jamais produits par la
// narration) OPEN·term·SEP·kind·SEP·visible·CLOSE, atomique dans un même chunk
// SSE. mdInline le transforme en <button class="lore">, stripLore le réduit au
// texte visible (voix, chips, extraction d'options).
export const LORE_OPEN = String.fromCharCode(17); // DC1
export const LORE_SEP = String.fromCharCode(18); // DC2
export const LORE_CLOSE = String.fromCharCode(19); // DC3
const LORE_CLS = "[^" + LORE_OPEN + LORE_SEP + LORE_CLOSE + "]*";
const LORE_RE = new RegExp(
  LORE_OPEN + "(" + LORE_CLS + ")" + LORE_SEP + "(" + LORE_CLS + ")" +
    LORE_SEP + "(" + LORE_CLS + ")" + LORE_CLOSE,
  "g",
);

/** Réduit les marqueurs lore à leur seul texte visible. */
export const stripLore = (s) => String(s).replace(LORE_RE, "$3");

const attr = (s) => s.replace(/"/g, "&quot;");

/** Markdown inline (gras/italique) échappé — aussi utilisé par le fil de session. */
export const mdInline = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    // Marqueur lore → bouton inline (le label peut déjà porter du gras/italique).
    .replace(
      LORE_RE,
      (_m, term, kind, label) =>
        `<button type="button" class="lore" data-term="${attr(term)}" data-kind="${attr(kind)}">${label}</button>`,
    );

// Séparateur d'en-tête de tableau GFM : | --- | :--- | ---: |
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/;

/** Cellules d'une ligne de tableau (pipes de bord tolérés). */
function tableCells(line) {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}

export function mdToHtml(md) {
  const inline = mdInline;
  const out = [];
  let list = null;
  let para = [];
  let table = null; // lignes | … | consécutives
  let quote = null; // lignes > consécutives
  const flushPara = () => {
    if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
    para = [];
  };
  const flushList = () => {
    if (list) out.push("<ul>" + list.join("") + "</ul>");
    list = null;
  };
  const flushQuote = () => {
    if (quote && quote.some((l) => l.trim() !== "")) {
      out.push("<blockquote><p>" + quote.map(inline).join("<br>") + "</p></blockquote>");
    }
    quote = null;
  };
  const flushTable = () => {
    if (!table) return;
    const rows = table;
    table = null;
    if (rows.length >= 2 && TABLE_SEP.test(rows[1].trim())) {
      const head = tableCells(rows[0]);
      const cells = (r, tag) =>
        head.map((_, i) => `<${tag}>${inline(tableCells(r)[i] ?? "")}</${tag}>`).join("");
      const body = rows.slice(2).filter((r) => !TABLE_SEP.test(r.trim()));
      out.push(
        '<div class="md-table"><table><thead><tr>' + cells(rows[0], "th") +
          "</tr></thead>" +
          (body.length
            ? "<tbody>" + body.map((r) => "<tr>" + cells(r, "td") + "</tr>").join("") + "</tbody>"
            : "") +
          "</table></div>",
      );
    } else {
      // Pipes sans ligne de séparation : pas un tableau — paragraphe brut.
      out.push("<p>" + rows.map(inline).join("<br>") + "</p>");
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };

  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const q = line.match(/^>\s?(.*)$/);
    const li = line.match(/^[-*]\s+(.*)/);
    if (h) {
      flushAll();
      const tag = h[1].length === 1 ? "h2" : "h" + Math.min(h[1].length, 4);
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
    } else if (/^\s*\|/.test(line)) {
      flushPara(); flushList(); flushQuote();
      (table = table || []).push(line);
    } else if (q) {
      flushPara(); flushList(); flushTable();
      (quote = quote || []).push(q[1]);
    } else if (li) {
      flushPara(); flushQuote(); flushTable();
      (list = list || []).push("<li>" + inline(li[1]) + "</li>");
    } else if (line.trim() === "") {
      flushAll();
    } else {
      flushList(); flushQuote(); flushTable();
      para.push(line);
    }
  }
  flushAll();
  return out.join("");
}

// ── Chips d'actions suggérées (§8.3 mobile) ──────────────────────────────

/**
 * Le MJ termine ses tours par « 2-3 options concrètes » (SPEC §7) : on
 * extrait les puces/numéros de FIN de narration pour les proposer en chips.
 * Heuristique volontairement stricte — au moindre doute, pas de chips.
 */
export function extractActionChips(text) {
  const lines = stripLore(String(text)).trimEnd().split(/\r?\n/);
  const chips = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") {
      if (chips.length) break;
      continue;
    }
    // Une option concrète : puce/numéro + libellé (jusqu'à 200 car., le
    // **gras** compris) ; on tolère jusqu'à 6 options pour n'en perdre aucune.
    const m = line.match(/^(?:[-•*]|\d+[).])\s+(.{3,200})$/);
    if (!m) break;
    chips.unshift(m[1].replace(/\s*[;.]$/, ""));
  }
  return chips.length >= 2 && chips.length <= 6 ? chips : [];
}

// ── Segmentation de la narration pour la lecture vocale (§8.3) ────────────

// Une ligne d'options concrètes de fin de tour (puce ou numéro) : jamais lue.
const SPEECH_CHOICE_LINE = /^(?:[-–—•*]|\d{1,2}[.)])\s+\S/;
// Début de ligne qui pourrait encore devenir une puce (marqueur incomplet).
const SPEECH_MAYBE_CHOICE = /^(?:[-–—•*]|\d{1,2}[.)]?)\s*$/;

/** Position après la dernière phrase COMPLÈTE de `text` (ponctuation + blanc). */
function sentenceCut(text) {
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "…") {
      let j = i + 1;
      while (j < text.length && "\"»”)]".includes(text[j])) j++;
      if (j < text.length && /\s/.test(text[j])) {
        while (j < text.length && /\s/.test(text[j])) j++;
        cut = j;
        i = j - 1;
      }
    }
  }
  return cut;
}

/** Découpe un texte complet en phrases (les décimales « 3.5 » ne cassent pas). */
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "…") {
      let j = i + 1;
      while (j < text.length && "\"»”)]".includes(text[j])) j++;
      if (j >= text.length || /\s/.test(text[j])) {
        const s = text.slice(start, j).trim();
        if (s) out.push(s);
        while (j < text.length && /\s/.test(text[j])) j++;
        start = j;
        i = j - 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Segmenteur incrémental de narration pour le TTS : `push(delta)` rend les
 * phrases prêtes à lire au fil du flux ; `flush()` vide le reliquat en fin de
 * tour. Les lignes d'options concrètes (puces/numéros de fin de tour, SPEC §7)
 * sont exclues, et dès qu'elles commencent le reste du tour est ignoré (elles
 * sont toujours en queue de narration). Pur, sans DOM — testable.
 */
export function createSpeechSegmenter() {
  let buf = "";
  let atLineStart = true;
  let done = false; // bloc d'options atteint → on ignore la suite du tour

  /** Traite une ligne complète (ou le reliquat final). */
  const consumeLine = (line, out) => {
    const t = line.trim();
    if (atLineStart) {
      if (t === "") return;
      if (SPEECH_CHOICE_LINE.test(t)) { done = true; return; }
    }
    for (const s of splitSentences(line)) out.push(s);
  };

  const drain = (final) => {
    const out = [];
    if (done) { buf = ""; return out; }
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consumeLine(line, out);
        atLineStart = true;
        if (done) { buf = ""; break; }
        continue;
      }
      // Ligne partielle (pas encore de saut de ligne).
      if (atLineStart) {
        const ts = buf.trimStart();
        if (ts === "") { if (final) buf = ""; break; }
        if (SPEECH_CHOICE_LINE.test(ts)) { done = true; buf = ""; break; }
        if (!final && SPEECH_MAYBE_CHOICE.test(ts)) break; // attendre la suite
      }
      if (final) { consumeLine(buf, out); buf = ""; break; }
      const cut = sentenceCut(buf);
      if (cut > 0) {
        for (const s of splitSentences(buf.slice(0, cut))) out.push(s);
        buf = buf.slice(cut);
        atLineStart = false;
      }
      break;
    }
    return out;
  };

  return {
    push: (delta) => { buf += delta; return drain(false); },
    flush: () => drain(true),
  };
}

/**
 * Découpe un canon_md normalisé (un seul H1, sections en H2) en un
 * document éditable : { h1, preamble, sections: [{ title, body }] }.
 * Les blocs de code sont respectés (un `##` dans une fence n'est pas
 * un titre de section).
 */
export function parseCanonSections(md) {
  const doc = { h1: "", preamble: "", sections: [] };
  const pre = [];
  let current = null;
  let inFence = false;
  for (const line of String(md || "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h1 = line.match(/^# (.+)$/);
      if (h1 && doc.h1 === "" && current === null) { doc.h1 = h1[1]; continue; }
      const h2 = line.match(/^## (.*)$/);
      if (h2) {
        current = { title: h2[1], body: [] };
        doc.sections.push(current);
        continue;
      }
    }
    (current ? current.body : pre).push(line);
  }
  doc.preamble = pre.join("\n").trim();
  for (const s of doc.sections) s.body = s.body.join("\n").trim();
  return doc;
}

/** Recompose le canon_md depuis un document sectionné (inverse de parseCanonSections). */
export function buildCanonFromSections(doc) {
  const parts = [`# ${String(doc.h1 || "").trim() || "Bible sans titre"}`];
  if (doc.preamble && doc.preamble.trim() !== "") parts.push(doc.preamble.trim());
  for (const s of doc.sections) {
    const title = String(s.title || "").trim() || "Sans titre";
    const body = String(s.body || "").trim();
    parts.push(body === "" ? `## ${title}` : `## ${title}\n\n${body}`);
  }
  return parts.join("\n\n") + "\n";
}

/** Libellés français des statuts (bibles et sessions). */
export const STATUS_LABELS = {
  draft: "Brouillon",
  analyzing: "Analyse en cours",
  analyzed: "Analysée",
  ready: "Prête",
  setup: "Préparation",
  playing: "En jeu",
  finished: "Terminée",
  accepted: "Canonisé",
  rejected: "Rejeté",
};
