// Palettes d'ambiance : logique pure (aucune dépendance Hono / D1 / R2).
//
// Une palette porte les 8 couleurs de la DA (SPEC §8) — les mêmes variables CSS
// que `:root` dans styles.css. Le front n'a donc qu'à poser les variables sur
// l'élément racine pour re-teinter toute une session sans toucher au reste.
//
// Deux garde-fous, ici plutôt que côté modèle : les couleurs sont normalisées
// (#RGB → #rrggbb minuscule) et le contraste texte/fond est corrigé si le
// modèle propose un parchemin illisible sur son propre vide.

/** Clés de couleur d'une palette, dans l'ordre d'affichage. */
export const PALETTE_KEYS = [
  "void",
  "nebula",
  "arcane",
  "spirit",
  "ember",
  "parchment",
  "parchment_dim",
  "line",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];

export type PaletteColors = Record<PaletteKey, string>;

export interface Palette {
  /** Nom court, évocateur (« Braise et cendre »). */
  name: string;
  /** Une ligne : l'ambiance que la palette porte. */
  mood: string;
  colors: PaletteColors;
}

const MAX_NAME = 60;
const MAX_MOOD = 200;

/** Palette par défaut = la DA d'origine (styles.css `:root`). */
export const DEFAULT_PALETTE: Palette = {
  name: "Dark Fantasy Cosmique",
  mood: "L'ambiance d'origine de Loreforge : nuit violette, souffle cyan, braise orange.",
  colors: {
    void: "#12081f",
    nebula: "#2a1548",
    arcane: "#7c3aed",
    spirit: "#67e8f9",
    ember: "#f97316",
    parchment: "#f3ede4",
    parchment_dim: "#b8aecb",
    line: "#4b2f7a",
  },
};

/** Nom de la variable CSS portant une clé de palette (`--parchment-dim`). */
export function cssVarName(key: PaletteKey): string {
  return "--" + key.replace(/_/g, "-");
}

/**
 * Vers #rrggbb minuscule, en acceptant ce que le modèle écrit réellement :
 * #abc, #AABBCC, aabbcc sans dièse, #aabbccff (alpha ignoré), rgb(18, 8, 31).
 * Null si ce n'est décidément pas une couleur.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let hex = input.trim().toLowerCase();

  // Le schéma de sortie ne sait pas contraindre le FORMAT d’une chaîne (pas de
  // `pattern`) : le modèle écrit parfois aabbcc, #aabbccff ou rgb(12, 8, 31).
  // Refuser ces formes revenait à jeter toute la palette pour une couleur.
  // Écrit sans expression régulière : la forme rgb() varie (espaces, barre
  // oblique de l’alpha, pourcentages) et un découpage explicite se relit.
  if (hex.startsWith("rgb")) {
    const open = hex.indexOf("(");
    const close = hex.lastIndexOf(")");
    if (open === -1 || close <= open) return null;
    const parts = hex
      .slice(open + 1, close)
      .split(/[, /]+/)
      .filter((part) => part !== "");
    if (parts.length < 3) return null;
    const percent = parts.slice(0, 3).some((part) => part.includes("%"));
    const channels = parts
      .slice(0, 3)
      .map((part) => Number(part.replace("%", "")) * (percent ? 2.55 : 1));
    if (channels.some((v) => !Number.isFinite(v))) return null;
    return toHex(channels as [number, number, number]);
  }

  if (!hex.startsWith("#")) hex = "#" + hex;
  if (/^#[0-9a-f]{8}$/.test(hex)) hex = hex.slice(0, 7); // canal alpha ignoré
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return null;
}

function toRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Luminance relative WCAG d'une couleur hexadécimale normalisée. */
export function luminance(hex: string): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Rapport de contraste WCAG entre deux couleurs (1 → 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mélange `hex` vers blanc (amount > 0) ou noir (amount < 0), |amount| ∈ [0,1]. */
function shift(hex: string, amount: number): string {
  const target = amount >= 0 ? 255 : 0;
  const k = Math.abs(amount);
  const rgb = toRgb(hex).map((v) => v + (target - v) * k) as [number, number, number];
  return toHex(rgb);
}

/** Contraste minimum exigé entre le texte et le fond d'une session. */
export const MIN_TEXT_CONTRAST = 4.5;
/** Contraste minimum du texte secondaire (plus discret, mais lisible). */
export const MIN_DIM_CONTRAST = 3;

/**
 * Rapproche `color` du blanc ou du noir (selon le fond) jusqu'à atteindre le
 * contraste voulu. Renvoie la couleur inchangée si elle passe déjà.
 */
function ensureContrast(color: string, bg: string, min: number): string {
  if (contrastRatio(color, bg) >= min) return color;
  const direction = luminance(bg) < 0.5 ? 1 : -1;
  let best = color;
  for (let step = 1; step <= 20; step++) {
    best = shift(color, direction * (step / 20));
    if (contrastRatio(best, bg) >= min) return best;
  }
  // Cas extrême : on retombe sur le blanc ou le noir pur.
  return direction > 0 ? "#ffffff" : "#000000";
}

/**
 * Corrige une palette pour qu'elle reste lisible : le parchemin (texte) et sa
 * variante discrète doivent contraster avec le vide (fond de page).
 */
export function ensureReadable(palette: Palette): Palette {
  const colors = { ...palette.colors };
  colors.parchment = ensureContrast(colors.parchment, colors.void, MIN_TEXT_CONTRAST);
  colors.parchment_dim = ensureContrast(
    colors.parchment_dim,
    colors.void,
    MIN_DIM_CONTRAST,
  );
  return { ...palette, colors };
}

function cleanLine(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? fallback : text.slice(0, max);
}

/**
 * Nombre de couleurs qu'on accepte de reprendre à la palette par défaut quand
 * le modèle les oublie ou les écrit hors format. Au-delà, ce n'est plus sa
 * palette qu'on affiche : mieux vaut l'écarter.
 */
export const MAX_BORROWED_COLORS = 2;

/**
 * Valide une palette venue du client ou du modèle. Les couleurs sont
 * normalisées et le résultat rendu lisible ; jusqu'à MAX_BORROWED_COLORS
 * manquantes sont empruntées à la palette par défaut. Renvoie null si la
 * forme n'est pas exploitable.
 */
export function parsePalette(input: unknown): Palette | null {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as { name?: unknown; mood?: unknown; colors?: unknown };
  const colorsIn = raw.colors;
  if (colorsIn === null || typeof colorsIn !== "object" || Array.isArray(colorsIn)) {
    return null;
  }

  const colors = {} as PaletteColors;
  let borrowed = 0;
  for (const key of PALETTE_KEYS) {
    const hex = normalizeHex((colorsIn as Record<string, unknown>)[key]);
    if (hex) {
      colors[key] = hex;
      continue;
    }
    if (++borrowed > MAX_BORROWED_COLORS) return null;
    colors[key] = DEFAULT_PALETTE.colors[key];
  }

  return ensureReadable({
    name: cleanLine(raw.name, MAX_NAME, "Palette sans nom"),
    mood: cleanLine(raw.mood, MAX_MOOD, ""),
    colors,
  });
}

/** Valide une liste de palettes ; les entrées invalides sont écartées. */
export function parsePalettes(input: unknown, max = 4): Palette[] {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: Palette[] = [];
  for (const item of value) {
    const palette = parsePalette(item);
    if (palette) out.push(palette);
    if (out.length >= max) break;
  }
  return out;
}

/** Sérialise pour D1 (colonne TEXT), ou null si la palette est invalide. */
export function serializePalette(input: unknown): string | null {
  const palette = parsePalette(input);
  return palette ? JSON.stringify(palette) : null;
}

/** Schéma JSON strict pour la sortie structurée du modèle (analyse d'ambiance). */
export const MOODBOARD_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    analysis_md: {
      type: "string",
      description:
        "Lecture d'ambiance en Markdown : lumière, matières, époque, émotion dominante, ce que cela implique pour la narration. 150 à 300 mots.",
    },
    palettes: {
      // Les sorties structurées n'acceptent minItems qu'à 0 ou 1, et ignorent
      // maxItems : le « 2 ou 3 » est demandé dans le prompt et bordé par
      // parseAnalysisPayload (au moins une palette valide, trois au plus).
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          mood: { type: "string" },
          colors: {
            type: "object",
            properties: Object.fromEntries(
              PALETTE_KEYS.map((key) => [
                key,
                { type: "string", description: "Couleur hexadécimale #rrggbb" },
              ]),
            ),
            required: [...PALETTE_KEYS],
            additionalProperties: false,
          },
        },
        required: ["name", "mood", "colors"],
        additionalProperties: false,
      },
    },
  },
  required: ["analysis_md", "palettes"],
  additionalProperties: false,
} as const;

export interface MoodboardAnalysis {
  analysisMd: string;
  palettes: Palette[];
}

/**
 * Ce qui manquait à une charge utile refusée, en une ligne : sans ça, un
 * échec de lecture d'ambiance ne dit rien de ce que le modèle a écrit.
 */
export function describeAnalysisPayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "réponse " + typeof payload;
  const raw = payload as { analysis_md?: unknown; palettes?: unknown };
  if (typeof raw.analysis_md !== "string" || raw.analysis_md.trim() === "") {
    return "analysis_md vide";
  }
  const count = Array.isArray(raw.palettes) ? raw.palettes.length : 0;
  const first = Array.isArray(raw.palettes) ? raw.palettes[0] : null;
  const colors =
    first && typeof first === "object"
      ? ((first as { colors?: unknown }).colors ?? null)
      : null;
  const rejected =
    colors && typeof colors === "object"
      ? PALETTE_KEYS.filter(
          (key) => !normalizeHex((colors as Record<string, unknown>)[key]),
        )
      : PALETTE_KEYS.slice();
  return (
    count +
    " palette(s), couleurs refusées : " +
    (rejected.length ? rejected.join(", ") : "aucune")
  );
}

/** Valide la charge utile renvoyée par le modèle. Null si inexploitable. */
export function parseAnalysisPayload(payload: unknown): MoodboardAnalysis | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as { analysis_md?: unknown; palettes?: unknown };
  if (typeof raw.analysis_md !== "string" || raw.analysis_md.trim() === "") {
    return null;
  }
  const palettes = parsePalettes(raw.palettes, 3);
  if (palettes.length === 0) return null;
  return { analysisMd: raw.analysis_md.trim(), palettes };
}
