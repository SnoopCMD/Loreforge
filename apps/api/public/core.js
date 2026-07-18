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

export const OUTCOME_LABELS = {
  failure_complication: "Échec, et une complication",
  success_cost: "Réussite, mais à un coût",
  clean_success: "Réussite franche",
};

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

export function mdToHtml(md) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>");
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
    para = [];
  };
  const flushList = () => {
    if (list) out.push("<ul>" + list.join("") + "</ul>");
    list = null;
  };
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^[-*]\s+(.*)/);
    if (h) {
      flushPara(); flushList();
      const tag = h[1].length === 1 ? "h2" : "h" + h[1].length;
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
    } else if (li) {
      flushPara();
      (list = list || []).push("<li>" + inline(li[1]) + "</li>");
    } else if (line.trim() === "") {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join("");
}

// ── Chips d'actions suggérées (§8.3 mobile) ──────────────────────────────

/**
 * Le MJ termine ses tours par « 2-3 options concrètes » (SPEC §7) : on
 * extrait les puces/numéros de FIN de narration pour les proposer en chips.
 * Heuristique volontairement stricte — au moindre doute, pas de chips.
 */
export function extractActionChips(text) {
  const lines = String(text).trimEnd().split(/\r?\n/);
  const chips = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") {
      if (chips.length) break;
      continue;
    }
    const m = line.match(/^(?:[-•*]|\d+[).])\s+(.{3,120})$/);
    if (!m) break;
    chips.unshift(m[1].replace(/\s*[;.]$/, ""));
  }
  return chips.length >= 2 && chips.length <= 4 ? chips : [];
}
