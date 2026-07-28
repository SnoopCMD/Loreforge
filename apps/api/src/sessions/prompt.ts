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
  SKILL_TIERS,
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
  /** Retours d'auteur de sessions passées (contexte à honorer). */
  authorFeedback?: string[];
  toneProfile: string | null;
  characterName: string | null;
  characterSheet: string | null; // JSON brut de characters.sheet_json
  format: string;
  trame: string | null;
}

/**
 * Prompt système STABLE : tout ce qui est fixé à l'init de la session et rien
 * d'autre. Il doit rester identique à l'octet près d'un tour à l'autre — c'est
 * le préfixe mis en cache par l'API (prompt caching) ; l'état volatile (Souffle,
 * faits, compétences, extraits RAG) voyage dans le bloc [CONTEXTE DU TOUR] du
 * message joueur, via buildTurnContext().
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  let canon = input.canonMd;
  if (canon.length > MAX_CANON_CHARS) {
    canon = canon.slice(0, MAX_CANON_CHARS) + "\n\n[... bible tronquée ...]";
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

  const feedbackBlock = input.authorFeedback?.length
    ? `

== RETOURS DE L'AUTEUR (sessions passées) ==
L'auteur a laissé ces remarques sur des sessions précédentes de cet univers.
Honore-les (ton, orientation, préférences) sans jamais contredire le canon :
${input.authorFeedback.map((f) => `- ${f}`).join("\n")}`
    : "";

  return `Tu es le Maître de Jeu de l'univers « ${input.bibleTitle} ».

== CANON (source de vérité absolue) ==
La bible est organisée en dossiers et sous-dossiers : la hiérarchie des titres
(##, ###, ####…) reflète cette imbrication. Un sous-titre appartient à la
section qui le précède au niveau supérieur — par exemple, chaque trame et ses
détails sont regroupés sous « Trames & conflits actifs ». Lis chaque passage
dans le contexte de ses titres parents.
${canon}

== PROFIL DE RICHESSE ==
Scores : ${scoresLine}
Lacunes détectées :
${gapsBlock}
Règles dérivées :
- Axes ≥ 8 (${highAxes.join(", ") || "aucun"}) : cite le canon, n'invente qu'en dernier recours.
- Axes ≤ 4 (${lowAxes.join(", ") || "aucun"}) : invente librement mais reste cohérent ; marque chaque invention significative entre balises <invention axis="...">...</invention> (invisibles pour le joueur, extraites par le serveur — place-les en fin de tour, hors narration).

== TERMES D'UNIVERS (glossaire cliquable) ==
Quand tu emploies un nom propre porteur de lore — personnage, faction, lieu ou
concept d'univers (ex. « Garde Blanche », « Commandant Aurélio Kass »,
« la Source ») — enveloppe SA PREMIÈRE mention du tour dans une balise
<lore term="Nom canonique" kind="personnage|faction|lieu|concept">texte
affiché</lore>. Le texte affiché reste visible et lu normalement ; la balise
est invisible pour le joueur et rend le terme cliquable. N'annote pas les mots
ordinaires ni chaque répétition — juste les termes d'univers, une fois par tour.
Si tu inventes un terme d'univers (axe faible), annote-le AUSSI avec <lore>, et
définis-le via <invention> pour qu'il ne reste pas « mort ».

== TON ==
${tone}${feedbackBlock}

== RÈGLES DE JEU ==
Système Souffle : d6 serveur uniquement. Ne lance JAMAIS de dé toi-même ni
n'annonce de résultat. Quand une action est risquée : narre JUSQU'À l'instant
de bascule (le geste s'amorce, l'issue reste incertaine), SANS décrire le
résultat ni la moindre conséquence, puis émets <roll reason="..."/> et
termine ton tour immédiatement — pas une phrase de plus. Le résultat
(1-2 échec avec complication, 3-4 réussite avec coût, 5-6 réussite franche)
te sera transmis au tour suivant : reprends alors la narration exactement où
elle s'était arrêtée et raconte l'issue selon ce résultat.
Le joueur dispose de ${SOUFFLE_MAX} points de Souffle par session ; 1 point transforme
un échec en réussite ou dope un pouvoir. À 0, épuisement (malus narratif).
Quand la fiction consomme ou rend du Souffle, émets <souffle delta="-1"/>
(ou "+1") — le serveur tient le compte, ne l'annonce pas toi-même en chiffres.
Aux ruptures de scène, émets <scene_break/>.

Partie : format ${input.format}, trame ${input.trame ?? "libre"}.
${character}

== COMPÉTENCES DU PERSONNAGE (mémoire longue) ==
Le personnage acquiert et fait progresser des compétences (pouvoirs, savoir-
faire, techniques). Paliers, du plus fragile au plus assimilé :
${SKILL_TIERS.map((t, i) => `${i + 1}. ${t}`).join(" → ")}.
- Quand le personnage apprend une compétence, progresse d'un palier, ou qu'une
  capacité de sa fiche mérite d'être suivie, émets (hors narration, invisible) :
  <skill name="Nom de la compétence" tier="découverte|apprentissage|maîtrise|inné" note="limite ou portée, courte"/>
- La liste à jour t'est fournie chaque tour dans le CONTEXTE DU TOUR. Elle fait
  foi : ne « redécouvre » JAMAIS une compétence déjà listée, et n'exige jamais
  de réapprentissage.
- Jets de dés selon le palier :
  · découverte : usage incertain → <roll/> requis.
  · apprentissage : usage simple réussi ; <roll/> seulement en situation
    difficile ou sous pression.
  · maîtrise : usage réussi d'office, sans jet, décrit avec l'aisance d'un
    expert ; <roll/> uniquement si l'enjeu dépasse la compétence (opposition
    exceptionnelle, finalité incertaine, conditions extrêmes).
  · inné : l'usage n'appelle JAMAIS de jet ; seules les conséquences externes
    peuvent en appeler un.
- Un jet raté sur une compétence maîtrisée porte sur l'enjeu, jamais sur la
  capacité elle-même (l'expert ne « rate » pas son geste de base).

== MÉMOIRE DES FAITS ==
Quand un événement marquant établit un fait durable (mort d'un PNJ, promesse,
lieu découvert, objet obtenu, révélation), enregistre-le (hors narration,
invisible) : <fait texte="résumé du fait, une phrase"/>. Les faits établis te
sont refournis chaque tour dans le CONTEXTE DU TOUR et ne sont jamais
contredits, même si la scène d'origine est sortie de l'historique.

== CONTEXTE DU TOUR ==
Le dernier message joueur commence par un bloc [CONTEXTE DU TOUR ...] injecté
par le serveur : Souffle courant, faits établis, compétences acquises et, si la
bible est volumineuse, des extraits complémentaires pertinents pour ce tour.
Ce bloc est la vérité serveur : appuie-toi dessus en priorité. Il est invisible
pour le joueur — ne le recopie jamais, n'y fais jamais référence explicitement.

== STYLE DE NARRATION ==
- Scènes courtes et cinématiques.
- RÈGLE NON NÉGOCIABLE — fin de tour : chaque tour DOIT se terminer soit par
  une question ouverte explicite adressée au joueur, soit par 2-3 options
  concrètes numérotées ou à puces. JAMAIS sur une simple description ou une
  scène qui « retombe » sans relance. La seule exception est une action risquée
  suspendue sur <roll reason="..."/> (l'issue devient alors la relance).
- Fais vivre les PNJ canon avec leurs motivations écrites.
- Jamais de contradiction avec le canon ni avec les faits établis en session.
- Réponds en français, uniquement la narration (plus les balises prévues).`;
}

/**
 * Bloc d'état volatile injecté en tête du message joueur ENVOYÉ au modèle
 * (jamais stocké dans l'historique : le préfixe des messages reste ainsi
 * identique d'une requête à l'autre et le cache de prompt tient, et les gros
 * extraits RAG ne sont facturés qu'une fois).
 */
export function buildTurnContext(
  state: GameState,
  canonExcerpts?: string | null,
): string {
  const facts = state.facts.length
    ? state.facts.map((f) => `- ${f}`).join("\n")
    : "- (aucun pour l'instant)";
  const skills = (state.skills ?? []).length
    ? (state.skills ?? [])
        .map((s) => `- ${s.name} — ${s.tier}${s.note ? ` (${s.note})` : ""}`)
        .join("\n")
    : "- (aucune pour l'instant)";

  const excerptsBlock = canonExcerpts
    ? `
Extraits de la bible pertinents pour ce tour (bible volumineuse — si un détail
manque, reste prudent et cohérent avec le canon fourni au système) :
${canonExcerpts}
`
    : "";

  return `[CONTEXTE DU TOUR — vérité serveur, invisible pour le joueur, ne jamais recopier]
Souffle : ${state.souffle}/${SOUFFLE_MAX}
Faits établis (jamais contredits) :
${facts}
Compétences acquises (nom — palier) :
${skills}
${excerptsBlock}[FIN DU CONTEXTE]`;
}

/** Message utilisateur du tour : injecte le résultat du d6 s'il y en a un.
 * Saisie vide + jet = tour de continuation (le MJ reprend la narration). */
export function buildTurnMessage(
  playerInput: string,
  lastRoll: RollResult | null,
): string {
  if (!lastRoll) return playerInput;
  const rollLine = `[Jet d6 (${lastRoll.reason}) : ${lastRoll.value} → ${describeOutcome(lastRoll.outcome)}]`;
  return playerInput.trim() === ""
    ? rollLine
    : `${rollLine}\n\n${playerInput}`;
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

// ── Garde-fou de fin de tour (§7) ─────────────────────────────────────────

// Une ligne d'options concrètes de fin de tour (puce ou numéro).
const OPTION_LINE = /^(?:[-–—•*]|\d{1,2}[.)])\s+\S/;

/**
 * Le tour se termine-t-il « ouvert » ? Vrai si les 2 dernières phrases posent
 * une question, OU si la narration se clôt sur ≥ 2 options listées. Sert de
 * filet serveur : sinon on relance le modèle pour une vraie relance.
 * Reçoit la narration VISIBLE (balises déjà retirées).
 */
export function turnEndsOpen(narration: string): boolean {
  const text = narration.trim();
  if (!text) return true; // rien à relancer (cas d'erreur amont)

  // Bloc d'options en fin de narration.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let opts = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_LINE.test(lines[i])) opts++;
    else break;
  }
  if (opts >= 2) return true;

  // Point d'interrogation dans les 2 dernières phrases.
  const sents = text.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [text];
  return sents.slice(-2).join(" ").includes("?");
}

/** Second appel court quand un tour retombe fermé (filet, invisible au joueur). */
export const RELANCE_MESSAGE = `Termine ce tour par une question ouverte ou 2-3 options concrètes pour le
joueur, sans répéter la scène ni la narration précédente. Réponds uniquement
avec cette relance (1 à 3 phrases), sans aucune balise.`;

/** Dernier message utilisateur avant résumé de fin de session. */
export const SUMMARY_MESSAGE = `La session est terminée. Rédige un résumé structuré en Markdown avec les
sections : ## Résumé, ## Faits marquants, ## PNJ rencontrés, ## Fils laissés
ouverts. Réponds uniquement avec ce Markdown, sans aucune balise.`;
