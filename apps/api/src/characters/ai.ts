// Appels Anthropic du flux personnage (SPEC §6bis) : questionnaire éclair,
// génération de fiche « quick », suggestion par champ, validation de fiche.
// Sorties JSON strictes via structured outputs, revalidées côté serveur.

import Anthropic from "@anthropic-ai/sdk";
import { MAX_CANON_CHARS } from "../richness/logic";
import {
  pairsToSheet,
  SHEET_PAIRS_OUTPUT_SCHEMA,
  type SheetSchema,
} from "./schema";

export const CHARACTER_MODEL = "claude-sonnet-5";

export interface QuizQuestion {
  question: string;
  choices: string[];
}

export interface QuizAnswer {
  question: string;
  answer: string;
}

export interface SheetIssue {
  field: string;
  severity: "blocking" | "info";
  message: string;
}

function trimCanon(canonMd: string): string {
  return canonMd.length > MAX_CANON_CHARS
    ? canonMd.slice(0, MAX_CANON_CHARS) + "\n\n[... bible tronquée ...]"
    : canonMd;
}

function schemaBlock(schema: SheetSchema | null): string {
  if (!schema) {
    return "Champs de fiche : name, concept, temperament, ability, weakness, hook.";
  }
  return (
    "Champs de fiche (clé — libellé — options éventuelles) :\n" +
    schema.fields
      .map(
        (f) =>
          `- ${f.key} — ${f.label}${f.options.length ? ` — options : ${f.options.join(", ")}` : ""}`,
      )
      .join("\n")
  );
}

async function structuredCall<T>(
  apiKey: string,
  prompt: string,
  outputSchema: Record<string, unknown>,
  parse: (payload: unknown) => T | null,
): Promise<T> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CHARACTER_MODEL,
    max_tokens: 4000,
    output_config: { format: { type: "json_schema", schema: outputSchema } },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("character_refused");
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("character_invalid_json");
  }
  const result = parse(payload);
  if (result === null) throw new Error("character_invalid_payload");
  return result;
}

// ── Questionnaire éclair (mode Incarner-express) ─────────────────────────

const QUIZ_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "choices"],
        properties: {
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export async function generateQuiz(
  apiKey: string,
  bibleTitle: string,
  canonMd: string,
  schema: SheetSchema | null,
): Promise<QuizQuestion[]> {
  const prompt = `Tu prépares un questionnaire éclair pour créer un personnage joueur dans l'univers « ${bibleTitle} ». Objectif : jouer en moins de 90 secondes.

Produis 3 ou 4 questions à choix multiples (3 à 5 choix chacune), GÉNÉRÉES D'APRÈS CETTE BIBLE — jamais génériques. Gabarits possibles : type de pouvoir parmi ceux qui existent dans ce monde, tempérament, lien avec une faction/divinité du canon, accroche de mystère personnel. Chaque choix est court (moins de 12 mots), évocateur, en français.

${schemaBlock(schema)}

== BIBLE ==
${trimCanon(canonMd)}`;

  return structuredCall(apiKey, prompt, QUIZ_OUTPUT_SCHEMA, (payload) => {
    const obj = payload as { questions?: unknown };
    if (!Array.isArray(obj?.questions)) return null;
    const questions: QuizQuestion[] = [];
    for (const q of obj.questions) {
      const { question, choices } = q as Record<string, unknown>;
      if (typeof question !== "string" || !Array.isArray(choices)) continue;
      const clean = choices.filter(
        (ch): ch is string => typeof ch === "string" && ch.trim() !== "",
      );
      if (question.trim() === "" || clean.length < 2) continue;
      questions.push({ question: question.trim(), choices: clean.slice(0, 5) });
    }
    return questions.length >= 1 ? questions.slice(0, 4) : null;
  });
}

// ── Fiche complète depuis les réponses (origin = quick) ──────────────────

const QUICK_SHEET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "sheet"],
  properties: {
    name: { type: "string" },
    sheet: SHEET_PAIRS_OUTPUT_SCHEMA,
  },
} as const;

export async function generateQuickCharacter(
  apiKey: string,
  bibleTitle: string,
  canonMd: string,
  schema: SheetSchema | null,
  answers: QuizAnswer[],
): Promise<{ name: string; sheet: Record<string, string> }> {
  const answered = answers
    .map((a) => `- ${a.question}\n  → ${a.answer}`)
    .join("\n");
  const prompt = `Rédige la fiche complète d'un personnage joueur pour l'univers « ${bibleTitle} », à partir des réponses du joueur au questionnaire éclair. Reste fidèle au canon ; invente sobrement le reste. Valeurs courtes (une phrase max par champ), en français. Donne un nom qui sonne juste dans ce monde.

${schemaBlock(schema)}

== RÉPONSES DU JOUEUR ==
${answered || "(aucune réponse — improvise un personnage cohérent)"}

== BIBLE ==
${trimCanon(canonMd)}`;

  return structuredCall(apiKey, prompt, QUICK_SHEET_OUTPUT_SCHEMA, (payload) => {
    const obj = payload as { name?: unknown; sheet?: unknown };
    const name = typeof obj?.name === "string" ? obj.name.trim().slice(0, 80) : "";
    if (name === "") return null;
    const sheet = pairsToSheet(obj.sheet);
    if (Object.keys(sheet).length === 0) return null;
    return { name, sheet };
  });
}

// ── Suggestion d'un champ (bouton ✨ du mode Créer) ──────────────────────

const SUGGEST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "string" } },
} as const;

export async function suggestField(
  apiKey: string,
  bibleTitle: string,
  canonMd: string,
  schema: SheetSchema | null,
  sheet: Record<string, string>,
  fieldKey: string,
): Promise<string> {
  const filled = Object.entries(sheet)
    .filter(([, v]) => v.trim() !== "")
    .map(([k, v]) => `- ${k} : ${v}`)
    .join("\n");
  const prompt = `Propose une valeur pour le champ « ${fieldKey} » de cette fiche de personnage de l'univers « ${bibleTitle} ». Cohérente avec le canon ET avec les champs déjà saisis. Une phrase max, en français, sans guillemets.

${schemaBlock(schema)}

== FICHE EN COURS ==
${filled || "(vide)"}

== BIBLE ==
${trimCanon(canonMd)}`;

  return structuredCall(apiKey, prompt, SUGGEST_OUTPUT_SCHEMA, (payload) => {
    const value = (payload as { value?: unknown })?.value;
    return typeof value === "string" && value.trim() !== ""
      ? value.trim().slice(0, 300)
      : null;
  });
}

// ── Validation de fiche (mode Créer) ─────────────────────────────────────

const VALIDATE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "severity", "message"],
        properties: {
          field: { type: "string" },
          severity: { type: "string", enum: ["blocking", "info"] },
          message: { type: "string" },
        },
      },
    },
  },
} as const;

export async function validateSheet(
  apiKey: string,
  bibleTitle: string,
  canonMd: string,
  schema: SheetSchema | null,
  sheet: Record<string, string>,
): Promise<SheetIssue[]> {
  const filled = Object.entries(sheet)
    .map(([k, v]) => `- ${k} : ${v}`)
    .join("\n");
  const prompt = `Relis cette fiche de personnage pour l'univers « ${bibleTitle} ». Signale dans "issues" :
- severity "blocking" : contradiction avec le canon (pouvoir impossible dans ce monde, faction inexistante contredisant une existante, etc.).
- severity "info" : zone grise que le MJ devra interpréter (élément absent du canon mais compatible).
Une fiche cohérente peut rendre une liste vide. Messages courts, en français, champ concerné dans "field".

${schemaBlock(schema)}

== FICHE ==
${filled || "(vide)"}

== BIBLE ==
${trimCanon(canonMd)}`;

  return structuredCall(apiKey, prompt, VALIDATE_OUTPUT_SCHEMA, (payload) => {
    const obj = payload as { issues?: unknown };
    if (!Array.isArray(obj?.issues)) return null;
    const issues: SheetIssue[] = [];
    for (const entry of obj.issues) {
      const { field, severity, message } = entry as Record<string, unknown>;
      if (
        typeof field !== "string" ||
        typeof message !== "string" ||
        (severity !== "blocking" && severity !== "info")
      ) {
        continue;
      }
      issues.push({ field: field.trim(), severity, message: message.trim() });
    }
    return issues;
  });
}
