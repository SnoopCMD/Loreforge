// Générations courtes fondées sur le canon (même esprit que les <invention>
// de session) : combler une zone floue, ou transformer un retour d'auteur en
// proposition de modification ciblée. Toujours cohérent avec le canon, jamais
// de méta — que du texte prêt à rejoindre la bible.

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

/**
 * Rédige 1 à 2 paragraphes façon bible pour combler une zone floue sur un axe
 * donné. Renvoie du markdown prêt à insérer dans la section. Jette si l'appel
 * échoue (l'appelant gère l'erreur HTTP).
 */
export async function suggestGapFill(
  apiKey: string,
  canonMd: string,
  axis: Axis,
  description: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const prompt = `Tu enrichis la bible d'un univers de jeu de rôle. Voici le canon
existant (source de vérité) :
---
${clampCanon(canonMd)}
---

Une analyse a repéré une ZONE FLOUE sur l'axe « ${axis} » :
« ${description} »

Rédige 1 à 2 paragraphes en français, façon bible d'univers, qui comblent
précisément ce manque. Contraintes :
- Strictement cohérent avec le canon ci-dessus (ne le contredis jamais).
- Concret et jouable : des faits, des noms, des règles — pas des généralités.
- Aucune méta, aucun préambule ni titre : uniquement le texte à insérer.`;

  const response = await client.messages.create({
    model: SUGGEST_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
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

Décide si ce retour appelle une MODIFICATION du canon (précision, ajout,
inflexion de ton…). Si oui, rédige la proposition (façon bible, cohérente,
concrète, sans méta) et choisis l'axe le plus concerné parmi : ${AXES.join(", ")}.
Si le retour est une simple appréciation sans conséquence sur la bible, mets
relevant à false (et content_md vide).

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
