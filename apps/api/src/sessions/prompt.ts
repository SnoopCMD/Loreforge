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
  DIFFICULTY_LABELS,
  MAX_POOL,
  ROLL_BONUS_DICE,
  ROLL_BONUS_LABELS,
  SKILL_TIERS,
  SOUFFLE_MAX,
  STANCE_LABELS,
  type GameState,
  type RollResult,
} from "./rules";

export const MAX_SETUP_QUESTIONS = 3;

/** Ce que la session qui commence a déjà de concret : sert à trier les flous. */
export interface SetupContext {
  /** Fil rouge posé par l'auteur avant d'ouvrir la scène 1. */
  trame?: string | null;
  characterName?: string | null;
  characterSheet?: string | null;
}

// Mots trop courants pour porter du sens : ils feraient matcher n'importe quoi.
const STOPWORDS = new Set([
  "aucun", "aucune", "alor", "auss", "autre", "avec", "avoir", "bien", "cela",
  "cette", "chez", "comme", "dan", "depui", "doit", "donc", "elle", "encore",
  "entre", "etre", "fait", "faire", "flou", "leur", "mais", "meme", "moin",
  "niveau", "pas", "peu", "peut", "plu", "pour", "quand", "quel", "quelle",
  "sans", "sont", "sous", "sur", "toujour", "tout", "toute", "tres", "vers",
]);

/**
 * Mots porteurs de sens d'un texte : sans accents, sans pluriel, ≥ 4 lettres.
 * Le dé-pluralisation est volontairement naïve — on compare des noms propres
 * et des termes d'univers, pas de la prose.
 */
function keywords(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .map((w) => w.replace(/s$/, ""))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

function countShared(target: Set<string>, source: Set<string>): number {
  let n = 0;
  for (const word of source) if (target.has(word)) n++;
  return n;
}

/**
 * Pertinence d'une zone floue pour la session qui commence (0 = hors sujet).
 * Le fil rouge pèse le double du personnage : c'est lui qui dit de quoi la
 * partie va parler.
 */
function gapRelevance(gap: RichnessGap, context: SetupContext): number {
  const target = keywords(gap.description);
  if (target.size === 0) return 0;
  return (
    2 * countShared(target, keywords(context.trame)) +
    countShared(
      target,
      keywords([context.characterName, context.characterSheet].join(" ")),
    )
  );
}

/**
 * Repli hors ligne de la sélection : les zones floues que le contexte de la
 * session touche vraiment, les plus proches d'abord, puis par score d'axe
 * croissant ; 3 max (SPEC §4).
 *
 * Le tri normal passe par un scoring IA (voir setup-relevance.ts) ; cette
 * version par mots-clés ne sert que si cet appel échoue. Elle ne rend RIEN
 * quand le contexte ne recoupe aucune lacune : une mise en place courte vaut
 * mieux qu'une mise en place hors sujet — c'est exactement ce que produisait
 * l'ancien repli « par axe le plus faible », qui faisait trancher les six
 * Gardiens à une partie de gangs urbains.
 *
 * Renvoyer les lacunes (et pas les questions) permet de relier chaque réponse
 * du joueur à sa zone floue d'origine — la boucle de canonisation en dépend.
 */
export function selectSetupGaps(
  scores: RichnessScores | null,
  gaps: RichnessGap[],
  context: SetupContext = {},
): RichnessGap[] {
  if (!scores) return [];
  const pool = gaps
    .filter((gap) => (AXES as readonly string[]).includes(gap.axis))
    .map((gap, index) => ({
      gap,
      index,
      relevance: gapRelevance(gap, context),
    }))
    .filter((r) => r.relevance > 0);

  pool.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      scores[a.gap.axis] - scores[b.gap.axis] ||
      a.index - b.index,
  );
  return pool.slice(0, MAX_SETUP_QUESTIONS).map((r) => r.gap);
}

/** Question posée au joueur pour une zone floue donnée. */
export function gapQuestion(gap: RichnessGap): string {
  return `Zone floue de ta bible (${gap.axis}) : ${gap.description} Que veux-tu établir pour cette session ?`;
}

/** Questions de mise en place (SPEC §4) — même ordre que selectSetupGaps. */
export function buildSetupQuestions(
  scores: RichnessScores | null,
  gaps: RichnessGap[],
  context: SetupContext = {},
): string[] {
  return selectSetupGaps(scores, gaps, context).map(gapQuestion);
}

export interface SystemPromptInput {
  bibleTitle: string;
  canonMd: string;
  scores: RichnessScores | null;
  gaps: RichnessGap[];
  /** Retours d'auteur de sessions passées (contexte à honorer). */
  authorFeedback?: string[];
  toneProfile: string | null;
  /** Annexe des tableaux de références (§8) ; vide s'il n'y en a pas. */
  moodboardAnnex?: string;
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

  // Fil rouge : l'intention que l'auteur pose avant d'ouvrir la scène 1. Il
  // oriente la partie sans devenir un script — le joueur reste libre.
  const trameBlock = input.trame
    ? `Fil rouge voulu par l'auteur pour cette session : ${input.trame}
Traite-le comme l'intention directrice de la partie : oriente les scènes, les
enjeux et les PNJ vers lui dès la première scène. Ce n'est pas un script — ne
l'impose jamais de force, ne contredis jamais le canon, et laisse le joueur
libre de s'en écarter (la partie suit alors le joueur, pas le fil rouge).`
    : "Trame libre : laisse la partie trouver sa direction avec le joueur.";

  const feedbackBlock = input.authorFeedback?.length
    ? `

== RETOURS DE L'AUTEUR (sessions passées) ==
L'auteur a laissé ces remarques sur des sessions précédentes de cet univers.
Honore-les (ton, orientation, préférences) sans jamais contredire le canon :
${input.authorFeedback.map((f) => `- ${f}`).join("\n")}`
    : "";

  // L'ambiance oriente la description (lumière, matières, échelle), jamais les
  // faits : elle vient donc après le ton, et se dit explicitement non canon.
  const moodboardBlock = input.moodboardAnnex
    ? `

${input.moodboardAnnex}

Décris avec ces matières, cette lumière et cette échelle. En cas de désaccord
entre une image et le canon, le canon gagne toujours.`
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
${tone}${feedbackBlock}${moodboardBlock}

== RÈGLES DE JEU ==
Système Souffle : dés d6 serveur uniquement. Ne lance JAMAIS de dé toi-même ni
n'annonce de résultat. Quand une action est risquée : narre JUSQU'À l'instant
de bascule (le geste s'amorce, l'issue reste incertaine), SANS décrire le
résultat ni la moindre conséquence, puis émets la balise de jet et termine ton
tour immédiatement — pas une phrase de plus.

C'est TOI qui fixes les conditions du jet d'après le contexte de la scène :
<roll reason="ce qui est tenté" difficulty="easy|normal|hard"
      stance="advantage|neutral|disadvantage" dice="1-${MAX_POOL}"
      bonuses="temperament: ce qui l'aligne ; ability: ce qu'elle mobilise"
      skills="compétences engagées, séparées par des virgules"/>
- difficulty : facile (1-2 échec, 3-6 réussite) quand la situation aide ;
  normal (1-3 échec, 4-6 réussite) par défaut ;
  difficile (1-4 échec, 5-6 réussite) quand la fiction est hostile.
- stance : advantage si la position, la préparation ou un allié favorisent
  l'action (on garde le meilleur dé) ; disadvantage si blessure, obscurité,
  encombrement, épuisement (on garde le pire) ; neutral sinon.

NOMBRE DE DÉS — barème strict, pas d'appréciation libre :
  1 dé de base
  +1 si l'action s'aligne avec le TEMPÉRAMENT du personnage
  +1 si elle mobilise sa CAPACITÉ principale
  +1 si un point de Souffle est dépensé pour l'action
  -1 si elle heurte frontalement sa FAIBLESSE déclarée
  plancher 1 dé, plafond ${MAX_POOL} dés. On garde le meilleur dé obtenu
  (le pire en disadvantage) et on le compare au seuil de difficulté.
À CHAQUE jet, énumère dans bonuses les bonus appliqués et pourquoi, sources
séparées par des points-virgules : temperament, ability, souffle, weakness.
Exemple : <roll reason="pousser Reika à révéler la faille du sigil" dice="3"
bonuses="temperament: provocation, pousser à la faute ; ability: sigils"
difficulty="normal" stance="neutral" skills="comédie, lecture sociale"/>
Sois généreux et littéral : dès que l'action recoupe le tempérament ou la
capacité écrits sur la fiche — même partiellement, même sur un registre social
plutôt que physique — le bonus est dû. Un jet à 1 dé est réservé aux actions
qui ne doivent rien à la fiche. Le serveur recalcule la poignée depuis
bonuses : un dice qui ne correspond pas à tes bonus ne sera pas suivi.
- skills : nomme les compétences ou atouts engagés (affichage) ; leur palier
  décide s'il faut un jet, pas combien de dés (voir plus bas).
L'issue est binaire : réussite ou échec, avec critique sur 6 et sur 1. Chaque
dé à 5 ou 6 annule un dé raté. Le résultat te sera transmis au tour suivant :
reprends alors la narration exactement où elle s'était arrêtée et raconte
l'issue. Un critique amplifie franchement (aubaine inespérée / catastrophe).
Le joueur dispose de ${SOUFFLE_MAX} points de Souffle par session ; 1 point transforme
un échec en réussite ou dope un pouvoir. À 0, épuisement (malus narratif).
Quand la fiction consomme ou rend du Souffle, émets <souffle delta="-1"/>
(ou "+1") — le serveur tient le compte, ne l'annonce pas toi-même en chiffres.
Aux ruptures de scène, émets <scene_break/>.

Partie : format ${input.format}.
${trameBlock}
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
- Quand un jet a bien lieu, nomme les compétences engagées dans skills. Une
  compétence qui relève de la capacité principale de la fiche justifie le
  bonus ability du barème ; les paliers, eux, décident du BESOIN d'un jet, pas
  du nombre de dés.

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
  suspendue sur <roll .../> (l'issue devient alors la relance).
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
  const dice = lastRoll.dice
    .map(
      (d) =>
        `${d.value}${d.kept ? "*" : ""}${d.cancelled ? " (annulé)" : ""}`,
    )
    .join(", ");
  const skills = lastRoll.skills.length
    ? `, compétences : ${lastRoll.skills.join(", ")}`
    : "";
  // Les bonus retenus sont renvoyés au MJ : il voit le barème appliqué (y
  // compris ce que la vérification serveur a rattrapé) et s'y aligne.
  const bonuses = lastRoll.bonuses.length
    ? `, bonus : ${lastRoll.bonuses
        .map(
          (b) =>
            `${ROLL_BONUS_DICE[b.source] > 0 ? "+1" : "-1"} ${ROLL_BONUS_LABELS[b.source]}${b.why ? ` (${b.why})` : ""}`,
        )
        .join(", ")}`
    : "";
  const rollLine = `[Jet ${lastRoll.reason} — difficulté ${DIFFICULTY_LABELS[lastRoll.difficulty]} (réussite à ${lastRoll.threshold}+), ${STANCE_LABELS[lastRoll.stance]}${skills}${bonuses} : ${lastRoll.dice.length} dé${lastRoll.dice.length > 1 ? "s" : ""} ${dice} → dé retenu ${lastRoll.value}, ${describeOutcome(lastRoll.outcome)}]`;
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
