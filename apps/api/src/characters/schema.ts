// Fiches personnage dynamiques (SPEC §6bis) : logique pure, testée
// unitairement. Le schéma de fiche est généré par bible à l'analyse ;
// ici on normalise et valide ce que le modèle produit.

export interface SheetField {
  key: string;
  label: string;
  type: "text" | "select";
  required: boolean;
  /** Choix fermés (type select). */
  options: string[];
  /** Suggestions issues du canon (chips, saisie libre possible). */
  suggestions: string[];
  hint: string | null;
}

export interface SheetSchema {
  fields: SheetField[];
}

export interface PlayableCharacter {
  name: string;
  sheet: Record<string, string>;
}

/**
 * Champs toujours présents (SPEC §6bis) — le modèle peut les enrichir de
 * suggestions ou en ajouter d'autres, jamais les retirer.
 */
export const BASE_FIELDS: SheetField[] = [
  { key: "name", label: "Nom", type: "text", required: true, options: [], suggestions: [], hint: null },
  { key: "concept", label: "Concept en une phrase", type: "text", required: true, options: [], suggestions: [], hint: null },
  { key: "temperament", label: "Tempérament", type: "text", required: false, options: [], suggestions: [], hint: null },
  { key: "ability", label: "Capacité principale", type: "text", required: false, options: [], suggestions: [], hint: null },
  { key: "weakness", label: "Faiblesse ou coût", type: "text", required: false, options: [], suggestions: [], hint: null },
  { key: "hook", label: "Accroche narrative", type: "text", required: false, options: [], suggestions: [], hint: "Ce que le personnage veut, fuit ou cache." },
];

export const MAX_FIELDS = 12;
const MAX_LIST = 10;
const MAX_TEXT = 200;

/** Fragment de schéma structured-outputs pour un champ de fiche. */
export const SHEET_FIELD_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "label", "type", "options", "suggestions", "hint"],
  properties: {
    key: { type: "string", description: "Identifiant snake_case du champ" },
    label: { type: "string", description: "Libellé en français" },
    type: { type: "string", enum: ["text", "select"] },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Choix fermés (type select), sinon vide",
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "Suggestions tirées du canon (saisie libre possible)",
    },
    hint: { type: "string", description: "Aide courte, ou chaîne vide" },
  },
} as const;

/** Fragment pour une fiche exprimée en paires clé/valeur. */
export const SHEET_PAIRS_OUTPUT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: {
      key: { type: "string" },
      value: { type: "string" },
    },
  },
} as const;

const cleanText = (v: unknown): string =>
  typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";

const cleanList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(cleanText).filter((s) => s !== "").slice(0, MAX_LIST)
    : [];

/**
 * Normalise les champs proposés par le modèle : clés en snake_case dédupliquées,
 * champs de base toujours présents (fusionnés s'ils sont proposés, pour garder
 * leurs suggestions), plafond MAX_FIELDS.
 */
export function normalizeSheetFields(raw: unknown): SheetSchema {
  const proposed: SheetField[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      const key = cleanText(obj.key)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const label = cleanText(obj.label);
      if (key === "" || label === "") continue;
      const options = cleanList(obj.options);
      proposed.push({
        key,
        label,
        type: obj.type === "select" && options.length > 0 ? "select" : "text",
        required: false,
        options,
        suggestions: cleanList(obj.suggestions),
        hint: cleanText(obj.hint) || null,
      });
    }
  }

  const fields: SheetField[] = [];
  const seen = new Set<string>();
  for (const base of BASE_FIELDS) {
    const match = proposed.find((f) => f.key === base.key);
    fields.push({
      ...base,
      // Un champ de base reste libre et requis comme défini, mais hérite
      // des suggestions/hint proposés par le modèle.
      suggestions: match ? match.suggestions : base.suggestions,
      hint: (match && match.hint) || base.hint,
    });
    seen.add(base.key);
  }
  for (const field of proposed) {
    if (seen.has(field.key) || fields.length >= MAX_FIELDS) continue;
    seen.add(field.key);
    fields.push(field);
  }
  return { fields };
}

/** Paires clé/valeur du modèle → objet fiche, clés inconnues conservées. */
export function pairsToSheet(raw: unknown): Record<string, string> {
  const sheet: Record<string, string> = {};
  if (!Array.isArray(raw)) return sheet;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const { key, value } = entry as Record<string, unknown>;
    const k = cleanText(key);
    const v = typeof value === "string" ? value.trim().slice(0, 1000) : "";
    if (k !== "" && v !== "" && !(k in sheet)) sheet[k] = v;
  }
  return sheet;
}

/** Personnages jouables extraits par l'analyse (nom + fiche en paires). */
export function parsePlayableCharacters(raw: unknown): PlayableCharacter[] {
  if (!Array.isArray(raw)) return [];
  const out: PlayableCharacter[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const name = cleanText(obj.name).slice(0, 80);
    if (name === "" || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, sheet: pairsToSheet(obj.sheet) });
    if (out.length >= 8) break;
  }
  return out;
}
