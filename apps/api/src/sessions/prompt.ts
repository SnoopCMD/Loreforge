// Prompt système dynamique du MJ (SPEC §7) et questions de mise en place
// (SPEC §4) : logique pure, testable unitairement.

import {
  AXES,
  MAX_CANON_CHARS,
  type RichnessGap,
  type RichnessScores,
} from "../richness/logic";
import {
  characterState,
  describeOutcome,
  DIFFICULTY_LABELS,
  MAX_POOL,
  ROLL_BONUS_DICE,
  ROLL_BONUS_LABELS,
  SKILL_TIERS,
  SOUFFLE_MAX,
  STANCE_LABELS,
  stateKey,
  type CharacterState,
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
  /** Table partagée : le MJ s'adresse à plusieurs personnages nommés. */
  multiplayer?: boolean;
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

  // À une table, les fiches ne peuvent PAS vivre ici : ce bloc est le préfixe
  // mis en cache et doit rester identique à l'octet près, or les joueurs vont
  // et viennent. Elles voyagent dans [CONTEXTE DU TOUR], relues à chaque tour.
  const character = input.multiplayer
    ? `Les personnages de la table, leurs fiches et leur état sont donnés à
chaque tour dans [CONTEXTE DU TOUR]. Ne les invente jamais : lis-les.`
    : input.characterName
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
  +1 si elle engage une COMPÉTENCE acquise au palier maîtrise ou inné
  +1 si un point de Souffle est dépensé pour l'action
  -1 si elle heurte frontalement sa FAIBLESSE déclarée
  plancher 1 dé, plafond ${MAX_POOL} dés — le cumul peut dépasser, il est
  simplement écrêté. On garde le meilleur dé obtenu (le pire en disadvantage)
  et on le compare au seuil de difficulté.
À CHAQUE jet, énumère dans bonuses les bonus appliqués et pourquoi, sources
séparées par des points-virgules : temperament, ability, skill, souffle,
weakness. Le bonus skill est vérifié sur la liste des compétences acquises :
inutile de le réclamer pour une compétence à découverte ou apprentissage, et
inutile de l'oublier pour une compétence à maîtrise — le serveur le corrige
dans les deux sens à partir des compétences que tu nommes dans skills.
Exemple : <roll reason="pousser Reika à révéler la faille du sigil" dice="3"
bonuses="temperament: provocation, pousser à la faute ; ability: sigils"
difficulty="normal" stance="neutral" skills="comédie, lecture sociale"/>
Sois généreux et littéral : dès que l'action recoupe le tempérament ou la
capacité écrits sur la fiche — même partiellement, même sur un registre social
plutôt que physique — le bonus est dû. Un jet à 1 dé est réservé aux actions
qui ne doivent rien à la fiche. Le serveur recalcule la poignée depuis
bonuses : un dice qui ne correspond pas à tes bonus ne sera pas suivi.
N'écris JAMAIS de < ni de > dans une valeur d'attribut (pas de « -> », pas de
« => ») : quelques mots par source suffisent.
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
Aux ruptures de scène, émets <scene_break/>.${input.multiplayer ? TABLE_RULES : ""}

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
- Le palier joue donc deux fois : il décide du BESOIN d'un jet (ci-dessus) et,
  quand le jet a lieu quand même, il pèse sur la poignée — une compétence
  engagée à maîtrise ou inné vaut +1 dé (bonus skill du barème). Nomme
  toujours les compétences engagées dans skills : c'est sur elles que le
  serveur vérifie ce bonus.

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
 * Règles propres à une table de plusieurs joueurs. Ce bloc est ajouté à la
 * CONSTRUCTION du prompt système, donc une fois pour toute la session : il est
 * stable, et le cache ephemeral tient. Le roster, lui, change au fil des
 * arrivées et des départs — il voyage dans le contexte du tour, jamais ici.
 */
const TABLE_RULES = `

== TABLE DE PLUSIEURS JOUEURS ==
Tu ne t'adresses pas à un joueur mais à plusieurs personnages nommés, listés
dans le CONTEXTE DU TOUR avec leur Souffle et leurs compétences. Répartis ton
attention entre eux : sur quelques tours, chacun doit avoir eu une occasion
d'agir, d'être vu et d'être en danger. Ne fusionne jamais deux personnages en
un « vous » indistinct.

Le message du tour te transmet les actions de chacun, attribuées par nom.
Résous-les DANS LA MÊME narration, en tenant compte de leurs interactions
(deux joueurs qui tentent la même chose, ou l'un qui contrarie l'autre).

Quand une balise d'état concerne un personnage précis, dis lequel :
  <souffle delta="-1" character="Mira"/>
  <skill name="Crochetage" tier="apprentissage" character="Mira"/>
  <roll reason="..." character="Mira" difficulty="normal" stance="neutral"
        dice="2" bonuses="..." skills="..."/>
Sans attribut character, la balise s'applique au personnage qui vient d'agir —
donc n'omets l'attribut que s'il n'y a aucune ambiguïté.

== FIN DE TOUR À UNE TABLE ==
La règle de relance vaut POUR CHACUN, séparément. Termine par un bloc
d'options par personnage pouvant agir — 2 ou 3 options chacun, taillées pour
CE personnage (sa fiche, sa position dans la scène, ce qu'il vient de faire) —
sous cette forme exacte, en toute fin de narration :

Mira :
- écouter derrière la porte
- reculer sans bruit

Kaelen :
- forcer le passage
- couvrir Mira

Le nom seul suivi de deux-points, puis ses options à puces : chaque joueur ne
reçoit QUE le bloc à son nom. Écris ce nom EXACTEMENT comme le CONTEXTE DU TOUR
te le donne — c'est lui qui décide à qui vont les options. Une seule liste commune obligerait chacun à
chercher sa ligne parmi celles des autres. Une question ouverte adressée à
toute la table reste possible à la place — mais jamais un mélange des deux.

== RÉGIME DE TOUR ==
C'est TOI qui décides comment le tour se résout, parce que tu es le seul à
savoir quand une scène change de nature. Émets (hors narration, invisible) :
  <turn_mode value="simultaneous"/>
  <turn_mode value="sequential" order="Kaelen,Mira,Théa"/>
- simultaneous : régime par DÉFAUT — dialogue, exploration, enquête. Chacun
  propose son action, tu les résous ensemble.
- sequential : combat, poursuite, toute scène où l'ordre compte. Un seul
  joueur a la main à la fois, dans l'ordre que tu donnes. Donne cet ordre en
  entier, avec les noms exacts des personnages. Si l'initiative doit être
  tirée, demande d'abord les jets, puis fixe l'ordre au tour suivant.
N'émets cette balise QUE lorsque le régime change : au début d'un combat, et à
sa fin pour revenir en simultané. Pas à chaque tour.`;

/**
 * Bloc d'état volatile injecté en tête du message joueur ENVOYÉ au modèle
 * (jamais stocké dans l'historique : le préfixe des messages reste ainsi
 * identique d'une requête à l'autre et le cache de prompt tient, et les gros
 * extraits RAG ne sont facturés qu'une fois).
 */
export function buildTurnContext(
  state: GameState,
  opts: {
    /** Le roster de la table. Il voyage ICI, jamais dans le prompt système :
     * celui-ci est en cache ephemeral et doit rester identique à l'octet près,
     * or les joueurs vont et viennent. */
    characters?: TurnCharacter[];
    canonExcerpts?: string | null;
  } = {},
): string {
  const facts = state.facts.length
    ? state.facts.map((f) => `- ${f}`).join("\n")
    : "- (aucun pour l'instant)";

  const roster = opts.characters?.length
    ? opts.characters
    : Object.keys(state.characters ?? {}).map((key) => ({
        key,
        name: null,
        state: state.characters[key],
      }));

  // Le nom n'apparaît qu'à une table : en solo, il n'y a personne à
  // distinguer, et le contexte reste exactement celui d'avant le multi.
  const fiches = roster.length
    ? roster.map((c) => describeCharacter(c, roster.length > 1)).join("\n\n")
    : `Souffle : ${SOUFFLE_MAX}/${SOUFFLE_MAX}\nCompétences acquises (nom — palier) :\n- (aucune pour l'instant)`;

  const excerptsBlock = opts.canonExcerpts
    ? `
Extraits de la bible pertinents pour ce tour (bible volumineuse — si un détail
manque, reste prudent et cohérent avec le canon fourni au système) :
${opts.canonExcerpts}
`
    : "";

  return `[CONTEXTE DU TOUR — vérité serveur, invisible pour le joueur, ne jamais recopier]
${fiches}
Faits établis (jamais contredits) :
${facts}
${excerptsBlock}[FIN DU CONTEXTE]`;
}

/** Un personnage à la table, tel que le contexte de tour le décrit au MJ. */
export interface TurnCharacter {
  key: string;
  name: string | null;
  /** Fiche JSON, à une table seulement : en solo elle est déjà au système. */
  sheet?: string | null;
  state: CharacterState;
}

function describeCharacter(character: TurnCharacter, withName: boolean): string {
  const st = character.state ?? { souffle: SOUFFLE_MAX, skills: [] };
  const skills = (st.skills ?? []).length
    ? (st.skills ?? [])
        .map((s) => `- ${s.name} — ${s.tier}${s.note ? ` (${s.note})` : ""}`)
        .join("\n")
    : "- (aucune pour l'instant)";
  const entete = withName && character.name ? `${character.name} —\n` : "";
  // Sans fiche fournie (solo), la sortie reste identique à l'octet près.
  const fiche = character.sheet ? `Fiche : ${character.sheet}\n` : "";
  return `${entete}${fiche}Souffle : ${st.souffle}/${SOUFFLE_MAX}
Compétences acquises (nom — palier) :
${skills}`;
}

/** Roster prêt pour le contexte de tour, dans l'ordre donné. */
export function turnCharacters(
  state: GameState,
  members: Array<{
    characterId: string | null;
    name: string | null;
    sheet?: string | null;
  }>,
): TurnCharacter[] {
  return members.map((m) => ({
    key: stateKey(m.characterId),
    name: m.name,
    ...(m.sheet ? { sheet: m.sheet } : {}),
    state: characterState(state, m.characterId),
  }));
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

// ── Actes clos (lot 7.1) ──────────────────────────────────────────────────

/** Ce qu'un acte clos laisse au modèle : son résumé de contexte, rien d'autre. */
export interface ClosedActSummary {
  act_index: number;
  title: string | null;
  context_summary_md: string;
}

/**
 * Mémoire des actes clos, en UN SEUL bloc de texte placé en tête de
 * l'historique de l'acte courant.
 *
 * C'est ce bloc qui porte le point de cache : il ne change plus de toute la
 * durée de l'acte, donc le préfixe (système + résumés) reste identique à
 * l'octet près d'un tour à l'autre. C'est exactement ce que la fenêtre
 * glissante de 40 tours cassait — passé le 40e tour, le premier message de la
 * liste changeait à chaque tour et tout l'historique repassait plein tarif.
 *
 * Renvoie null quand aucun acte n'est clos : la session se comporte alors
 * exactement comme avant, sans bloc parasite dans les messages.
 */
export function buildActsBlock(acts: ClosedActSummary[]): string | null {
  const usable = acts
    .filter((a) => a.context_summary_md.trim() !== "")
    .sort((a, b) => a.act_index - b.act_index);
  if (usable.length === 0) return null;

  const body = usable
    .map((a) => {
      const title = a.title?.trim();
      return `## Acte ${a.act_index + 1}${title ? ` — ${title}` : ""}\n${a.context_summary_md.trim()}`;
    })
    .join("\n\n");

  return `[ACTES PRÉCÉDENTS — mémoire de la session, vérité serveur]
Ces actes se sont joués plus tôt dans CETTE partie. Leur narration détaillée
n'est plus dans l'historique : ces résumés en tiennent lieu et font foi. Ne les
contredis jamais, ne les recopie pas, n'y fais jamais référence comme à un
texte — pour le joueur, ce sont des souvenirs, pas des notes.

${body}
[FIN DES ACTES PRÉCÉDENTS]`;
}

// ── Résumé de contexte d'un acte (lot 7.2) ────────────────────────────────

/**
 * Plafond DUR du résumé de contexte, en caractères.
 *
 * C'est le seul texte de l'application qu'on paie éternellement : il est relu
 * à chaque tour de tous les actes suivants, jusqu'à la fin de la partie. Sans
 * plafond, il enfle acte après acte et réintroduit exactement le problème que
 * les actes devaient régler. ~2 000 caractères ≈ 500 tokens par acte.
 */
export const MAX_ACT_SUMMARY_CHARS = 2000;

/**
 * Applique le plafond au résumé d'un acte, en coupant à la dernière frontière
 * de phrase pour ne pas laisser une phrase tronquée dans le contexte du MJ.
 */
export function capActSummary(summary: string): string {
  const text = summary.trim();
  if (text.length <= MAX_ACT_SUMMARY_CHARS) return text;

  const head = text.slice(0, MAX_ACT_SUMMARY_CHARS);
  const cut = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf(".\n"),
    head.lastIndexOf("\n"),
  );
  return (cut > MAX_ACT_SUMMARY_CHARS / 2 ? head.slice(0, cut + 1) : head).trim();
}

/**
 * Clôture d'acte : résumé destiné au MODÈLE. Rien à voir avec le résumé de fin
 * de session (SUMMARY_MESSAGE), qui s'adresse au joueur et peut se permettre
 * d'être beau. Ici chaque mot est relu à chaque tour de tous les actes
 * suivants — la concision n'est pas une préférence de style, c'est le prix.
 *
 * Le résumé narré destiné au joueur est un objet séparé (lot 7.3).
 */
export const ACT_SUMMARY_MESSAGE = `Cet acte de la partie se termine. Produis sa FICHE DE MÉMOIRE pour la suite
de la session. Elle sera relue à chaque tour des actes suivants : chaque mot
compte, la concision prime sur tout le reste.

Format exact, rien d'autre :
- première ligne : \`# \` suivi d'un titre d'acte de 2 à 5 mots ;
- puis quatre sections, chacune en liste à puces télégraphiques :
  ## Personnages
  ## Faits établis
  ## Promesses ouvertes
  ## Relations

- Personnages : qui a été rencontré, en une poignée de mots par entrée (rôle,
  état actuel, où on l'a laissé). Les morts sont marqués comme tels.
- Faits établis : ce qui est vrai désormais et ne doit jamais être contredit.
- Promesses ouvertes : les fils lancés et non refermés — menaces, dettes,
  rendez-vous, mystères posés. C'est ce qui permet à la suite d'y revenir.
- Relations : où en est le personnage joueur avec chacun (confiance, dette,
  hostilité), en quelques mots.

Interdits : pas de prose, pas d'atmosphère, pas d'adjectifs de style, pas de
phrases complètes quand un fragment suffit, aucune redite entre sections.
Écris moins de 2 000 caractères. Réponds uniquement avec ce Markdown, sans
aucune balise.`;

// ── Résumé narré d'un acte (lot 7.3) ──────────────────────────────────────

/**
 * Récit d'un acte destiné au JOUEUR, à relire (ou écouter) entre deux
 * sessions. C'est l'exact opposé d'ACT_SUMMARY_MESSAGE, et les deux ne doivent
 * jamais être confondus :
 *
 *   contexte  → le modèle, à chaque tour, dense et télégraphique, payé à vie
 *   narré     → le joueur, une fois, de la prose, généré à la demande
 *
 * Un seul texte pour les deux usages donnerait soit un contexte bavard qui
 * coûte cher à chaque tour, soit un récit sec que personne ne veut relire.
 */
export const NARRATED_ACT_MESSAGE = `Cet acte de la partie est terminé. Raconte-le au joueur, comme on résume
l'épisode précédent avant de reprendre.

- À la troisième personne et au passé, dans ta voix de Maître de Jeu et le ton
  de cet univers.
- Une page, pas plus : ce qui s'est joué, ce qui a basculé, ce qui reste en
  suspens. Termine sur ce qui donne envie de reprendre.
- De la prose continue. Pas de listes, pas de titres, pas de sections, pas de
  méta (« dans cet acte », « le joueur »).
- N'invente rien qui ne se soit pas joué.
- Aucune balise : ce texte est lu tel quel, et peut être écouté à voix haute.

Réponds uniquement avec ce récit.`;

/**
 * Message de repli quand les tours d'origine ne sont plus disponibles : le
 * récit se fabrique alors depuis la seule fiche de mémoire de l'acte. C'est
 * moins riche, mais ça marche — et ça évite de garder les tours pour toujours.
 */
export function buildNarratedFromSummary(contextSummary: string): string {
  return `Voici la fiche de mémoire d'un acte de la partie, tout ce qu'il en reste :

${contextSummary}

${NARRATED_ACT_MESSAGE}`;
}


// ── Tour à plusieurs (M8 lot 8.5) ─────────────────────────────────────────

/** Une action soumise pour ce tour, telle qu'elle part au MJ. */
export interface SubmittedAction {
  characterName: string | null;
  text: string;
  /** Résultat de jet consommé par cette action, s'il y en a un. */
  rollLine?: string | null;
}

/**
 * Message utilisateur d'un tour de table : les actions de chacun, attribuées à
 * son personnage. Une seule narration en sortira, qui devra toutes les
 * référencer.
 *
 * Une action isolée retombe sur la forme mono-joueur, à l'octet près : le solo
 * ne doit pas voir son prompt changer parce que le multi existe.
 */
export function buildTableTurnMessage(actions: SubmittedAction[]): string {
  const usable = actions.filter((a) => a.text.trim() !== "" || a.rollLine);
  if (usable.length === 0) return "";
  if (usable.length === 1 && !usable[0].characterName) {
    const only = usable[0];
    return [only.rollLine, only.text.trim()].filter(Boolean).join("\n\n");
  }

  const lignes = usable.map((a) => {
    const nom = a.characterName ?? "Le personnage";
    const corps = a.text.trim() || "(aucune action déclarée)";
    return [a.rollLine, `${nom} : ${corps}`].filter(Boolean).join("\n");
  });

  return `== ACTIONS DU TOUR ==
${lignes.join("\n\n")}

Résous ces actions dans une seule narration, en donnant sa place à chacun.`;
}
