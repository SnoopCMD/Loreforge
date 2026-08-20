// Durable Object GameSession : un DO = une session de jeu (SPEC §2).
// Toute mutation d'état passe par lui ; D1 ne reçoit que les transitions
// de statut et le résumé final ; KV sert de cache chaud de l'état public.
//
// API interne (appelée uniquement par les routes worker, déjà authentifiées) :
//   POST /init    {sessionId, userId, bibleId, characterId, format, trame}
//   POST /trame   {trame}          → JSON {trame, setup_questions[]} (recentrées)
//   POST /setup   {answers[]}      → SSE (scène 1)
//   POST /turn    {player_input}   → SSE
//   POST /roll    {reason?}        → JSON RollResult (dés, dé retenu, issue)
//   GET  /state                    → JSON état public
//   POST /finish                   → JSON {summary_md, inventions}
//   POST /act/close                → JSON {act} (clôt l'acte courant, lot 7.1)
//   POST /act/narrate?index=N      → JSON {act} (récit pour le joueur, 7.3)
//   GET  /act/audio?index=N        → MP3 (récit lu, stocké en R2, 7.3)
//   GET  /ws                       → upgrade WebSocket (table partagée, 8.2)
//   POST /start                    → JSON {status} (l'hôte lance, lot 8.4)
//   POST /turn/resolve             → SSE (l'hôte force la résolution, 8.5)
//   POST /destroy                  → JSON {ok} (purge totale, session supprimée)

import { DurableObject } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { RichnessGap, RichnessScores } from "../richness/logic";
import {
  addFact,
  applySkillTiers,
  applySkillUpdate,
  applySouffleDelta,
  characterState,
  initialGameState,
  migrateGameState,
  mergeSkills,
  normalizeRollRequest,
  performRoll,
  sanitizeSkills,
  SOLO_STATE_KEY,
  SOUFFLE_MAX,
  stateKey,
  type CharacterState,
  type GameState,
  type RollRequest,
  type RollResult,
  type SkillEntry,
} from "./rules";
import { GmStreamParser, stripGmTags, type GmTagEvent } from "./tags";
import {
  buildFiche,
  buildLoreUserMessage,
  collectLoreSources,
  loreSignature,
  LORE_SYSTEM_PROMPT,
  normalizeKind,
  type LoreFiche,
} from "./lore";
import { retrieveCanonExcerpts } from "../rag/store";
import {
  actAudioKey,
  MAX_TTS_CHARS,
  synthesizeSpeech,
  ttsConfigured,
} from "../tts/cartesia";
import { loadMoodboardAnnex } from "../bibles/moodboard-context";
import {
  ACT_SUMMARY_MESSAGE,
  buildActsBlock,
  buildNarratedFromSummary,
  buildSetupMessage,
  buildTableTurnMessage,
  buildSystemPrompt,
  buildTurnContext,
  buildTurnMessage,
  capActSummary,
  gapQuestion,
  turnCharacters,
  NARRATED_ACT_MESSAGE,
  RELANCE_MESSAGE,
  selectSetupGaps,
  SUMMARY_MESSAGE,
  turnEndsOpen,
  type ClosedActSummary,
  type SetupContext,
  type SubmittedAction,
} from "./prompt";
import { canonizeGapAnswers, type GapAnswer } from "../richness/suggest";
import {
  applyRollAudit,
  buildRollAuditMessage,
  needsRollAudit,
  ROLL_AUDIT_SCHEMA,
  ROLL_AUDIT_SYSTEM_PROMPT,
  sheetTraits,
} from "./roll-audit";
import {
  buildRelevanceMessage,
  MAX_SCORED_GAPS,
  parseRelevance,
  RELEVANCE_OUTPUT_SCHEMA,
  RELEVANCE_SYSTEM_PROMPT,
  selectRelevantGaps,
} from "./setup-relevance";

export const NARRATION_MODEL = "claude-sonnet-5";
const MAX_NARRATION_TOKENS = 2048;
const MAX_PLAYER_INPUT_CHARS = 4000;
const MAX_ANSWERS = 10;
/** Fil rouge de session : une intention, pas un synopsis. */
export const MAX_TRAME_CHARS = 500;
// Fenêtre de contexte, en TOURS DE JEU. Attention au piège : le storage garde
// DEUX entrées par tour (la saisie du joueur, puis la narration du MJ). La
// fenêtre historique passait 40 à listTurns(), qui compte des entrées — elle
// valait donc 20 tours de jeu, pas 40. On l'exprime désormais dans l'unité que
// tout le reste du code manipule (act_turns, bornes de clôture), et les appels
// passent par CONTEXT_MESSAGES.
//
// Depuis le découpage en actes (lot 7.1), cette fenêtre ne glisse plus en
// pratique : la clôture forcée d'un acte intervient AVANT qu'on l'atteigne.
// Elle reste un plafond de sécurité.
const CONTEXT_TURNS = 40;
const CONTEXT_MESSAGES = CONTEXT_TURNS * 2;
// Bornes d'un acte, en tours de jeu (lot 7.2).
// Au-delà de ce seuil, une rupture de scène du MJ propose la clôture — on
// coupe sur une frontière narrative, pas au milieu d'une scène.
const ACT_SOFT_LIMIT = 20;
// Clôture FORCÉE, sans demander. Cette borne n'est pas un choix de rythme :
// elle existe pour ne jamais atteindre CONTEXT_TURNS (40). Au-delà, la fenêtre
// se met à glisser, le premier message change à chaque tour, le préfixe n'est
// plus identique et le cache d'historique décroche. 35 < 40, avec la marge
// qu'il faut pour qu'un tour en cours ne franchisse pas la limite.
const ACT_HARD_LIMIT = 35;
// Le résumé d'acte est court par construction (voir MAX_ACT_SUMMARY_CHARS).
const MAX_ACT_SUMMARY_TOKENS = 1024;
// Signe de vie pendant une clôture forcée, sous le timeout d'inactivité du
// client (20 s côté transport) : sans lui, le flux serait coupé en plein
// résumé et l'event de clôture n'arriverait jamais.
const ACT_CLOSING_HEARTBEAT_MS = 5000;
// Tour simultané : au-delà de ce délai sans que tout le monde ait soumis, on
// résout avec ce qu'on a. Un joueur parti chercher un café ne doit pas geler
// la table — et l'hôte peut toujours forcer avant.
const TURN_WAIT_MS = 90_000;
// Un verrou plus vieux que ça est réputé mort : le DO a pu être évincé en
// pleine génération, et une table gelée pour toujours est pire qu'un tour
// résolu deux fois. Large devant la durée d'une narration (quelques dizaines
// de secondes au pire).
const TURN_LOCK_TTL_MS = 3 * 60_000;
// Récit narré : une page de prose, plus généreux que la fiche de mémoire —
// il n'est ni relu à chaque tour ni facturé plus d'une fois.
const MAX_NARRATED_ACT_TOKENS = 1600;
// Prompt caching (coût) : le préfixe stable (system + historique) est mis en
// cache côté API ; TTL 1h car le rythme d'une partie dépasse souvent les 5 min
// entre deux tours. Relecture ≈ 0,1× le prix d'un token d'entrée.
const CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;
const LOG_TURNS = 20;
// Relance de fin de tour (§7) : court, sans retry (filet best-effort).
const MAX_RELANCE_TOKENS = 256;
// Cache des fiches lore rédigées (une semaine). L'entrée porte la signature
// des sources : elle est ignorée dès que la session en a dit plus sur le terme.
const LORE_TTL_SECONDS = 60 * 60 * 24 * 7;
// Fiche lore : 2-4 phrases, un appel court et non streamé.
export const LORE_MODEL = "claude-sonnet-5";
const MAX_LORE_TOKENS = 400;
// Tri des zones floues avant la mise en place : un verdict chiffré, pas de prose.
export const SETUP_RELEVANCE_MODEL = "claude-sonnet-5";
const MAX_RELEVANCE_TOKENS = 1500;
// Vérification des bonus de dés juste avant le jet : deux verdicts, pas plus.
export const ROLL_AUDIT_MODEL = "claude-sonnet-5";
const MAX_ROLL_AUDIT_TOKENS = 300;

export function sessionKvKey(sessionId: string): string {
  return `session:${sessionId}:state`;
}

export function loreKvPrefix(sessionId: string): string {
  return `lore:${sessionId}:`;
}

export function loreKvKey(sessionId: string, term: string): string {
  return loreKvPrefix(sessionId) + term.toLowerCase();
}

interface SessionMeta {
  sessionId: string;
  userId: string;
  bibleId: string;
  characterId: string | null;
  characterName: string | null;
  characterSheet: string | null;
  bibleTitle: string;
  toneProfile: string | null;
  /** Annexe des tableaux de références (§8), figée à l'init — le prompt
   * système doit rester identique à l'octet près pour le cache. */
  moodboardAnnex?: string;
  scores: RichnessScores | null;
  gaps: RichnessGap[];
  /** Retours d'auteur des sessions passées (contexte, SPEC §3) — plus récents d'abord. */
  authorFeedback: string[];
  format: string;
  trame: string | null;
  /**
   * "lobby" précède "setup" : les joueurs se retrouvent AVANT que la partie ne
   * démarre. Une session solo saute ce statut — son parcours ne change pas
   * d'un pas.
   */
  status: "lobby" | "setup" | "playing" | "finished";
  /** "solo" | "table" — pilote la politique de tour, l'UI et les permissions. */
  mode: string;
}

interface StoredTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Acte clos, tel que le DO le garde sous la main pour construire ses messages.
 * D1 (`session_acts`) en est la copie durable et requêtable ; ce doublon en
 * storage évite un aller-retour D1 à CHAQUE tour, sur le chemin le plus chaud
 * de l'application.
 */
type ClosedAct = ClosedActSummary;

/**
 * Qui agit sur ce tour. Le personnage compte autant que l'utilisateur : c'est
 * SON Souffle qui se dépense et SES compétences qui pèsent sur la poignée.
 */
interface Actor {
  userId: string | null;
  characterId: string | null;
}

/** Une action soumise, en attente de résolution. */
interface PendingAction {
  userId: string;
  characterId: string | null;
  text: string;
  at: number;
}

/** Régime de résolution en cours, fixé par le MJ via <turn_mode/>. */
interface TurnMode {
  value: "simultaneous" | "sequential";
  /** Noms de personnages, dans l'ordre de jeu (séquentiel uniquement). */
  order: string[];
}

/**
 * Ce qu'un socket sait de lui-même. Sérialisé sur le socket (et non gardé en
 * mémoire) pour survivre à l'hibernation du Durable Object.
 */
interface SocketInfo {
  userId: string;
  role: string;
  characterId: string | null;
}

/** Entrée de cache d'une fiche lore : la fiche + l'empreinte de ses sources. */
interface LoreCacheEntry {
  signature: string;
  fiche: LoreFiche & { bible_id: string };
}

interface Invention {
  axis: string;
  content: string;
  turn: number;
}

interface InitPayload {
  sessionId: string;
  userId: string;
  bibleId: string;
  characterId: string | null;
  format: string;
  trame: string | null;
  mode?: string;
}

/**
 * Deux noms de personnage désignent-ils la même personne ? Le MJ écrit l'ordre
 * de tour à la main : accents, casse et espaces ne doivent pas faire refuser
 * l'action d'un joueur dont c'est pourtant le tour.
 */
function sameName(a: string, b: string): boolean {
  const norme = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  return norme(a) === norme(b);
}

/** Corps JSON facultatif : `null` plutôt qu'une exception s'il est absent. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function turnKey(index: number): string {
  return `turn:${String(index).padStart(6, "0")}`;
}

/** Contexte de tri des zones floues : ce que la session a déjà de concret. */
function setupContext(meta: SessionMeta): SetupContext {
  return {
    trame: meta.trame,
    characterName: meta.characterName,
    characterSheet: meta.characterSheet,
  };
}

/**
 * Normalise un fil rouge reçu du client : null s'il est absent ou vide,
 * `undefined` si le type est invalide (l'appelant répond alors 400).
 */
export function normalizeTrame(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_TRAME_CHARS);
}

export class GameSession extends DurableObject<Env> {
  /** Cache mémoire du canon (relu depuis D1 à chaque réveil du DO). */
  private canonCache: string | null = null;

  /**
   * Synthèses vocales d'acte en cours, par index. Le DO traite une requête à
   * la fois mais l'appel Cartesia est un long await : deux clics rapprochés
   * s'y entrelaceraient et paieraient deux fois la même voix.
   */
  private audioInFlight = new Map<number, Promise<ArrayBuffer | null>>();

  /** Composition de la table, mémoïsée entre deux requêtes du même DO. */
  private rosterCache: Array<{
    characterId: string | null;
    name: string | null;
    /** Fiche du personnage (mode table uniquement, cf. roster()). */
    sheet?: string | null;
  }> | null = null;

  /**
   * Clôture d'acte en cours, s'il y en a une. Le DO ne sérialise PAS deux
   * requêtes qui s'attendent sur un long fetch : la clôture forcée de fin de
   * tour et un clic sur « Clore l'acte » s'entrelaceraient, paieraient deux
   * résumés, et le second INSERT violerait l'unicité (session_id, act_index).
   */
  private closeInFlight: Promise<Response> | null = null;

  /** Récits d'acte en cours, par index — deux onglets ouverts, un seul appel. */
  private narrateInFlight = new Map<number, Promise<Response>>();

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/init") {
        return await this.init((await request.json()) as InitPayload);
      }
      if (request.method === "GET" && path === "/state") {
        return await this.stateResponse();
      }
      if (request.method === "POST" && path === "/destroy") {
        // Suppression de session : le DO se vide entièrement (un DO sans
        // storage n'occupe plus rien ; son id ne sera jamais réémis).
        await this.ctx.storage.deleteAll();
        this.canonCache = null;
        return json({ ok: true });
      }

      const meta = await this.ctx.storage.get<SessionMeta>("meta");
      if (!meta) return json({ error: "session_not_initialized" }, 409);

      // Qui agit, et avec quel personnage. Posé par le Worker après
      // vérification du cookie ET de l'appartenance ; jamais lu depuis le
      // corps de la requête.
      const actor: Actor = {
        userId: request.headers.get("x-lf-user-id"),
        characterId: request.headers.get("x-lf-character-id") || null,
      };

      if (request.method === "GET" && path === "/lore") {
        return await this.lore(meta, new URL(request.url));
      }
      if (request.method === "POST" && path === "/trame") {
        return await this.setTrame(meta, await request.json());
      }
      if (request.method === "POST" && path === "/setup") {
        return await this.setup(meta, await request.json(), actor);
      }
      if (request.method === "POST" && path === "/turn") {
        return await this.turn(meta, await request.json(), actor);
      }
      if (request.method === "POST" && path === "/roll") {
        // Un jet demandé par le MJ n'a rien à transmettre : le corps est
        // facultatif, et une requête sans corps ne doit pas rendre un 500.
        return await this.roll(meta, await readJson(request), actor);
      }
      if (request.method === "POST" && path === "/finish") {
        return await this.finish(meta);
      }
      if (request.method === "POST" && path === "/act/close") {
        return await this.closeAct(meta);
      }
      if (request.method === "POST" && path === "/act/narrate") {
        return await this.narrateAct(meta, new URL(request.url));
      }
      if (request.method === "GET" && path === "/act/audio") {
        return await this.actAudio(meta, new URL(request.url));
      }
      if (request.method === "GET" && path === "/ws") {
        return await this.acceptSocket(meta, request);
      }
      if (request.method === "POST" && path === "/start") {
        return await this.start(meta);
      }
      if (request.method === "POST" && path === "/seat") {
        return await this.seat(meta, await readJson(request));
      }
      if (request.method === "POST" && path === "/turn/resolve") {
        return await this.forceResolve(meta);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error(`[game-session] ${path} :`, err);
      return json({ error: "internal_error" }, 500);
    }
  }

  // ── Initialisation ────────────────────────────────────────────────────

  private async init(payload: InitPayload): Promise<Response> {
    const existing = await this.ctx.storage.get<SessionMeta>("meta");
    if (existing) {
      const questions =
        (await this.ctx.storage.get<string[]>("setup_questions")) ?? [];
      return json({ setup_questions: questions });
    }

    const bible = await this.env.DB.prepare(
      `SELECT title, canon_md, tone_profile FROM bibles WHERE id = ?`,
    )
      .bind(payload.bibleId)
      .first<{
        title: string;
        canon_md: string | null;
        tone_profile: string | null;
      }>();
    if (!bible?.canon_md) return json({ error: "bible_not_ready" }, 400);

    const richness = await this.env.DB.prepare(
      `SELECT cosmology, characters, plots, tone, geography, gaps_json
       FROM richness_scores WHERE bible_id = ?`,
    )
      .bind(payload.bibleId)
      .first<RichnessScores & { gaps_json: string }>();
    const scores: RichnessScores | null = richness
      ? {
          cosmology: richness.cosmology,
          characters: richness.characters,
          plots: richness.plots,
          tone: richness.tone,
          geography: richness.geography,
        }
      : null;
    const gaps: RichnessGap[] = richness
      ? (JSON.parse(richness.gaps_json) as RichnessGap[])
      : [];

    // Retours d'auteur des sessions terminées de cette bible : contexte pour
    // le MJ (les 3 plus récents), relus au prompt (SPEC §3).
    const feedbackRows = await this.env.DB.prepare(
      `SELECT author_feedback FROM game_sessions
       WHERE bible_id = ? AND author_feedback IS NOT NULL AND author_feedback != ''
       ORDER BY finished_at DESC LIMIT 3`,
    )
      .bind(payload.bibleId)
      .all<{ author_feedback: string }>();
    const authorFeedback = feedbackRows.results.map((r) => r.author_feedback);

    let characterName: string | null = null;
    let characterSheet: string | null = null;
    let characterSkills: SkillEntry[] = [];
    if (payload.characterId) {
      const character = await this.env.DB.prepare(
        `SELECT name, sheet_json, skills_json FROM characters WHERE id = ?`,
      )
        .bind(payload.characterId)
        .first<{ name: string; sheet_json: string; skills_json: string | null }>();
      if (!character) return json({ error: "character_not_found" }, 400);
      characterName = character.name;
      characterSheet = character.sheet_json;
      // Arbre de compétences persistant : les acquis des sessions passées
      // repartent avec le personnage (le MJ ne les « redécouvre » jamais).
      try {
        characterSkills = sanitizeSkills(
          JSON.parse(character.skills_json ?? "[]"),
        );
      } catch {
        characterSkills = [];
      }
    }

    // Zones floues déjà traitées : une réponse d'une session passée en attente
    // de validation (pending) ou déjà canonisée (accepted) ne redéclenche pas
    // la même question. Une réponse rejetée, elle, rouvre la question.
    const settledRows = await this.env.DB.prepare(
      `SELECT source_comment FROM canon_proposals
       WHERE bible_id = ? AND source = 'gap'
         AND status IN ('pending', 'accepted') AND source_comment IS NOT NULL`,
    )
      .bind(payload.bibleId)
      .all<{ source_comment: string }>();
    const settledGaps = new Set(
      settledRows.results.map((r) => r.source_comment),
    );
    const openGaps = gaps.filter((g) => !settledGaps.has(g.description));

    const meta: SessionMeta = {
      sessionId: payload.sessionId,
      userId: payload.userId,
      bibleId: payload.bibleId,
      characterId: payload.characterId,
      characterName,
      characterSheet,
      bibleTitle: bible.title,
      toneProfile: bible.tone_profile,
      moodboardAnnex: await loadMoodboardAnnex(this.env.DB, payload.bibleId),
      scores,
      gaps,
      authorFeedback,
      format: payload.format,
      trame: payload.trame,
      // Une table naît en lobby ; le solo démarre directement sa mise en place.
      status: payload.mode === "table" ? "lobby" : "setup",
      mode: payload.mode === "table" ? "table" : "solo",
    };
    const state = initialGameState(payload.characterId);
    // Arbre de compétences persistant : les acquis repartent avec LE
    // personnage, pas avec la session.
    characterState(state, payload.characterId).skills = characterSkills;

    // Un lobby ne doit RIEN coûter : tant que l'hôte n'a pas lancé, aucun
    // appel au modèle n'est fait. Le tri des zones floues attend /start —
    // sinon on paierait la mise en place de parties qui ne commenceront
    // jamais, et on la paierait avant même que les joueurs soient arrivés.
    const setupGaps =
      meta.status === "lobby" ? [] : await this.pickSetupGaps(meta, openGaps);
    const questions = setupGaps.map(gapQuestion);

    this.canonCache = bible.canon_md;
    await this.ctx.storage.put({
      meta,
      state,
      setup_questions: questions,
      setup_gaps: setupGaps,
      // Réserve de lacunes ouvertes : le fil rouge posé à la mise en place
      // rejoue la sélection dessus, sans repasser par D1.
      open_gaps: openGaps,
      inventions: [] as Invention[],
      turn_count_stored: 0,
      // Bornes d'acte (lot 7.1) : la session naît sur l'acte 0, dont la
      // fenêtre part du tout premier tour stocké.
      act_index: 0,
      act_start_index: 0,
      closed_acts: [] as ClosedAct[],
    });
    await this.syncKV(meta, state);

    return json({ setup_questions: questions });
  }

  // ── Lancement de la partie (lot 8.4) ──────────────────────────────────

  /**
   * L'hôte lance (ou relance) la table. Trois cas, un seul geste :
   * - depuis le lobby : c'est ICI que le tri des zones floues a lieu, donc le
   *   premier appel au modèle de toute la session ;
   * - depuis une partie en cours : rien à calculer, on rassemble simplement
   *   la table autour de l'écran de jeu ;
   * - une fois terminée : il n'y a plus rien à lancer.
   */
  private async start(meta: SessionMeta): Promise<Response> {
    // Les fiches ont pu être choisies depuis le dernier tour joué.
    this.forgetRoster();
    if (meta.status === "finished") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }

    if (meta.status === "lobby") {
      const openGaps =
        (await this.ctx.storage.get<RichnessGap[]>("open_gaps")) ?? [];
      const setupGaps = await this.pickSetupGaps(meta, openGaps);
      const questions = setupGaps.map(gapQuestion);
      meta.status = "setup";
      await this.ctx.storage.put({
        meta,
        setup_gaps: setupGaps,
        setup_questions: questions,
      });
      await this.env.DB.prepare(
        `UPDATE game_sessions SET status = 'setup' WHERE id = ?`,
      )
        .bind(meta.sessionId)
        .run();
      await this.syncKV(meta, await this.loadState(meta));
      this.broadcast("session_started", {
        status: meta.status,
        setup_questions: questions,
      });
      return json({ status: meta.status, setup_questions: questions });
    }

    // Reprise : la table se rassemble, rien ne change côté serveur.
    this.broadcast("session_started", { status: meta.status });
    const questions =
      (await this.ctx.storage.get<string[]>("setup_questions")) ?? [];
    return json({ status: meta.status, setup_questions: questions });
  }

  // ── Prise de place (lot 8.6) ──────────────────────────────────────────

  /**
   * Un joueur vient de choisir son personnage. Le Worker a déjà écrit la ligne
   * de membre ; le moteur, lui, l'ignorait jusqu'ici — une table naît dans son
   * lobby, AVANT que quiconque soit assis, et le prompt partait donc avec
   * « pas de fiche de personnage » pendant que les joueurs venaient d'écrire
   * les leurs.
   */
  private async seat(meta: SessionMeta, body: unknown): Promise<Response> {
    const { userId, characterId } = (body ?? {}) as {
      userId?: unknown;
      characterId?: unknown;
    };
    if (typeof userId !== "string" || typeof characterId !== "string") {
      return json({ error: "invalid_seat" }, 400);
    }

    // La composition de la table vient de changer.
    this.forgetRoster();

    const character = await this.env.DB.prepare(
      `SELECT name, sheet_json, skills_json FROM characters WHERE id = ?`,
    )
      .bind(characterId)
      .first<{ name: string; sheet_json: string; skills_json: string | null }>();
    if (!character) return json({ error: "character_not_found" }, 404);

    const state = await this.loadState(meta);
    // Amorçage à la PREMIÈRE assise seulement — testé AVANT characterState(),
    // qui créerait l'entrée au passage. Ensuite, l'état de la session en cours
    // fait foi : le recharger effacerait ce qui vient d'être gagné.
    const premiere = !state.characters?.[stateKey(characterId)];
    const cs = characterState(state, characterId);
    if (premiere) {
      try {
        cs.skills = sanitizeSkills(JSON.parse(character.skills_json ?? "[]"));
      } catch {
        cs.skills = [];
      }
    }

    // En SOLO uniquement, la fiche du prompt système suit le changement :
    // changer de personnage avant la scène 1 doit s'y refléter, sinon le MJ
    // narre pour celui qu'on vient d'abandonner. À une table, les fiches
    // voyagent dans [CONTEXTE DU TOUR] — le prompt système, lui, est en cache
    // ephemeral et doit rester identique à l'octet près.
    if ((meta.mode ?? "solo") !== "table") {
      meta.characterId = characterId;
      meta.characterName = character.name;
      meta.characterSheet = character.sheet_json;
    }

    await this.ctx.storage.put({ meta, state });
    await this.syncKV(meta, state);
    this.broadcast("member_seated", {
      user_id: userId,
      character_id: characterId,
      character_name: character.name,
    });

    return json({ ok: true });
  }

  // ── Fil rouge → questions recentrées ──────────────────────────────────

  /**
   * Le joueur pose (ou retire) son fil rouge avant la scène 1 : la mise en
   * place rejoue sa sélection de zones floues à la lumière de cette intention,
   * pour ne poser que des questions qui concernent la partie qui commence.
   */
  private async setTrame(meta: SessionMeta, body: unknown): Promise<Response> {
    if (meta.status !== "setup") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const trame = normalizeTrame((body as { trame?: unknown }).trame);
    if (trame === undefined) return json({ error: "invalid_trame" }, 400);

    meta.trame = trame;
    const openGaps =
      (await this.ctx.storage.get<RichnessGap[]>("open_gaps")) ??
      (await this.ctx.storage.get<RichnessGap[]>("setup_gaps")) ??
      [];
    const setupGaps = await this.pickSetupGaps(meta, openGaps);
    const questions = setupGaps.map(gapQuestion);

    await this.ctx.storage.put({
      meta,
      setup_gaps: setupGaps,
      setup_questions: questions,
    });
    await this.env.DB.prepare(`UPDATE game_sessions SET trame = ? WHERE id = ?`)
      .bind(trame, meta.sessionId)
      .run();
    // Le cache chaud porte la trame : sans ce resync, /state la servirait
    // encore vide après un refresh.
    await this.syncKV(meta, await this.loadState(meta));

    return json({ trame, setup_questions: questions });
  }

  // ── Mise en place → scène 1 ───────────────────────────────────────────

  private async setup(
    meta: SessionMeta,
    body: unknown,
    actor: Actor = { userId: null, characterId: null },
  ): Promise<Response> {
    if (meta.status !== "setup") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const answers = (body as { answers?: unknown }).answers;
    if (
      !Array.isArray(answers) ||
      answers.length > MAX_ANSWERS ||
      answers.some(
        (a) => typeof a !== "string" || a.length > MAX_PLAYER_INPUT_CHARS,
      )
    ) {
      return json({ error: "invalid_answers" }, 400);
    }

    // Le fil rouge, lui, est déjà posé : POST /trame l'a écrit et a recentré
    // les questions ci-dessous. Ici on ne traite que les réponses.
    const questions =
      (await this.ctx.storage.get<string[]>("setup_questions")) ?? [];
    const state = await this.loadState(meta);

    // Les réponses deviennent des faits établis de la session (en mémoire :
    // elles ne sont persistées qu'au succès de la scène 1, voir becomePlaying).
    questions.forEach((q, i) => {
      const answer = (answers[i] as string | undefined)?.trim();
      if (answer) state.facts.push(`${q} → ${answer}`);
    });

    // Chaque réponse est aussi reliée à sa zone floue d'origine : au /finish,
    // elle deviendra une proposition de canon (source 'gap') à valider —
    // acceptée, la lacune sort de gaps_json et la question ne revient plus.
    const setupGaps =
      (await this.ctx.storage.get<RichnessGap[]>("setup_gaps")) ?? [];
    const gapAnswers: GapAnswer[] = [];
    setupGaps.forEach((gap, i) => {
      const answer = (answers[i] as string | undefined)?.trim();
      if (answer) {
        gapAnswers.push({
          axis: gap.axis,
          description: gap.description,
          answer,
        });
      }
    });
    await this.ctx.storage.put("gap_answers", gapAnswers);

    // Le passage en 'playing' n'est commité qu'à la fin de la génération : une
    // scène 1 interrompue laisse la session en 'setup', donc rejouable via
    // POST /setup (le dernier état validé reste l'avant-setup, §résilience).
    const stored = buildSetupMessage(questions, answers);
    return this.generate(
      meta,
      state,
      { stored, sent: await this.withTurnContext(meta, state, stored) },
      null,
      { becomePlaying: true, actor },
    );
  }

  // ── Tour de jeu ───────────────────────────────────────────────────────

  private async turn(
    meta: SessionMeta,
    body: unknown,
    actor: Actor = { userId: null, characterId: null },
  ): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const input = (body as { player_input?: unknown }).player_input;
    if (typeof input !== "string" || input.length > MAX_PLAYER_INPUT_CHARS) {
      return json({ error: "invalid_player_input" }, 400);
    }

    const sansFiche = this.seated(meta, actor);
    if (sansFiche) return sansFiche;

    // Le jet en attente est CELUI DU JOUEUR qui agit : à une table, un autre
    // peut avoir le sien en suspens sans bloquer qui que ce soit.
    const { state, me } = await this.actorState(meta, actor);
    if (me.pending_roll) {
      const request = normalizeRollRequest(me.pending_roll);
      return json(
        { error: "roll_required", request, reason: request.reason },
        409,
      );
    }

    // Une saisie vide n'est valide que pour le tour de continuation post-jet,
    // où le MJ reprend la narration là où il l'avait suspendue.
    if (input.trim() === "" && !me.last_roll) {
      return json({ error: "invalid_player_input" }, 400);
    }

    // ── Solo : résolution immédiate, aucun détour ────────────────────────
    //
    // Le verrou et la file existent pour une table. En solo ils doivent être
    // un no-op OBSERVABLE : pas un aller-retour de storage de plus, pas une
    // milliseconde de latence ajoutée. C'est le parcours quotidien, celui
    // qu'on régresserait sans le voir.
    if ((meta.mode ?? "solo") !== "table") {
      return this.resolveNow(meta, state, [
        { userId: actor.userId ?? "", characterId: actor.characterId, text: input, at: 0 },
      ], actor);
    }

    const mode = await this.turnMode();
    const roster = await this.roster(meta);

    // ── Séquentiel : un seul joueur a la main ────────────────────────────
    //
    // Une action hors tour est REFUSÉE, jamais mise en file : la jouer plus
    // tard la sortirait de son contexte, et le joueur croirait l'avoir perdue.
    if (mode.value === "sequential") {
      const attendu = await this.expectedPlayer(mode, roster);
      const monNom = roster.find(
        (r) => stateKey(r.characterId) === stateKey(actor.characterId),
      )?.name;
      if (attendu && monNom && !sameName(attendu, monNom)) {
        return json(
          { error: "not_your_turn", awaiting: attendu, order: mode.order },
          409,
        );
      }
      return this.submitAndMaybeResolve(meta, actor, input, { resolveNow: true });
    }

    // ── Simultané : on attend que tout le monde ait soumis ───────────────
    return this.submitAndMaybeResolve(meta, actor, input, { resolveNow: false });
  }

  /**
   * Enregistre l'action et décide si le tour part maintenant.
   *
   * Le verrou est explicite et persisté : on ne se repose PAS sur le modèle
   * mono-requête du Durable Object. turn() est un long await sur le streaming
   * Anthropic — pendant ce temps la porte reste ouverte et deux requêtes
   * s'entrelacent. Sans verrou, deux joueurs qui postent en même temps
   * produiraient deux générations concurrentes.
   */
  private async submitAndMaybeResolve(
    meta: SessionMeta,
    actor: Actor,
    input: string,
    opts: { resolveNow: boolean },
  ): Promise<Response> {
    const pending =
      (await this.ctx.storage.get<PendingAction[]>("pending_actions")) ?? [];
    // Une nouvelle action du même joueur remplace la précédente : tant que le
    // tour n'est pas parti, il a le droit de changer d'avis.
    const actions = pending.filter((a) => a.userId !== actor.userId);
    actions.push({
      userId: actor.userId ?? "",
      characterId: actor.characterId,
      text: input,
      at: Date.now(),
    });
    await this.ctx.storage.put("pending_actions", actions);
    // Le snapshot chaud dit qui a soumis : il ment dès qu'une action arrive.
    // On le purge plutôt que de le réécrire — la prochaine lecture repassera
    // par le DO, qui le repeuplera.
    await this.env.CACHE.delete(sessionKvKey(meta.sessionId));

    if (await this.lockHeld()) {
      // Une narration est en cours : l'action attend le tour suivant. Elle
      // n'est jamais perdue, et c'est tout ce qu'on promet au joueur.
      this.broadcast("turn_waiting", {
        submitted: actions.map((a) => stateKey(a.characterId)),
        queued: true,
      });
      return json({ status: "queued", submitted: actions.length }, 202);
    }

    if (!opts.resolveNow && !(await this.everyoneSubmitted(meta, actions))) {
      this.broadcast("turn_waiting", {
        submitted: actions.map((a) => stateKey(a.characterId)),
        queued: false,
      });
      // Filet : si quelqu'un ne revient pas, le tour part quand même.
      await this.ctx.storage.setAlarm(Date.now() + TURN_WAIT_MS);
      return json({ status: "waiting", submitted: actions.length }, 202);
    }

    return this.resolveTurn(meta, actor);
  }

  /**
   * Tous les joueurs attendus ont-ils soumis ?
   *
   * La présence WebSocket fait foi : un joueur déconnecté ne doit pas geler la
   * table. Mais tant qu'AUCUN socket n'est ouvert, on n'a aucune information
   * de présence — on retombe alors sur la liste des membres, sinon la première
   * action résoudrait le tour toute seule et les autres n'agiraient jamais.
   * Le délai et le forçage de l'hôte restent là pour débloquer.
   */
  private async everyoneSubmitted(
    meta: SessionMeta,
    actions: PendingAction[],
  ): Promise<boolean> {
    let attendus = new Set(this.presence().map((p) => p.user_id));
    if (attendus.size === 0) {
      const { results } = await this.env.DB.prepare(
        `SELECT user_id FROM session_members WHERE session_id = ?`,
      )
        .bind(meta.sessionId)
        .all<{ user_id: string }>();
      attendus = new Set(results.map((r) => r.user_id));
    }
    const soumis = new Set(actions.map((a) => a.userId));
    for (const userId of attendus) {
      if (!soumis.has(userId)) return false;
    }
    return true;
  }

  /**
   * Prochain joueur attendu en séquentiel.
   *
   * L'index avance à chaque tour résolu : sans ça, l'ordre donné par le MJ ne
   * tournerait jamais et seul le premier nommé pourrait agir — le combat
   * resterait bloqué sur lui, puisque le prompt demande explicitement au MJ de
   * ne pas réémettre la balise à chaque tour.
   *
   * Un nom qui ne correspond à personne à la table est sauté : un ordre mal
   * orthographié ne doit pas geler la partie.
   */
  private async expectedPlayer(
    mode: TurnMode,
    roster: Array<{ characterId: string | null; name: string | null }>,
  ): Promise<string | null> {
    if (mode.order.length === 0) return null;
    const start = (await this.ctx.storage.get<number>("turn_order_index")) ?? 0;
    for (let i = 0; i < mode.order.length; i++) {
      const nom = mode.order[(start + i) % mode.order.length];
      if (roster.some((r) => r.name && sameName(r.name, nom))) return nom;
    }
    return null;
  }

  /** Passe la main au suivant dans l'ordre, et le dit à la table. */
  private async advanceTurnOrder(meta: SessionMeta): Promise<void> {
    const mode = await this.turnMode();
    if (mode.value !== "sequential" || mode.order.length === 0) return;
    const index = (await this.ctx.storage.get<number>("turn_order_index")) ?? 0;
    await this.ctx.storage.put(
      "turn_order_index",
      (index + 1) % mode.order.length,
    );
    const suivant = await this.expectedPlayer(mode, await this.roster(meta));
    if (suivant) this.broadcast("awaiting_player", { name: suivant });
  }

  /** L'hôte force la résolution sans attendre les retardataires. */
  private async forceResolve(meta: SessionMeta): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const actions =
      (await this.ctx.storage.get<PendingAction[]>("pending_actions")) ?? [];
    if (actions.length === 0) return json({ error: "no_pending_action" }, 409);
    if (await this.lockHeld()) return json({ error: "turn_locked" }, 409);
    return this.resolveTurn(meta, { userId: null, characterId: null });
  }

  /**
   * Résout le tour : prend les actions en attente, pose le verrou, génère UNE
   * narration. Le verrou est levé par pump(), au succès comme à l'échec.
   */
  private async resolveTurn(meta: SessionMeta, actor: Actor): Promise<Response> {
    const actions =
      (await this.ctx.storage.get<PendingAction[]>("pending_actions")) ?? [];
    if (actions.length === 0) return json({ error: "no_pending_action" }, 409);

    await this.ctx.storage.put({ turn_lock: Date.now(), pending_actions: [] });
    await this.ctx.storage.deleteAlarm();
    this.broadcast("turn_locked", {
      characters: actions.map((a) => stateKey(a.characterId)),
    });

    // Entre la pose du verrou et pump() — qui seul sait le lever — il y a des
    // lectures D1 et une clé d'API qui peut manquer. Toute sortie par ce
    // chemin doit rendre le verrou, sinon la table est gelée.
    try {
      const state = await this.loadState(meta);
      const res = await this.resolveNow(meta, state, actions, actor);
      if (!res.ok) await this.releaseLock();
      return res;
    } catch (err) {
      await this.releaseLock();
      throw err;
    }
  }

  /**
   * Assemble les actions en un seul message et lance la génération. Chemin
   * commun au solo (une action, aucun verrou) et à la table.
   */
  private async resolveNow(
    meta: SessionMeta,
    state: GameState,
    actions: PendingAction[],
    actor: Actor,
  ): Promise<Response> {
    const roster = await this.roster(meta);
    const nomDe = (characterId: string | null): string | null =>
      roster.find((r) => stateKey(r.characterId) === stateKey(characterId))
        ?.name ?? null;

    const submitted: SubmittedAction[] = [];
    const consumed: RollResult[] = [];
    for (const action of actions) {
      const cs = characterState(state, action.characterId ?? meta.characterId);
      const roll = cs.last_roll;
      if (roll) {
        cs.last_roll = null;
        consumed.push(roll);
      }
      submitted.push({
        // À une table, l'action est TOUJOURS nommée — y compris seule, en
        // tour par tour : sans nom, le MJ ne sait pas qui frappe. En solo il
        // n'y a personne à distinguer, et le message reste celui d'avant le
        // multi à l'octet près.
        characterName:
          (meta.mode ?? "solo") === "table" ? nomDe(action.characterId) : null,
        text: action.text.trim(),
        rollLine: roll ? buildTurnMessage("", roll) : null,
      });
    }

    const stored = buildTableTurnMessage(submitted);
    if (stored === "") {
      await this.releaseLock();
      return json({ error: "invalid_player_input" }, 400);
    }

    return this.generate(
      meta,
      state,
      { stored, sent: await this.withTurnContext(meta, state, stored) },
      consumed[0] ?? null,
      {
        actor,
        actingCharacters: actions.map((a) => ({
          key: stateKey(a.characterId ?? meta.characterId),
          name: nomDe(a.characterId),
        })),
      },
    );
  }

  /** Lève le verrou de tour. Idempotent : appelé sur tous les chemins de fin. */
  private async releaseLock(): Promise<void> {
    await this.ctx.storage.delete("turn_lock");
  }

  /**
   * Une narration est-elle réellement en cours ? Un verrou périmé est purgé et
   * ne compte pas : sinon une génération interrompue (DO évincé, erreur avant
   * pump) gèlerait la table définitivement, sans aucun recours.
   */
  private async lockHeld(): Promise<boolean> {
    const posed = await this.ctx.storage.get<number>("turn_lock");
    if (!posed) return false;
    if (Date.now() - posed < TURN_LOCK_TTL_MS) return true;
    console.error("[game-session] verrou de tour périmé, purgé");
    await this.releaseLock();
    return false;
  }

  /**
   * Filet du régime simultané : le délai a expiré, on résout avec ce qu'on a.
   * Personne ne tient de flux SSE ici — la table reçoit tout par WebSocket.
   */
  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<SessionMeta>("meta");
    if (!meta || meta.status !== "playing") return;
    const actions =
      (await this.ctx.storage.get<PendingAction[]>("pending_actions")) ?? [];
    if (actions.length === 0) return;
    if (await this.lockHeld()) {
      // Une narration est en cours : on repasse plus tard plutôt que
      // d'abandonner ces actions à un réveil qui n'aura jamais lieu.
      await this.ctx.storage.setAlarm(Date.now() + TURN_WAIT_MS);
      return;
    }

    const res = await this.resolveTurn(meta, { userId: null, characterId: null });
    // Le flux n'a pas de lecteur : on le draine pour que la génération aille
    // jusqu'au bout et que le verrou soit bien levé.
    void res.body?.pipeTo(new WritableStream());
  }

  /** Régime de tour courant ; simultané tant que le MJ n'a rien dit. */
  private async turnMode(): Promise<TurnMode> {
    return (
      (await this.ctx.storage.get<TurnMode>("turn_mode")) ?? {
        value: "simultaneous",
        order: [],
      }
    );
  }

  // ── Jet de d6 serveur ─────────────────────────────────────────────────

  private async roll(
    meta: SessionMeta,
    body: unknown,
    actor: Actor = { userId: null, characterId: null },
  ): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const sansFiche = this.seated(meta, actor);
    if (sansFiche) return sansFiche;

    const { state, me, key } = await this.actorState(meta, actor);
    if (me.last_roll) {
      // Anti-triche : pas de relance tant que le résultat n'est pas joué.
      return json({ error: "roll_already_pending" }, 409);
    }

    // Les conditions du jet viennent du MJ (état serveur) : le client ne peut
    // pas se choisir une difficulté ni un avantage. Sa `reason` ne sert que
    // pour un jet libre, hors demande du MJ.
    const bodyReason = (body as { reason?: unknown } | null)?.reason;
    const request: RollRequest = me.pending_roll
      ? normalizeRollRequest(me.pending_roll)
      : normalizeRollRequest(
          typeof bodyReason === "string" ? bodyReason : null,
        );

    // Deux passes avant les dés : le palier des compétences engagées (calcul
    // pur, la liste des acquis fait foi), puis la vérification des bonus de
    // fiche que le MJ aurait oubliés.
    // La poignée se calcule sur SA fiche et SES compétences.
    const withTiers = applySkillTiers(request, me.skills);
    const result = performRoll(await this.auditedRoll(meta, withTiers));
    me.last_roll = result;
    me.pending_roll = null;

    await this.ctx.storage.put("state", state);
    await this.syncKV(meta, state);
    // Un jet se regarde à plusieurs : le lanceur reçoit le résultat dans sa
    // réponse, la table le voit tomber en direct — avec le personnage
    // concerné, pour que chaque client ne mette à jour que la bonne fiche.
    this.broadcast(
      "roll",
      { ...result, character_id: key },
      { excludeUser: actor.userId },
    );
    return json(result);
  }

  /**
   * Garde-fou : le barème du prompt s'applique de façon intermittente. Si un
   * bonus de fiche manque alors qu'il pourrait être dû, un appel court tranche
   * avant que les dés ne tombent. Il ne peut qu'AJOUTER des dés ; en cas
   * d'échec, on lance la poignée telle que le MJ l'a demandée.
   */
  private async auditedRoll(
    meta: SessionMeta,
    request: RollRequest,
  ): Promise<RollRequest> {
    const traits = sheetTraits(meta.characterSheet);
    if (!needsRollAudit(request, traits)) return request;

    try {
      const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create(
        {
          model: ROLL_AUDIT_MODEL,
          max_tokens: MAX_ROLL_AUDIT_TOKENS,
          system: ROLL_AUDIT_SYSTEM_PROMPT,
          output_config: {
            format: { type: "json_schema", schema: ROLL_AUDIT_SCHEMA },
          },
          messages: [
            {
              role: "user",
              content: buildRollAuditMessage({
                reason: request.reason,
                skills: request.skills,
                traits,
              }),
            },
          ],
        },
        { maxRetries: 0 },
      );
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return applyRollAudit(request, JSON.parse(text), traits);
    } catch (err) {
      console.error(`[game-session] audit du jet ${meta.sessionId} :`, err);
      return request;
    }
  }

  // ── État public ───────────────────────────────────────────────────────

  private async stateResponse(): Promise<Response> {
    const meta = await this.ctx.storage.get<SessionMeta>("meta");
    if (!meta) return json({ error: "session_not_initialized" }, 409);
    const state = await this.loadState(meta);
    const snapshot = await this.publicState(meta, state);
    if (meta.status !== "finished") {
      await this.env.CACHE.put(
        sessionKvKey(meta.sessionId),
        JSON.stringify(snapshot),
      );
    }
    return json(snapshot);
  }

  private async publicState(
    meta: SessionMeta,
    state: GameState,
  ): Promise<Record<string, unknown>> {
    // Le journal affiché n'est PAS borné à l'acte : le joueur qui recharge en
    // début d'acte doit garder la continuité de ce qu'il vient de vivre. Seul
    // le contexte envoyé au modèle est borné (listTurns).
    const log = await this.listAllTurns(undefined, LOG_TURNS);
    const actIndex = (await this.ctx.storage.get<number>("act_index")) ?? 0;
    const actStart = await this.actStartIndex();
    const stored =
      (await this.ctx.storage.get<number>("turn_count_stored")) ?? 0;
    const actTurns = Math.max(0, Math.floor((stored - actStart) / 2));
    const principal = characterState(state, meta.characterId);
    return {
      session_id: meta.sessionId,
      status: meta.status,
      mode: meta.mode ?? "solo",
      // Le front en a besoin dès le lobby, pour proposer les personnages de
      // cet univers sans un aller-retour de plus.
      bible_id: meta.bibleId,
      format: meta.format,
      trame: meta.trame,
      character: meta.characterName
        ? { name: meta.characterName, sheet: safeParse(meta.characterSheet) }
        : null,
      // Champs historiques : ceux du personnage de la session. En solo c'est
      // le seul, et le front d'aujourd'hui ne voit aucune différence. Le mode
      // table lira `characters`, qui porte toute la vérité.
      souffle: principal.souffle,
      souffle_max: SOUFFLE_MAX,
      facts: state.facts,
      skills: principal.skills ?? [],
      pending_roll: principal.pending_roll
        ? normalizeRollRequest(principal.pending_roll)
        : null,
      last_roll: principal.last_roll,
      character_id: stateKey(meta.characterId),
      characters: Object.fromEntries(
        Object.entries(state.characters ?? {}).map(([key, cs]) => [
          key,
          {
            souffle: cs.souffle,
            skills: cs.skills ?? [],
            pending_roll: cs.pending_roll
              ? normalizeRollRequest(cs.pending_roll)
              : null,
            last_roll: cs.last_roll,
          },
        ]),
      ),
      turn_count: state.turn_count,
      // Actions déjà soumises pour le tour en cours. Un rechargement en plein
      // tour simultané doit retrouver qui est prêt — et l'hôte son forçage.
      submitted: (
        (await this.ctx.storage.get<PendingAction[]>("pending_actions")) ?? []
      ).map((a) => stateKey(a.characterId)),
      // Acte courant : son numéro et les tours déjà joués dedans. Le front s'en
      // sert pour situer la partie et proposer la clôture au bon moment.
      act_index: actIndex,
      act_turns: actTurns,
      acts_closed: (await this.closedActs()).length,
      // Le front propose « Clore l'acte » dès le seuil souple, sans attendre
      // une rupture de scène : au rechargement, l'event est déjà passé.
      act_close_suggested: actTurns >= ACT_SOFT_LIMIT,
      log: log.map((t) => ({
        role: t.role === "assistant" ? "gm" : "player",
        // Côté joueur, la ligne technique du jet est retirée : le client
        // affiche le jet via son propre bloc dédié. Un tour de continuation
        // post-jet devient donc une entrée vide, ignorée à l'affichage.
        text:
          t.role === "assistant"
            ? stripGmTags(t.text).trim()
            : t.text.replace(/^\[Jet [^\]]*\]\s*/, ""),
      })),
    };
  }

  private async syncKV(meta: SessionMeta, state: GameState): Promise<void> {
    await this.env.CACHE.put(
      sessionKvKey(meta.sessionId),
      JSON.stringify(await this.publicState(meta, state)),
    );
  }

  // ── Fin de session ────────────────────────────────────────────────────

  private async finish(meta: SessionMeta): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    if (!this.env.ANTHROPIC_API_KEY) {
      return json({ error: "narrator_not_configured" }, 503);
    }

    const state = await this.loadState(meta);
    // Le résumé profite du contexte serveur (faits, compétences) mais pas des
    // extraits RAG (inutiles pour synthétiser ce qui s'est joué).
    const messages = await this.buildMessages(
      (await this.turnContext(meta, state)) + "\n\n" + SUMMARY_MESSAGE,
    );
    const system = await this.systemBlocks(meta);

    const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    let summaryMd: string;
    try {
      const response = await client.messages.create({
        model: NARRATION_MODEL,
        max_tokens: MAX_NARRATION_TOKENS,
        system,
        messages,
      });
      this.logUsage("résumé", meta.sessionId, response.usage);
      summaryMd = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!summaryMd) throw new Error("empty_summary");
    } catch (err) {
      console.error(`[game-session] résumé échoué ${meta.sessionId} :`, err);
      // La session reste 'playing' : /finish est rejouable.
      return json({ error: "summary_failed" }, 502);
    }

    meta.status = "finished";
    await this.ctx.storage.put("meta", meta);
    await this.env.DB.prepare(
      `UPDATE game_sessions
       SET status = 'finished', summary_md = ?, finished_at = ?
       WHERE id = ?`,
    )
      .bind(summaryMd, Date.now(), meta.sessionId)
      .run();
    // Purge du cache chaud (SPEC §5).
    await this.env.CACHE.delete(sessionKvKey(meta.sessionId));

    // Arbre de compétences : les acquis de la session rejoignent LEUR
    // personnage (fusion sans régression). À une table, chacun repart avec les
    // siens — c'est bien pour ça que l'état est indexé par personnage.
    for (const [key, cs] of Object.entries(state.characters ?? {})) {
      if (key === SOLO_STATE_KEY || (cs.skills ?? []).length === 0) continue;
      const row = await this.env.DB.prepare(
        `SELECT skills_json FROM characters WHERE id = ?`,
      )
        .bind(key)
        .first<{ skills_json: string | null }>();
      if (!row) continue;
      let saved: SkillEntry[] = [];
      try {
        saved = sanitizeSkills(JSON.parse(row.skills_json ?? "[]"));
      } catch {
        saved = [];
      }
      await this.env.DB.prepare(
        `UPDATE characters SET skills_json = ? WHERE id = ?`,
      )
        .bind(JSON.stringify(mergeSkills(saved, cs.skills ?? [])), key)
        .run();
    }

    // Boucle canon (M5) : chaque invention devient une proposition en attente,
    // tranchée ensuite via POST /api/bibles/:id/proposals/:pid.
    const inventions =
      (await this.ctx.storage.get<Invention[]>("inventions")) ?? [];
    const now = Date.now();
    const proposals = inventions
      .filter((inv) => inv.content.trim() !== "")
      .map((inv) => ({
        id: crypto.randomUUID(),
        session_id: meta.sessionId,
        bible_id: meta.bibleId,
        content_md: inv.content,
        axis: inv.axis,
        status: "pending",
        source: "auto",
        source_comment: null as string | null,
        created_at: now,
      }));

    // Réponses aux zones floues de la mise en place : reformulées façon bible
    // (un seul appel, repli sur la réponse brute), puis proposées à validation
    // comme les inventions. source_comment garde la description de la lacune —
    // c'est la clé qui, à l'acceptation, la retire de gaps_json.
    const gapAnswers =
      (await this.ctx.storage.get<GapAnswer[]>("gap_answers")) ?? [];
    if (gapAnswers.length > 0) {
      const drafts = await canonizeGapAnswers(
        this.env.ANTHROPIC_API_KEY!,
        await this.ensureCanon(meta.bibleId),
        gapAnswers,
      );
      drafts.forEach((draft, i) => {
        proposals.push({
          id: crypto.randomUUID(),
          session_id: meta.sessionId,
          bible_id: meta.bibleId,
          content_md: draft.content_md,
          axis: draft.axis,
          status: "pending",
          source: "gap",
          source_comment: gapAnswers[i].description,
          created_at: now,
        });
      });
    }

    if (proposals.length > 0) {
      const stmt = this.env.DB.prepare(
        `INSERT INTO canon_proposals
           (id, session_id, bible_id, content_md, axis, status, source, source_comment, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      );
      await this.env.DB.batch(
        proposals.map((p) =>
          stmt.bind(
            p.id,
            p.session_id,
            p.bible_id,
            p.content_md,
            p.axis,
            p.source,
            p.source_comment,
            p.created_at,
          ),
        ),
      );
    }
    return json({ summary_md: summaryMd, inventions, proposals });
  }

  // ── Actes (lot 7.1) ───────────────────────────────────────────────────

  /**
   * Clôt l'acte courant : son résumé rejoint D1 et le storage du DO, puis la
   * fenêtre de contexte repart du tour suivant. Les tours de l'acte ne sont
   * PAS purgés — le résumé narré (lot 7.3) est bien meilleur quand il peut
   * relire les tours d'origine.
   *
   * Idempotent : rappelée sur un acte où rien n'a été joué, la clôture ne
   * crée pas d'acte vide et renvoie le dernier acte clos.
   */
  private async closeAct(
    meta: SessionMeta,
    reason: "manual" | "forced" = "manual",
  ): Promise<Response> {
    // Une clôture déjà en vol fait foi : on rend SA réponse plutôt que d'en
    // lancer une seconde. Response n'étant lisible qu'une fois, on la clone.
    const pending = this.closeInFlight;
    if (pending) return (await pending).clone();

    const job = this.runCloseAct(meta, reason);
    this.closeInFlight = job;
    try {
      return (await job).clone();
    } finally {
      this.closeInFlight = null;
    }
  }

  private async runCloseAct(
    meta: SessionMeta,
    reason: "manual" | "forced",
  ): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }

    const actIndex = (await this.ctx.storage.get<number>("act_index")) ?? 0;
    const turnStart = await this.actStartIndex();
    const turnEnd =
      (await this.ctx.storage.get<number>("turn_count_stored")) ?? 0;

    if (turnEnd <= turnStart) {
      const acts = await this.closedActs();
      const last = acts.at(-1);
      if (!last) return json({ error: "empty_act" }, 409);
      return json({ act: last, closed: false });
    }

    const state = await this.loadState(meta);
    const summary = await this.summarizeAct(meta, state);
    // Échec de génération : l'acte reste ouvert et la clôture est rejouable.
    // On ne borne JAMAIS la fenêtre sur un résumé vide — ce serait effacer le
    // passé de la session sans rien mettre à la place.
    if (!summary) return json({ error: "act_summary_failed" }, 502);

    const act: ClosedAct = {
      act_index: actIndex,
      title: summary.title,
      // Plafond dur : c'est le seul texte que la session paie éternellement.
      context_summary_md: capActSummary(summary.context_summary_md),
    };
    const closed = [...(await this.closedActs()), act];

    await this.env.DB.prepare(
      `INSERT INTO session_acts
         (id, session_id, act_index, title, context_summary_md,
          turn_start, turn_end, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        meta.sessionId,
        actIndex,
        act.title,
        act.context_summary_md,
        turnStart,
        turnEnd,
        Date.now(),
      )
      .run();

    // La fenêtre repart d'ici : listTurns() ne remontera plus au-delà, et le
    // bloc des résumés devient la nouvelle ancre de cache de l'acte suivant.
    await this.ctx.storage.put({
      act_index: actIndex + 1,
      act_start_index: turnEnd,
      closed_acts: closed,
    });

    // L'état de jeu n'est PAS touché : Souffle, compétences et faits établis
    // traversent la clôture. Un acte borne la mémoire narrative, pas la partie.
    await this.syncKV(meta, state);
    console.log(
      `[game-session] acte ${actIndex} clos (${reason}) ${meta.sessionId} : tours ${turnStart}-${turnEnd}`,
    );
    // Clôture manuelle : la table l'apprend par le socket. En clôture forcée,
    // pump() diffuse déjà l'event sur le flux du tour — d'où l'exclusion.
    if (reason === "manual") this.broadcast("act_closed", { act, forced: false });
    return json({ act, closed: true, reason });
  }

  /**
   * Résumé de CONTEXTE d'un acte : la fiche de mémoire que le modèle relira à
   * chaque tour des actes suivants. Même mécanique que finish() — l'historique
   * courant plus un message de consigne — mais avec son propre prompt, tourné
   * vers la densité et non vers la belle synthèse de fin de partie.
   *
   * buildMessages() sert de base à dessein : le préfixe est déjà en cache
   * (c'est celui du tour qu'on vient de jouer), la clôture ne coûte donc
   * presque rien en entrée.
   */
  private async summarizeAct(
    meta: SessionMeta,
    state: GameState,
  ): Promise<{ title: string | null; context_summary_md: string } | null> {
    if (!this.env.ANTHROPIC_API_KEY) return null;

    const messages = await this.buildMessages(
      (await this.turnContext(meta, state)) + "\n\n" + ACT_SUMMARY_MESSAGE,
    );
    const system = await this.systemBlocks(meta);

    try {
      const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: NARRATION_MODEL,
        max_tokens: MAX_ACT_SUMMARY_TOKENS,
        system,
        messages,
      });
      this.logUsage("clôture d'acte", meta.sessionId, response.usage);
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) return null;
      return parseActSummary(text);
    } catch (err) {
      console.error(`[game-session] résumé d'acte ${meta.sessionId} :`, err);
      return null;
    }
  }

  /**
   * Faut-il clore l'acte courant, et de quelle façon ? Trois déclencheurs, par
   * priorité décroissante : la main du joueur (traitée en amont, par la
   * route), une rupture de scène passé le seuil souple, puis la borne dure.
   */
  private async actVerdict(sceneBreak: boolean): Promise<{
    turns: number;
    force: boolean;
    suggest: boolean;
  }> {
    const start = await this.actStartIndex();
    const stored =
      (await this.ctx.storage.get<number>("turn_count_stored")) ?? 0;
    const turns = Math.max(0, Math.floor((stored - start) / 2));
    return {
      turns,
      force: turns >= ACT_HARD_LIMIT,
      suggest: sceneBreak && turns >= ACT_SOFT_LIMIT,
    };
  }

  // ── Récit narré d'un acte (lot 7.3) ───────────────────────────────────

  /**
   * Récit d'un acte pour le JOUEUR. À ne surtout pas confondre avec le résumé
   * de contexte : celui-là s'adresse au modèle et doit être télégraphique,
   * celui-ci s'adresse au joueur et doit être de la prose. Deux générations,
   * deux prompts, deux colonnes en base.
   *
   * Idempotent : un acte déjà narré renvoie l'existant, sauf ?force=1.
   */
  private async narrateAct(meta: SessionMeta, url: URL): Promise<Response> {
    const index = Number(url.searchParams.get("index"));
    if (!Number.isInteger(index) || index < 0) {
      return json({ error: "invalid_index" }, 400);
    }

    // Un récit coûte plus cher qu'une synthèse vocale : il mérite au moins la
    // même protection contre les appels concurrents (deux onglets, double clic).
    const pending = this.narrateInFlight.get(index);
    if (pending) return (await pending).clone();

    const job = this.runNarrateAct(meta, url, index);
    this.narrateInFlight.set(index, job);
    try {
      return (await job).clone();
    } finally {
      this.narrateInFlight.delete(index);
    }
  }

  private async runNarrateAct(
    meta: SessionMeta,
    url: URL,
    index: number,
  ): Promise<Response> {
    const force = url.searchParams.get("force") === "1";

    const act = await this.env.DB.prepare(
      `SELECT act_index, title, context_summary_md, narrated_summary_md,
              turn_start, turn_end
       FROM session_acts WHERE session_id = ? AND act_index = ?`,
    )
      .bind(meta.sessionId, index)
      .first<{
        act_index: number;
        title: string | null;
        context_summary_md: string;
        narrated_summary_md: string | null;
        turn_start: number;
        turn_end: number;
      }>();
    if (!act) return json({ error: "act_not_found" }, 404);

    if (act.narrated_summary_md && !force) {
      return json({ act, generated: false });
    }
    if (!this.env.ANTHROPIC_API_KEY) {
      return json({ error: "narrator_not_configured" }, 503);
    }

    // Les tours d'origine donnent un bien meilleur récit — on ne les purge
    // donc pas à la clôture. Mais le récit doit rester possible sans eux : la
    // fiche de mémoire suffit à raconter, en moins détaillé.
    const turns = (
      await this.listAllTurns({ start: act.turn_start, end: act.turn_end })
    ).filter((t) => t.text.trim() !== "");
    // Les messages doivent commencer par le joueur et alterner : un historique
    // qui débuterait sur le MJ serait refusé par l'API.
    while (turns.length > 0 && turns[0].role === "assistant") turns.shift();

    const messages: Anthropic.MessageParam[] =
      turns.length > 0
        ? [
            ...turns.map(
              (t): Anthropic.MessageParam => ({ role: t.role, content: t.text }),
            ),
            { role: "user", content: NARRATED_ACT_MESSAGE },
          ]
        : [
            {
              role: "user",
              content: buildNarratedFromSummary(act.context_summary_md),
            },
          ];

    let narrated: string;
    try {
      const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: NARRATION_MODEL,
        max_tokens: MAX_NARRATED_ACT_TOKENS,
        system: await this.systemBlocks(meta),
        messages,
      });
      this.logUsage("récit d'acte", meta.sessionId, response.usage);
      narrated = stripGmTags(
        response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
      ).trim();
      if (!narrated) throw new Error("empty_narration");
    } catch (err) {
      console.error(`[game-session] récit d'acte ${meta.sessionId} :`, err);
      return json({ error: "narration_failed" }, 502);
    }

    await this.env.DB.prepare(
      `UPDATE session_acts SET narrated_summary_md = ?
       WHERE session_id = ? AND act_index = ?`,
    )
      .bind(narrated, meta.sessionId, index)
      .run();

    return json({
      act: { ...act, narrated_summary_md: narrated },
      generated: true,
    });
  }

  /**
   * Récit d'un acte, lu à voix haute. Le MP3 est fabriqué UNE fois puis vit
   * dans R2 : la synthèse est le poste de coût le plus facile à faire exploser
   * par un double clic. Trois garde-fous, du moins cher au plus cher :
   * la clé déjà en base, l'objet déjà dans R2, et la déduplication des appels
   * concurrents sur cette instance de DO.
   */
  private async actAudio(meta: SessionMeta, url: URL): Promise<Response> {
    const index = Number(url.searchParams.get("index"));
    if (!Number.isInteger(index) || index < 0) {
      return json({ error: "invalid_index" }, 400);
    }
    if (!ttsConfigured(this.env)) {
      return json({ error: "tts_not_configured" }, 503);
    }

    const act = await this.env.DB.prepare(
      `SELECT narrated_summary_md, audio_key FROM session_acts
       WHERE session_id = ? AND act_index = ?`,
    )
      .bind(meta.sessionId, index)
      .first<{ narrated_summary_md: string | null; audio_key: string | null }>();
    if (!act) return json({ error: "act_not_found" }, 404);
    if (!act.narrated_summary_md) {
      // Le récit se génère explicitement : on ne déclenche pas une génération
      // de texte ET une synthèse vocale sur un simple clic de lecture.
      return json({ error: "act_not_narrated" }, 409);
    }

    const key = actAudioKey(meta.sessionId, index);
    const existing = await this.env.BUCKET.get(key);
    if (existing) return audioResponse(existing.body);

    const pending = this.audioInFlight.get(index);
    if (pending) {
      const bytes = await pending;
      return bytes
        ? audioResponse(bytes)
        : json({ error: "tts_failed" }, 502);
    }

    const job = this.generateActAudio(meta, index, key, act.narrated_summary_md);
    this.audioInFlight.set(index, job);
    try {
      const bytes = await job;
      if (!bytes) return json({ error: "tts_failed" }, 502);
      return audioResponse(bytes);
    } finally {
      this.audioInFlight.delete(index);
    }
  }

  private async generateActAudio(
    meta: SessionMeta,
    index: number,
    key: string,
    text: string,
  ): Promise<ArrayBuffer | null> {
    try {
      const res = await synthesizeSpeech(
        this.env,
        text.replace(/\*+/g, "").slice(0, MAX_TTS_CHARS),
      );
      if (!res.ok) {
        console.error(`[game-session] tts acte ${meta.sessionId} : ${res.status}`);
        return null;
      }
      const bytes = await res.arrayBuffer();
      await this.env.BUCKET.put(key, bytes, {
        httpMetadata: { contentType: "audio/mpeg" },
      });
      await this.env.DB.prepare(
        `UPDATE session_acts SET audio_key = ?
         WHERE session_id = ? AND act_index = ?`,
      )
        .bind(key, meta.sessionId, index)
        .run();
      return bytes;
    } catch (err) {
      console.error(`[game-session] tts acte ${meta.sessionId} :`, err);
      return null;
    }
  }

  // ── Table partagée : WebSocket, hibernation, présence (lot 8.2) ────────
  //
  // Une session de JDR reste ouverte des heures, avec de longues pauses. Sans
  // l'API d'hibernation, le DO resterait facturé pendant tout ce temps et
  // perdrait ses sockets à chaque réveil. On n'installe donc AUCUN handler
  // d'événement en mémoire : c'est la runtime qui rappelle webSocketMessage /
  // webSocketClose / webSocketError, y compris après une hibernation.

  /**
   * Upgrade WebSocket. L'identité vient des en-têtes posés par le Worker, qui
   * a déjà vérifié le cookie ET l'appartenance : rien de ce qui transite
   * ensuite dans les messages ne peut changer qui l'on est.
   */
  private async acceptSocket(
    meta: SessionMeta,
    request: Request,
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket" }, 426);
    }
    const userId = request.headers.get("x-lf-user-id");
    const role = request.headers.get("x-lf-role") === "host" ? "host" : "player";
    const characterId = request.headers.get("x-lf-character-id") || null;
    if (!userId) return json({ error: "unauthenticated_socket" }, 401);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Les tags sont interrogeables sans réveiller l'attachement ; ils servent
    // à cibler ou exclure les sockets d'un utilisateur donné.
    this.ctx.acceptWebSocket(server, [`user:${userId}`, `role:${role}`]);
    // L'attachement, lui, survit à l'hibernation : au réveil, la runtime rend
    // des sockets nus, et c'est la seule façon de savoir qui est au bout.
    server.serializeAttachment({ userId, role, characterId } satisfies SocketInfo);

    const state = await this.loadState(meta);
    // Un socket qui arrive — ou qui revient d'une hibernation, d'un écran
    // verrouillé — repart de l'état courant, sans rien rejouer.
    this.sendTo(server, "state", await this.publicState(meta, state));
    this.sendTo(server, "presence", { members: this.presence() });
    // Un socket qui s'ouvre signale souvent une arrivée à la table.
    this.forgetRoster();
    this.broadcast("member_joined", { user_id: userId, role }, { exclude: server });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Identité attachée à un socket, relue après hibernation. */
  private socketInfo(ws: WebSocket): SocketInfo | null {
    try {
      return (ws.deserializeAttachment() as SocketInfo) ?? null;
    } catch {
      return null;
    }
  }

  /** Membres actuellement connectés, dédupliqués (un joueur, plusieurs onglets). */
  private presence(): Array<{ user_id: string; role: string }> {
    const seen = new Map<string, { user_id: string; role: string }>();
    for (const ws of this.ctx.getWebSockets()) {
      const info = this.socketInfo(ws);
      if (info) seen.set(info.userId, { user_id: info.userId, role: info.role });
    }
    return [...seen.values()];
  }

  private sendTo(ws: WebSocket, event: string, data: unknown): void {
    try {
      ws.send(JSON.stringify({ event, data }));
    } catch (err) {
      // Socket mort : jamais fatal, et surtout jamais propagé à l'appelant.
      console.error(`[game-session] envoi WS :`, err);
    }
  }

  /**
   * Diffuse un event à toute la table. Une exception d'envoi sur un client ne
   * doit JAMAIS interrompre la narration des autres — d'où le try/catch par
   * socket plutôt qu'un Promise.all qui échouerait en bloc.
   *
   * `excludeUser` sert au chemin SSE : l'auteur du tour reçoit déjà tout par
   * son flux, il ne doit pas voir chaque event en double.
   */
  private broadcast(
    event: string,
    data: unknown,
    opts: { exclude?: WebSocket; excludeUser?: string | null } = {},
  ): void {
    const payload = JSON.stringify({ event, data });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === opts.exclude) continue;
      if (opts.excludeUser && this.socketInfo(ws)?.userId === opts.excludeUser) {
        continue;
      }
      try {
        ws.send(payload);
      } catch (err) {
        console.error("[game-session] diffusion WS :", err);
      }
    }
  }

  // Handlers d'hibernation : rappelés par la runtime, y compris au réveil.

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Le seul message accepté est un battement de cœur. Aucune identité, aucun
    // ordre de jeu ne transite par ici : l'authentification s'est faite à
    // l'upgrade, et un message WS n'est pas une requête authentifiée.
    if (typeof message !== "string") return;
    try {
      if ((JSON.parse(message) as { type?: string }).type === "ping") {
        this.sendTo(ws, "pong", {});
      }
    } catch {
      /* message illisible : ignoré */
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onSocketGone(ws);
  }

  private onSocketGone(ws: WebSocket): void {
    const info = this.socketInfo(ws);
    if (!info) return;
    // Le socket qui part est encore listé par getWebSockets() : on l'exclut
    // pour ne pas annoncer présent quelqu'un qui vient de fermer son onglet.
    const others = this.ctx
      .getWebSockets()
      .filter((other) => other !== ws)
      .map((other) => this.socketInfo(other))
      .filter((i): i is SocketInfo => i !== null);
    const stillHere = others.some((i) => i.userId === info.userId);

    // Plusieurs onglets pour un même joueur : il n'est parti que quand le
    // dernier se ferme.
    if (!stillHere) {
      this.broadcast("member_left", { user_id: info.userId }, { exclude: ws });
    }
    const seen = new Map<string, { user_id: string; role: string }>();
    for (const i of others) seen.set(i.userId, { user_id: i.userId, role: i.role });
    this.broadcast("presence", { members: [...seen.values()] }, { exclude: ws });
  }

  // ── Génération streamée (setup et turn) ───────────────────────────────

  private async generate(
    meta: SessionMeta,
    state: GameState,
    // sent : contexte de tour + saisie, envoyé au modèle ; stored : saisie
    // seule, persistée dans l'historique (préfixe stable → cache de prompt).
    text: { sent: string; stored: string },
    consumedRoll: RollResult | null = null,
    opts: {
      becomePlaying?: boolean;
      actor?: Actor;
      /** Personnages ayant agi ce tour : les balises d'état s'y rapportent. */
      actingCharacters?: Array<{ key: string; name: string | null }>;
    } = {},
  ): Promise<Response> {
    if (!this.env.ANTHROPIC_API_KEY) {
      return json({ error: "narrator_not_configured" }, 503);
    }
    const system = await this.systemBlocks(meta);
    const messages = await this.buildMessages(text.sent);

    const { readable, writable } = new TransformStream();
    // Le DO reste actif tant que la réponse streamée est ouverte.
    void this.pump(
      writable,
      meta,
      state,
      text.stored,
      system,
      messages,
      consumedRoll,
      Boolean(opts.becomePlaying),
      opts.actor ?? { userId: null, characterId: null },
      opts.actingCharacters ?? [],
    );

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  private async pump(
    writable: WritableStream,
    meta: SessionMeta,
    state: GameState,
    storedText: string,
    system: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
    consumedRoll: RollResult | null,
    becomePlaying: boolean,
    actor: Actor,
    actingCharacters: Array<{ key: string; name: string | null }>,
  ): Promise<void> {
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    // Un seul geste, deux transports : le SSE pour l'auteur du tour (qui tient
    // la requête ouverte) et le WebSocket pour le reste de la table. L'auteur
    // est exclu de la diffusion, sinon il verrait tout en double s'il a aussi
    // un socket ouvert.
    const send = (event: string, data: unknown) => {
      this.broadcast(event, data, { excludeUser: actor.userId });
      return writer.write(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    };

    try {
      this.broadcast("turn_resolving", {
        characters: actingCharacters.map((c) => c.key),
      });
      if (consumedRoll) await send("roll", consumedRoll);

      const client = new Anthropic({
        apiKey: this.env.ANTHROPIC_API_KEY!,
      });
      const stream = await client.messages.create({
        model: NARRATION_MODEL,
        max_tokens: MAX_NARRATION_TOKENS,
        system,
        messages,
        stream: true,
      });

      const parser = new GmStreamParser();
      // Les balises d'état du MJ portent sur le personnage qui vient d'agir :
      // c'est SON Souffle qui se dépense, SES compétences qui progressent.
      const defautKey = actingCharacters[0]?.key
        ?? stateKey(actor.characterId ?? meta.characterId);
      // Personnages effectivement modifiés par ce tour : eux seuls seront
      // réécrits à la persistance. Ce qui a bougé ailleurs pendant la
      // narration (un jet lancé par un autre joueur) doit survivre.
      const touches = new Set<string>([defautKey]);
      // À une table, le MJ dit de QUI il parle via l'attribut `character`.
      // Sans attribut — cas du solo, et du tour où il n'y a pas d'ambiguïté —
      // la balise revient au personnage qui vient d'agir.
      const cible = (nom?: string): CharacterState => {
        const trouve = nom
          ? actingCharacters.find((c) => c.name && sameName(c.name, nom))
          : undefined;
        return characterState(state, trouve?.key ?? defautKey);
      };
      const cleDe = (nom?: string): string =>
        (nom
          ? actingCharacters.find((c) => c.name && sameName(c.name, nom))?.key
          : undefined) ?? defautKey;
      const me = characterState(state, defautKey);
      const inventions =
        (await this.ctx.storage.get<Invention[]>("inventions")) ?? [];
      let raw = "";
      // Une frontière d'acte se greffe sur un signal que le MJ émet déjà :
      // <scene_break/>. On coupe donc sur une rupture narrative choisie par
      // le narrateur, jamais au milieu d'une scène.
      let sceneBreak = false;
      // Le MJ vient-il de fixer l'ordre ? Si oui, la main ne passe pas au
      // suivant à la fin de ce tour : le premier nommé n'aurait jamais joué.
      let ordreVientDEtreFixe = false;

      const handle = async (chunk: {
        text: string;
        events: GmTagEvent[];
      }): Promise<void> => {
        if (chunk.text) await send("narration", { text: chunk.text });
        for (const event of chunk.events) {
          switch (event.type) {
            case "roll_request": {
              const pj = cible(event.character);
              touches.add(cleDe(event.character));
              pj.pending_roll = event.request;
              await send("state_patch", {
                character_id: cleDe(event.character),
                pending_roll: event.request,
              });
              break;
            }
            case "souffle_delta": {
              const pj = cible(event.character);
              touches.add(cleDe(event.character));
              pj.souffle = applySouffleDelta(pj.souffle, event.delta);
              await send("state_patch", {
                character_id: cleDe(event.character),
                souffle: pj.souffle,
              });
              break;
            }
            case "turn_mode":
              // C'est le MJ qui sait quand un combat commence. Le régime est
              // persisté : il vaut pour les tours suivants, pas seulement
              // celui-ci.
              ordreVientDEtreFixe = true;
              await this.ctx.storage.put({
                turn_mode: {
                  value: event.value,
                  order: event.order,
                } satisfies TurnMode,
                // Nouvel ordre : on repart de son premier nom.
                turn_order_index: 0,
              });
              await send("turn_mode_changed", {
                value: event.value,
                order: event.order,
              });
              break;
            case "scene_break":
              sceneBreak = true;
              await send("scene_break", {});
              break;
            case "invention":
              // Invisible pour le joueur ; deviendra un canon_proposal (M5).
              inventions.push({
                axis: event.axis,
                content: event.content,
                turn: state.turn_count + 1,
              });
              break;
            case "skill_update": {
              // Mémoire longue : la compétence survit à la fenêtre d'historique.
              const pj = cible(event.character);
              touches.add(cleDe(event.character));
              pj.skills ??= [];
              if (applySkillUpdate(pj.skills, event.name, event.tier, event.note)) {
                await send("state_patch", {
                  character_id: cleDe(event.character),
                  skills: pj.skills,
                });
              }
              break;
            }
            case "fact":
              // Les faits sont collectifs : ils n'appartiennent à personne.
              if (addFact(state.facts, event.text)) {
                await send("state_patch", { facts: state.facts });
              }
              break;
          }
        }
      };

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          raw += event.delta.text;
          await handle(parser.feed(event.delta.text));
        } else if (event.type === "message_start") {
          // Le coût du préfixe se lit ici, et nulle part ailleurs.
          this.logUsage("narration", meta.sessionId, event.message.usage);
        }
      }
      await handle(parser.flush());

      // Garde-fou de fin de tour (§7) : si le tour retombe fermé (ni question
      // ni options) ET qu'aucun jet n'est en attente, on relance le modèle
      // pour une vraie relance — filet best-effort, invisible pour le joueur.
      if (!me.pending_roll && !turnEndsOpen(stripGmTags(raw))) {
        try {
          const relance = await client.messages.create(
            {
              model: NARRATION_MODEL,
              max_tokens: MAX_RELANCE_TOKENS,
              system,
              messages: [
                ...messages,
                { role: "assistant", content: raw },
                { role: "user", content: RELANCE_MESSAGE },
              ],
            },
            { maxRetries: 0 },
          );
          const clean = stripGmTags(
            relance.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join(""),
          ).trim();
          if (clean) {
            const joined = "\n\n" + clean;
            await send("narration", { text: joined });
            raw += joined;
          }
        } catch (err) {
          console.error(`[game-session] relance ${meta.sessionId} :`, err);
        }
      }

      // Persistance atomique du tour (user + assistant) et de l'état. Le
      // passage en 'playing' (scène 1) n'est commité qu'ici, au succès.
      const stored =
        (await this.ctx.storage.get<number>("turn_count_stored")) ?? 0;

      // Fusion plutôt qu'écrasement. `state` a été chargé AVANT l'appel au
      // modèle, il y a des dizaines de secondes ; entre-temps un autre joueur
      // a pu lancer son dé, et réécrire le blob entier annulerait son jet
      // (il l'aurait vu tomber, puis on le lui redemanderait).
      const frais = await this.loadState(meta);
      for (const key of touches) {
        frais.characters[key] = characterState(state, key);
      }
      frais.facts = state.facts;
      frais.turn_count = (frais.turn_count ?? 0) + 1;
      state.turn_count = frais.turn_count;

      if (becomePlaying) meta.status = "playing";
      await this.ctx.storage.put({
        [turnKey(stored)]: { role: "user", text: storedText } as StoredTurn,
        [turnKey(stored + 1)]: { role: "assistant", text: raw } as StoredTurn,
        turn_count_stored: stored + 2,
        state: frais,
        inventions,
        ...(becomePlaying ? { meta } : {}),
      });
      if (becomePlaying) {
        await this.env.DB.prepare(
          `UPDATE game_sessions SET status = 'playing' WHERE id = ?`,
        )
          .bind(meta.sessionId)
          .run();
      }
      await this.syncKV(meta, frais);
      // Séquentiel : la main passe au suivant maintenant que le tour est joué.
      if (!ordreVientDEtreFixe) await this.advanceTurnOrder(meta);
      else {
        const suivant = await this.expectedPlayer(
          await this.turnMode(),
          await this.roster(meta),
        );
        if (suivant) this.broadcast("awaiting_player", { name: suivant });
      }

      await send("done", {
        turn: state.turn_count,
        souffle: me.souffle,
        character_id: defautKey,
      });

      // Bornes d'acte, APRÈS le `done` : le tour est validé et lisible pour le
      // joueur, qui lit pendant que le résumé se fabrique. Le flux est encore
      // ouvert, l'UI reçoit donc la suite sans second aller-retour.
      const verdict = await this.actVerdict(sceneBreak);
      if (verdict.force) {
        // Le résumé prend plusieurs secondes. Sans signe de vie, le timeout
        // d'inactivité du client (20 s) couperait le flux et l'event de
        // clôture serait perdu : le joueur garderait un état périmé jusqu'au
        // prochain rechargement. On annonce donc la clôture, puis on tient la
        // connexion éveillée pendant la génération.
        await send("act_closing", {});
        const beat = setInterval(() => {
          void send("act_closing", {}).catch(() => {});
        }, ACT_CLOSING_HEARTBEAT_MS);
        try {
          const res = await this.closeAct(meta, "forced");
          if (res.ok) {
            const { act } = (await res.json()) as { act: ClosedAct };
            await send("act_closed", { act, forced: true });
          } else {
            // Clôture ratée : le joueur doit récupérer la main, l'acte reste
            // ouvert et la borne dure retentera au tour suivant.
            await send("act_close_failed", {});
          }
        } finally {
          clearInterval(beat);
        }
      } else if (verdict.suggest) {
        await send("act_close_suggested", { turns: verdict.turns });
      }
    } catch (err) {
      console.error(`[game-session] génération ${meta.sessionId} :`, err);
      try {
        await send("error", { error: "generation_failed" });
      } catch {
        // flux déjà fermé côté client
      }
    } finally {
      // Le verrou tombe au succès comme à l'échec : une génération ratée ne
      // doit pas geler la table pour toujours.
      await this.releaseLock();
      try {
        await writer.close();
      } catch {
        // idem
      }
      // Actions arrivées pendant la narration : elles n'ont jamais été
      // perdues, elles composent le tour suivant.
      await this.drainQueuedActions(meta);
    }
  }

  /**
   * Relance un tour si des actions se sont accumulées pendant la narration.
   * Personne ne tient de flux ici : la table reçoit tout par WebSocket.
   */
  private async drainQueuedActions(meta: SessionMeta): Promise<void> {
    if ((meta.mode ?? "solo") !== "table") return;
    const actions =
      (await this.ctx.storage.get<PendingAction[]>("pending_actions")) ?? [];
    if (actions.length === 0) return;
    if (!(await this.everyoneSubmitted(meta, actions))) {
      this.broadcast("turn_waiting", {
        submitted: actions.map((a) => stateKey(a.characterId)),
        queued: false,
      });
      await this.ctx.storage.setAlarm(Date.now() + TURN_WAIT_MS);
      return;
    }
    const res = await this.resolveTurn(meta, {
      userId: null,
      characterId: null,
    });
    void res.body?.pipeTo(new WritableStream());
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * État de jeu, relu et remis à la forme courante. Une partie ouverte avant
   * la table partagée avait tout à plat au niveau session : elle se relit
   * comme l'état de son unique personnage, sans perte.
   */
  private async loadState(meta: SessionMeta): Promise<GameState> {
    const raw = await this.ctx.storage.get<GameState>("state");
    return migrateGameState(raw, meta.characterId);
  }

  /** État du personnage qui agit — le sien, jamais celui de la table. */
  private async actorState(
    meta: SessionMeta,
    actor: Actor,
  ): Promise<{ state: GameState; me: CharacterState; key: string }> {
    const state = await this.loadState(meta);
    // Le repli sur le personnage de la session n'a de sens qu'en SOLO, où il
    // n'y en a qu'un. À une table, il ferait dépenser le Souffle de l'hôte à
    // un joueur sans fiche, et deux joueurs sans fiche partageraient un même
    // état — d'où le garde, en amont, dans turn() et roll().
    const characterId = actor.characterId ?? meta.characterId;
    return {
      state,
      me: characterState(state, characterId),
      key: stateKey(characterId),
    };
  }

  /**
   * À une table, agir suppose d'incarner quelqu'un. Un membre qui a rejoint la
   * partie en cours n'a pas encore choisi : il doit le faire avant de jouer.
   */
  private seated(meta: SessionMeta, actor: Actor): Response | null {
    if ((meta.mode ?? "solo") !== "table") return null;
    if (actor.characterId) return null;
    return json({ error: "character_required" }, 409);
  }

  /**
   * Qui est à la table, dans l'ordre d'arrivée. Sert au contexte de tour : le
   * MJ doit savoir à qui il s'adresse. Une session d'avant la table partagée
   * (aucune ligne de membre) retombe sur le personnage de la session.
   */
  private async roster(
    meta: SessionMeta,
  ): Promise<
    Array<{
      characterId: string | null;
      name: string | null;
      sheet?: string | null;
    }>
  > {
    // Mémoïsé pour la durée du tour : il était relu deux fois par tour (une
    // pour assembler les actions, une pour le contexte), y compris en solo où
    // la réponse tient en une ligne et ne change jamais.
    if (this.rosterCache) return this.rosterCache;
    const { results } = await this.env.DB.prepare(
      `SELECT sm.character_id, ch.name, ch.sheet_json
       FROM session_members sm
       LEFT JOIN characters ch ON ch.id = sm.character_id
       WHERE sm.session_id = ? ORDER BY sm.joined_at`,
    )
      .bind(meta.sessionId)
      .all<{
        character_id: string | null;
        name: string | null;
        sheet_json: string | null;
      }>();
    // La fiche est relue ICI, à chaque tour, jamais figée à l'init : c'est
    // tout le point. En solo elle est déjà dans le prompt système — la
    // répéter changerait le message de tour pour rien.
    const table = (meta.mode ?? "solo") === "table";
    this.rosterCache =
      results.length === 0
        ? [{ characterId: meta.characterId, name: meta.characterName }]
        : results.map((r) => ({
            characterId: r.character_id,
            name: r.name,
            ...(table ? { sheet: r.sheet_json } : {}),
          }));
    return this.rosterCache;
  }

  /** À invalider dès que la composition de la table peut avoir changé. */
  private forgetRoster(): void {
    this.rosterCache = null;
  }

  /**
   * Bloc d'état volatile du tour, roster compris. Il voyage dans le message
   * joueur et JAMAIS dans le prompt système : celui-ci est en cache ephemeral
   * et doit rester identique à l'octet près, or les joueurs vont et viennent.
   */
  private async turnContext(
    meta: SessionMeta,
    state: GameState,
    canonExcerpts?: string | null,
  ): Promise<string> {
    return buildTurnContext(state, {
      characters: turnCharacters(state, await this.roster(meta)),
      canonExcerpts,
    });
  }

  /** Canon Markdown de la bible, relu depuis D1 au premier besoin. */
  private async ensureCanon(bibleId: string): Promise<string> {
    if (this.canonCache === null) {
      const row = await this.env.DB.prepare(
        `SELECT canon_md FROM bibles WHERE id = ?`,
      )
        .bind(bibleId)
        .first<{ canon_md: string | null }>();
      this.canonCache = row?.canon_md ?? "";
    }
    return this.canonCache;
  }

  // ── Zones floues de la mise en place (§4) ────────────────────────────────

  /**
   * Choisit les lacunes à soumettre à l'auteur avant la scène 1. Les scores
   * d'axe disent ce qui manque à la BIBLE ; ils ne disent pas ce que CETTE
   * partie va croiser. Un appel court note donc chaque lacune à la lumière du
   * personnage, du fil rouge et du format, et seules celles au-dessus du seuil
   * sont posées — quitte à n'en poser qu'une, ou aucune.
   *
   * Les lacunes écartées ne sont pas perdues : elles restent dans gaps_json et
   * visibles dans l'éditeur de bible ; elles ne sont simplement pas posées ici.
   */
  private async pickSetupGaps(
    meta: SessionMeta,
    openGaps: RichnessGap[],
  ): Promise<RichnessGap[]> {
    if (!meta.scores || openGaps.length === 0) return [];
    const candidates = openGaps.slice(0, MAX_SCORED_GAPS);
    const context = {
      characterName: meta.characterName,
      characterSheet: meta.characterSheet,
      trame: meta.trame,
      format: meta.format,
    };

    try {
      const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: SETUP_RELEVANCE_MODEL,
        max_tokens: MAX_RELEVANCE_TOKENS,
        system: RELEVANCE_SYSTEM_PROMPT,
        output_config: {
          format: { type: "json_schema", schema: RELEVANCE_OUTPUT_SCHEMA },
        },
        messages: [
          { role: "user", content: buildRelevanceMessage(candidates, context) },
        ],
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return selectRelevantGaps(parseRelevance(JSON.parse(text), candidates));
    } catch (err) {
      // Repli hors ligne : le tri par mots-clés, qui ne rend que les lacunes
      // que le contexte touche vraiment (souvent aucune) — jamais un lot de
      // questions hors sujet parce que le scoring n'a pas répondu.
      console.error(`[game-session] pertinence des lacunes ${meta.sessionId} :`, err);
      return selectSetupGaps(meta.scores, candidates, setupContext(meta));
    }
  }

  // ── Fiche lore (§7) : un seul chemin, toujours rédigé par l'IA ────────────
  //
  // Canon riche, canon pauvre ou pur terme inventé en session : même appel de
  // résumé, jamais d'extrait de bible brut ni de texte de repli générique. Le
  // résultat est caché par session ; la signature des sources sert de clé de
  // fraîcheur — si de nouveaux tours ont développé le terme, on régénère.

  private async lore(meta: SessionMeta, url: URL): Promise<Response> {
    const term = (url.searchParams.get("term") ?? "").trim().slice(0, 120);
    if (!term) return json({ error: "missing_term" }, 400);
    const kind = normalizeKind(url.searchParams.get("kind"));

    const canon = await this.ensureCanon(meta.bibleId);
    const inventions =
      (await this.ctx.storage.get<Invention[]>("inventions")) ?? [];
    // Volontairement NON borné à l'acte : un terme établi il y a deux actes
    // garde ses sources, sinon sa fiche s'appauvrit à chaque clôture — soit
    // l'inverse de ce que les actes devaient apporter.
    const narration = (await this.listAllTurns(undefined, CONTEXT_MESSAGES))
      .filter((t) => t.role === "assistant")
      .map((t) => stripGmTags(t.text).trim());
    const sources = collectLoreSources(canon, inventions, narration, term);
    const signature = loreSignature(sources);

    const key = loreKvKey(meta.sessionId, term);
    const cached = safeParse(await this.env.CACHE.get(key)) as
      | (LoreCacheEntry | null)
      | string;
    if (
      cached &&
      typeof cached === "object" &&
      cached.signature === signature &&
      cached.fiche?.kind === kind
    ) {
      return json(cached.fiche);
    }

    let generated: string;
    try {
      const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: LORE_MODEL,
        max_tokens: MAX_LORE_TOKENS,
        system: LORE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildLoreUserMessage({
              term,
              kind,
              sources,
              bibleTitle: meta.bibleTitle,
              characterName: meta.characterName,
            }),
          },
        ],
      });
      generated = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    } catch (err) {
      console.error(`[game-session] fiche lore ${meta.sessionId} :`, err);
      return json({ error: "lore_unavailable" }, 503);
    }

    const fiche = {
      ...buildFiche(term, kind, sources, generated),
      bible_id: meta.bibleId,
    };
    if (!fiche.definition) return json({ error: "lore_unavailable" }, 503);

    // Best-effort : un échec de cache ne doit pas priver le joueur de la fiche.
    try {
      await this.env.CACHE.put(
        key,
        JSON.stringify({ signature, fiche } satisfies LoreCacheEntry),
        { expirationTtl: LORE_TTL_SECONDS },
      );
    } catch (err) {
      console.error(`[game-session] cache lore ${meta.sessionId} :`, err);
    }
    return json(fiche);
  }

  /**
   * Prompt système stable de la session, en bloc unique marqué pour le prompt
   * caching : identique à l'octet près d'un tour à l'autre, il n'est facturé
   * plein tarif qu'une fois (puis ~0,1× en relecture).
   */
  private async systemBlocks(
    meta: SessionMeta,
  ): Promise<Anthropic.TextBlockParam[]> {
    const canon = await this.ensureCanon(meta.bibleId);
    return [
      {
        type: "text",
        text: buildSystemPrompt({
          bibleTitle: meta.bibleTitle,
          // Fixé à l'init et jamais recalculé : cette partie du prompt est en
          // cache ephemeral et doit rester identique à l'octet près.
          multiplayer: (meta.mode ?? "solo") === "table",
          canonMd: canon,
          scores: meta.scores,
          gaps: meta.gaps,
          authorFeedback: meta.authorFeedback ?? [],
          toneProfile: meta.toneProfile,
          moodboardAnnex: meta.moodboardAnnex ?? "",
          characterName: meta.characterName,
          characterSheet: meta.characterSheet,
          format: meta.format,
          trame: meta.trame,
        }),
        cache_control: CACHE_CONTROL,
      },
    ];
  }

  /**
   * Préfixe le message du tour avec le bloc d'état volatile (Souffle, faits,
   * compétences, extraits RAG). Ce préfixe n'est jamais stocké : l'historique
   * reste stable pour le cache, et les extraits ne sont facturés qu'une fois.
   */
  private async withTurnContext(
    meta: SessionMeta,
    state: GameState,
    storedText: string,
  ): Promise<string> {
    const canon = await this.ensureCanon(meta.bibleId);
    // RAG (M6) : bible volumineuse → top-6 d'extraits re-rankés pour ce
    // tour ; null (bindings absents, index périmé, bible modeste...) → le
    // canon du prompt système (tronqué au besoin) suffit.
    const canonExcerpts = await retrieveCanonExcerpts(
      this.env,
      meta.bibleId,
      canon,
      storedText || (meta.trame ?? meta.bibleTitle),
      {
        trame: meta.trame,
        names: [
          ...(meta.characterName ? [meta.characterName] : []),
          ...state.facts.slice(-5),
        ],
      },
      (p) => this.ctx.waitUntil(p),
    );
    return (
      (await this.turnContext(meta, state, canonExcerpts)) + "\n\n" + storedText
    );
  }

  /**
   * Historique de l'acte courant + nouveau message utilisateur.
   *
   * Deux points de cache, deux rôles :
   * - sur le bloc des actes clos, en tête du premier message : c'est l'ANCRE.
   *   Elle ne bouge plus de tout l'acte, donc le préfixe (système + résumés)
   *   reste identique à l'octet près d'un tour à l'autre. C'est précisément ce
   *   que la fenêtre glissante cassait : passé le 40e tour, le premier message
   *   changeait à chaque tour et tout l'historique repassait plein tarif.
   * - sur le dernier tour stocké : cache INCRÉMENTAL. L'historique de l'acte
   *   ne fait que s'allonger, chaque tour étend donc l'entrée précédente au
   *   lieu de la réécrire.
   */
  private async buildMessages(
    sentText: string,
  ): Promise<Anthropic.MessageParam[]> {
    const turns = await this.listTurns(CONTEXT_MESSAGES);
    const actsBlock = buildActsBlock(await this.closedActs());
    const tail = { role: "user" as const, content: sentText };

    // Aucun acte clos : forme historique inchangée (une session courte ne voit
    // strictement aucune différence).
    if (!actsBlock) {
      return [
        ...turns.map((t, i): Anthropic.MessageParam => ({
          role: t.role,
          content:
            i === turns.length - 1 && t.text !== ""
              ? [{ type: "text", text: t.text, cache_control: CACHE_CONTROL }]
              : t.text,
        })),
        tail,
      ];
    }

    const ancre: Anthropic.TextBlockParam = {
      type: "text",
      text: actsBlock,
      cache_control: CACHE_CONTROL,
    };

    // Acte tout juste ouvert, aucun tour joué dedans : l'ancre voyage en tête
    // du message du tour. Elle garde son propre bloc, donc son point de cache
    // reste devant le contexte volatile (qui, lui, change à chaque tour).
    if (turns.length === 0) {
      return [{ role: "user", content: [ancre, { type: "text", text: sentText }] }];
    }

    return [
      ...turns.map((t, i): Anthropic.MessageParam => {
        const blocks: Anthropic.TextBlockParam[] = [];
        if (i === 0) blocks.push(ancre);
        if (t.text !== "") {
          blocks.push(
            i === turns.length - 1
              ? { type: "text", text: t.text, cache_control: CACHE_CONTROL }
              : { type: "text", text: t.text },
          );
        }
        // Un tour vide en fin de fenêtre laisserait un contenu vide : on
        // retombe alors sur la forme chaîne, comme avant les actes.
        return blocks.length === 0
          ? { role: t.role, content: t.text }
          : { role: t.role, content: blocks };
      }),
      tail,
    ];
  }

  /**
   * Tours de l'ACTE COURANT, les `limit` derniers. Ne remonte jamais avant
   * act_start_index : ce qui précède est représenté par les résumés d'actes,
   * pas par des tours bruts.
   */
  private async listTurns(limit: number): Promise<StoredTurn[]> {
    const start = await this.actStartIndex();
    const map = await this.ctx.storage.list<StoredTurn>({
      prefix: "turn:",
      start: turnKey(start),
      reverse: true,
      limit,
    });
    return [...map.values()].reverse();
  }

  /**
   * Historique COMPLET de la session, actes clos compris. Les tours d'un acte
   * clos ne sont pas purgés : le résumé narré (lot 7.3) est bien meilleur
   * quand il peut relire les tours d'origine.
   */
  private async listAllTurns(
    range?: { start: number; end: number },
    limit?: number,
  ): Promise<StoredTurn[]> {
    const map = await this.ctx.storage.list<StoredTurn>({
      prefix: "turn:",
      ...(range
        ? { start: turnKey(range.start), end: turnKey(range.end) }
        : {}),
      // Sans borne, on désérialiserait tout l'historique de la partie à chaque
      // appel — et les tours d'un acte clos ne sont jamais purgés. Le journal
      // et les sources de lore n'en veulent que les derniers.
      ...(limit ? { reverse: true, limit } : {}),
    });
    const turns = [...map.values()];
    return limit ? turns.reverse() : turns;
  }

  /** Borne basse de la fenêtre de contexte : premier tour de l'acte courant. */
  private async actStartIndex(): Promise<number> {
    return (await this.ctx.storage.get<number>("act_start_index")) ?? 0;
  }

  /**
   * Résumés des actes déjà clos, dans l'ordre de jeu.
   *
   * Reprise de session : si le storage du DO n'a pas (ou plus) la liste — DO
   * réveillé sur une session ouverte avant ce lot, storage réinitialisé —, D1
   * fait foi et la liste est reconstruite. Rouvrir une partie ne rejoue donc
   * jamais rien : le contexte se reconstitue depuis les résumés.
   */
  private async closedActs(): Promise<ClosedAct[]> {
    const cached = await this.ctx.storage.get<ClosedAct[]>("closed_acts");
    if (cached) return cached;

    const meta = await this.ctx.storage.get<SessionMeta>("meta");
    if (!meta) return [];
    const { results } = await this.env.DB.prepare(
      `SELECT act_index, title, context_summary_md FROM session_acts
       WHERE session_id = ? ORDER BY act_index`,
    )
      .bind(meta.sessionId)
      .all<ClosedAct>();

    await this.ctx.storage.put("closed_acts", results);
    return results;
  }

  /**
   * Coût du prompt caching, tour par tour. C'est la seule façon de PROUVER que
   * le bornage par acte fait ce qu'on en attend : cache_read élevé et stable =
   * le préfixe tient ; cache_creation qui repart à chaque tour = il a décroché.
   * À garder avant d'ajouter le multi-joueurs, qui quadruplera les tours.
   */
  private logUsage(label: string, sessionId: string, usage: unknown): void {
    const u = (usage ?? {}) as Record<string, number | undefined>;
    console.log(
      `[game-session] ${label} ${sessionId} tokens :`,
      JSON.stringify({
        input: u.input_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_creation: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      }),
    );
  }
}

/**
 * Sépare le titre d'acte de sa fiche de mémoire. Le modèle est prié de sortir
 * `# Titre` en première ligne ; s'il ne le fait pas, on garde tout le texte et
 * l'acte reste sans titre — un résumé sans titre reste parfaitement utilisable.
 */
function parseActSummary(text: string): {
  title: string | null;
  context_summary_md: string;
} {
  const match = /^#\s+(.+?)\s*(?:\n|$)/.exec(text);
  if (!match) return { title: null, context_summary_md: text };
  return {
    title: match[1].trim().slice(0, 120),
    context_summary_md: text.slice(match[0].length).trim(),
  };
}

/** MP3 servi au joueur ; cache privé long, l'objet R2 ne change jamais. */
function audioResponse(body: ReadableStream | ArrayBuffer | null): Response {
  return new Response(body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "private, max-age=86400",
    },
  });
}

function safeParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
