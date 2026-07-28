// Génération courte fondée sur le canon (même esprit que les <invention> de
// session) : transformer un retour d'auteur en proposition de modification
// ciblée. Toujours cohérent avec le canon, jamais de méta — que du texte prêt
// à rejoindre la bible.

import Anthropic from "@anthropic-ai/sdk";
import { AXES, type Axis } from "./logic";

const SUGGEST_MODEL = "claude-sonnet-5";
// Le canon peut être volumineux : on borne l'entrée (les extraits de tête
// suffisent pour rester cohérent sur une suggestion courte).
const MAX_CANON_CHARS = 24_000;

function clampCanon(canonMd: string): string {
  const c = canonMd.trim();
  return c.length > MAX_CANON_CHARS
    ? c.slice(0, MAX_CANON_CHARS) + "\n\n[… canon tronqué …]"
    : c;
}

export interface CommentProposal {
  /** L'IA juge-t-elle qu'une modification de canon est pertinente ? */
  relevant: boolean;
  axis: Axis;
  content_md: string;
}

const COMMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "axis", "content_md"],
  properties: {
    relevant: { type: "boolean" },
    axis: { type: "string", enum: [...AXES] },
    content_md: { type: "string" },
  },
} as const;

/**
 * Transforme un retour d'auteur (sur un passage précis du résumé, ou général)
 * en proposition de modification ciblée du canon. `relevant:false` quand le
 * retour n'appelle aucun changement de bible (simple appréciation). Repli sûr
 * (relevant:false) si l'appel échoue.
 */
export async function suggestFromComment(
  apiKey: string,
  canonMd: string,
  passage: string,
  comment: string,
): Promise<CommentProposal> {
  const client = new Anthropic({ apiKey });
  const passageBlock = passage.trim()
    ? `Passage du résumé concerné :\n« ${passage.trim()} »\n\n`
    : "Retour général sur la session (aucun passage précis).\n\n";
  const prompt = `Tu fais évoluer la bible d'un univers de jeu de rôle à partir du
retour de son auteur sur une session jouée. Canon actuel :
---
${clampCanon(canonMd)}
---

${passageBlock}Retour de l'auteur :
« ${comment.trim()} »

Décide si ce retour appelle une MODIFICATION du canon. Considère comme
pertinent tout retour qui : précise ou corrige un élément d'univers, établit un
fait, exprime une préférence durable (ton, rythme, type de scènes, contenu à
éviter ou à favoriser) ou infléchit une trame. Dans ce cas, ANALYSE le retour
et REFORMULE-le façon bible (cohérent, concret, sans méta ni référence à la
session), puis choisis l'axe le plus concerné parmi : ${AXES.join(", ")}.
Ne mets relevant à false QUE pour une pure appréciation sans contenu
exploitable (« super session », « j'ai adoré ») — content_md vide alors.

Réponds en JSON strict : { "relevant", "axis", "content_md" }.`;

  try {
    const stream = client.messages.stream({
      model: SUGGEST_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: COMMENT_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error("comment_refused");
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = JSON.parse(text) as Partial<CommentProposal>;
    const axis = (AXES as readonly string[]).includes(parsed.axis as string)
      ? (parsed.axis as Axis)
      : "plots";
    const content = typeof parsed.content_md === "string" ? parsed.content_md.trim() : "";
    return { relevant: parsed.relevant === true && content !== "", axis, content_md: content };
  } catch (err) {
    console.error("[suggest] proposition depuis commentaire échouée :", err);
    return { relevant: false, axis: "plots", content_md: "" };
  }
}

// ── Canonisation des réponses aux zones floues (mise en place) ─────────────

/** Réponse d'auteur à une zone floue posée avant la session. */
export interface GapAnswer {
  axis: string;
  /** Description de la lacune telle que stockée dans gaps_json. */
  description: string;
  answer: string;
}

const GAP_ANSWERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["axis", "content_md"],
        properties: {
          axis: { type: "string", enum: [...AXES] },
          content_md: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Reformule en un seul appel chaque réponse de mise en place en texte prêt à
 * rejoindre la bible (une entrée par réponse, même ordre). Les décisions de
 * l'auteur sont respectées, jamais réinterprétées. Repli sûr par entrée : la
 * réponse brute, si l'appel échoue ou renvoie un nombre d'entrées inattendu.
 */
export async function canonizeGapAnswers(
  apiKey: string,
  canonMd: string,
  items: GapAnswer[],
): Promise<Array<{ axis: Axis; content_md: string }>> {
  const fallback = items.map((it) => ({
    axis: (AXES as readonly string[]).includes(it.axis)
      ? (it.axis as Axis)
      : ("plots" as Axis),
    content_md: it.answer.trim(),
  }));
  if (items.length === 0) return [];

  const client = new Anthropic({ apiKey });
  const list = items
    .map(
      (it, i) =>
        `${i + 1}. [${it.axis}] Zone floue : ${it.description}\n   Réponse de l'auteur : « ${it.answer.trim()} »`,
    )
    .join("\n");
  const prompt = `Avant une session de jeu de rôle, l'auteur de cet univers a répondu à des
questions sur des zones floues de sa bible. Canon actuel :
---
${clampCanon(canonMd)}
---

Réponses à intégrer :
${list}

Pour CHAQUE réponse, dans le même ordre, rédige le texte prêt à rejoindre la
bible : reformule la décision de l'auteur façon bible (concret, cohérent avec
le canon, sans méta, sans mention de la session ni de la question). Respecte
fidèlement le choix exprimé — n'ajoute rien qui le contredise, ne le
réinterprète pas. Reprends l'axe indiqué entre crochets.

Réponds en JSON strict : { "entries": [ { "axis", "content_md" }, … ] } —
exactement ${items.length} entrée(s), même ordre que la liste.`;

  try {
    const stream = client.messages.stream({
      model: SUGGEST_MODEL,
      max_tokens: 2048,
      output_config: {
        format: { type: "json_schema", schema: GAP_ANSWERS_SCHEMA },
      },
      messages: [{ role: "user", content: prompt }],
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error("gap_refused");
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = JSON.parse(text) as {
      entries?: Array<{ axis?: unknown; content_md?: unknown }>;
    };
    if (!Array.isArray(parsed.entries)) return fallback;
    return items.map((_, i) => {
      const entry = parsed.entries![i];
      const content =
        typeof entry?.content_md === "string" ? entry.content_md.trim() : "";
      if (!content) return fallback[i];
      const axis = (AXES as readonly string[]).includes(entry.axis as string)
        ? (entry.axis as Axis)
        : fallback[i].axis;
      return { axis, content_md: content };
    });
  } catch (err) {
    console.error("[suggest] canonisation des réponses de mise en place :", err);
    return fallback;
  }
}
