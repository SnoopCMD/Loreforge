// Prompt système dynamique du MJ (SPEC §7) et questions de mise en place
// (SPEC §4) : logique pure, testable unitairement.

import {
  AXES,
  MAX_CANON_CHARS,
  type RichnessGap,
  type RichnessScores,
} from "../richness/logic";
import {
  describeOutcome,
  SOUFFLE_MAX,
  type GameState,
  type RollResult,
} from "./rules";

export const MAX_SETUP_QUESTIONS = 3;

/**
 * Questions de mise en place : axes de score ≤ 4, priorisés par score
 * croissant, une question par lacune détectée, 3 questions max (SPEC §4).
 */
export function buildSetupQuestions(
  scores: RichnessScores | null,
  gaps: RichnessGap[],
): string[] {
  if (!scores) return [];
  const weakAxes = AXES.filter((axis) => scores[axis] <= 4).sort(
    (a, b) => scores[a] - scores[b],
  );
  const questions: string[] = [];
  for (const axis of weakAxes) {
    for (const gap of gaps) {
      if (gap.axis !== axis) continue;
      questions.push(
        `Zone floue de ta bible (${axis}) : ${gap.description} Que veux-tu établir pour cette session ?`,
      );
      if (questions.length >= MAX_SETUP_QUESTIONS) return questions;
    }
  }
  return questions;
}

export interface SystemPromptInput {
  bibleTitle: string;
  canonMd: string;
  scores: RichnessScores | null;
  gaps: RichnessGap[];
  toneProfile: string | null;
  characterName: string | null;
  characterSheet: string | null; // JSON brut de characters.sheet_json
  format: string;
  trame: string | null;
  state: GameState;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  let canon = input.canonMd;
  if (canon.length > MAX_CANON_CHARS) {
    canon =
      canon.slice(0, MAX_CANON_CHARS) + "\n\n[... bible tronquée ...]";
  }

  const scoresLine = input.scores
    ? AXES.map((axis) => `${axis}: ${input.scores![axis]}/10`).join(", ")
    : "non calculé — improvise prudemment, reste cohérent avec le canon";
  const gapsBlock = input.gaps.length
    ? input.gaps.map((g) => `- [${g.axis}] ${g.description}`).join("\n")
    : "- (aucune lacune détectée)";
  const highAxes = input.scores
    ? AXES.filter((axis) => input.scores![axis] >= 8)
    : [];
  const lowAxes = input.scores
    ? AXES.filter((axis) => input.scores![axis] <= 4)
    : [];

  const tone =
    input.toneProfile ??
    "Déduis le ton du canon ; registre par défaut : aventure fantastique, violence modérée, pas de contenu adulte.";

  const character = input.characterName
    ? `Personnage joueur : ${input.characterName}\nFiche : ${input.characterSheet ?? "{}"}`
    : "Pas de fiche de personnage : improvise une fiche minimale avec le joueur dès la première scène.";

  const facts = input.state.facts.length
    ? input.state.facts.map((f) => `- ${f}`).join("\n")
    : "- (aucun pour l'instant)";

  return `Tu es le Maître de Jeu de l'univers « ${input.bibleTitle} ».

== CANON (source de vérité absolue) ==
${canon}

== PROFIL DE RICHESSE ==
Scores : ${scoresLine}
Lacunes détectées :
${gapsBlock}
Règles dérivées :
- Axes ≥ 8 (${highAxes.join(", ") || "aucun"}) : cite le canon, n'invente qu'en dernier recours.
- Axes ≤ 4 (${lowAxes.join(", ") || "aucun"}) : invente librement mais reste cohérent ; marque chaque invention significative entre balises <invention axis="...">...</invention> (invisibles pour le joueur, extraites par le serveur — place-les en fin de tour, hors narration).

== TON ==
${tone}

== RÈGLES DE JEU ==
Système Souffle : d6 serveur uniquement. Ne lance JAMAIS de dé toi-même ni
n'annonce de résultat : quand une action est risquée, termine ton tour par
<roll reason="..."/> et attends le résultat (1-2 échec avec complication,
3-4 réussite avec coût, 5-6 réussite franche).
Le joueur dispose de ${SOUFFLE_MAX} points de Souffle par session ; 1 point transforme
un échec en réussite ou dope un pouvoir. À 0, épuisement (malus narratif).
Quand la fiction consomme ou rend du Souffle, émets <souffle delta="-1"/>
(ou "+1") — le serveur tient le compte, ne l'annonce pas toi-même en chiffres.
Aux ruptures de scène, émets <scene_break/>.

Partie : format ${input.format}, trame ${input.trame ?? "libre"}.
${character}
Souffle actuel : ${input.state.souffle}/${SOUFFLE_MAX}.
Faits établis en session (jamais contredits) :
${facts}

== STYLE DE NARRATION ==
- Scènes courtes et cinématiques ; termine chaque tour par une question
  ouverte ou 2-3 options concrètes.
- Fais vivre les PNJ canon avec leurs motivations écrites.
- Jamais de contradiction avec le canon ni avec les faits établis en session.
- Réponds en français, uniquement la narration (plus les balises prévues).`;
}

/** Message utilisateur du tour : injecte le résultat du d6 s'il y en a un. */
export function buildTurnMessage(
  playerInput: string,
  lastRoll: RollResult | null,
): string {
  if (!lastRoll) return playerInput;
  return `[Jet d6 (${lastRoll.reason}) : ${lastRoll.value} → ${describeOutcome(lastRoll.outcome)}]\n\n${playerInput}`;
}

/** Premier message utilisateur : réponses de mise en place + scène 1. */
export function buildSetupMessage(
  questions: string[],
  answers: string[],
): string {
  const qa = questions
    .map((q, i) => {
      const answer = answers[i]?.trim();
      return `Q : ${q}\nR : ${answer || "(le joueur te laisse décider)"}`;
    })
    .join("\n");
  return `== MISE EN PLACE ==
${qa || "(pas de questions de mise en place)"}

Ouvre la scène 1 : pose le décor, introduis le personnage joueur, termine
par une question ouverte ou 2-3 options concrètes.`;
}

/** Dernier message utilisateur avant résumé de fin de session. */
export const SUMMARY_MESSAGE = `La session est terminée. Rédige un résumé structuré en Markdown avec les
sections : ## Résumé, ## Faits marquants, ## PNJ rencontrés, ## Fils laissés
ouverts. Réponds uniquement avec ce Markdown, sans aucune balise.`;
