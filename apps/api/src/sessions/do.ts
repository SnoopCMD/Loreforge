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
//   POST /destroy                  → JSON {ok} (purge totale, session supprimée)

import { DurableObject } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { RichnessGap, RichnessScores } from "../richness/logic";
import {
  addFact,
  applySkillUpdate,
  applySouffleDelta,
  initialGameState,
  mergeSkills,
  normalizeRollRequest,
  performRoll,
  sanitizeSkills,
  SOUFFLE_MAX,
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
import { loadMoodboardAnnex } from "../bibles/moodboard-context";
import {
  buildSetupMessage,
  buildSystemPrompt,
  buildTurnContext,
  buildTurnMessage,
  gapQuestion,
  RELANCE_MESSAGE,
  selectSetupGaps,
  SUMMARY_MESSAGE,
  turnEndsOpen,
  type SetupContext,
} from "./prompt";
import { canonizeGapAnswers, type GapAnswer } from "../richness/suggest";

export const NARRATION_MODEL = "claude-sonnet-5";
const MAX_NARRATION_TOKENS = 2048;
const MAX_PLAYER_INPUT_CHARS = 4000;
const MAX_ANSWERS = 10;
/** Fil rouge de session : une intention, pas un synopsis. */
export const MAX_TRAME_CHARS = 500;
// Fenêtre de contexte : derniers tours envoyés au modèle.
const CONTEXT_TURNS = 40;
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
  status: "setup" | "playing" | "finished";
}

interface StoredTurn {
  role: "user" | "assistant";
  text: string;
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

      if (request.method === "GET" && path === "/lore") {
        return await this.lore(meta, new URL(request.url));
      }
      if (request.method === "POST" && path === "/trame") {
        return await this.setTrame(meta, await request.json());
      }
      if (request.method === "POST" && path === "/setup") {
        return await this.setup(meta, await request.json());
      }
      if (request.method === "POST" && path === "/turn") {
        return await this.turn(meta, await request.json());
      }
      if (request.method === "POST" && path === "/roll") {
        return await this.roll(meta, await request.json());
      }
      if (request.method === "POST" && path === "/finish") {
        return await this.finish(meta);
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
      status: "setup",
    };
    const state = initialGameState();
    state.skills = characterSkills;
    // Les lacunes retenues sont conservées telles quelles : chaque réponse du
    // joueur pourra être reliée à sa zone floue d'origine au /finish.
    const setupGaps = selectSetupGaps(scores, openGaps, setupContext(meta));
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
    });
    await this.syncKV(meta, state);

    return json({ setup_questions: questions });
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
    const setupGaps = selectSetupGaps(
      meta.scores,
      openGaps,
      setupContext(meta),
    );
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
    await this.syncKV(meta, (await this.ctx.storage.get<GameState>("state"))!);

    return json({ trame, setup_questions: questions });
  }

  // ── Mise en place → scène 1 ───────────────────────────────────────────

  private async setup(meta: SessionMeta, body: unknown): Promise<Response> {
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
    const state = (await this.ctx.storage.get<GameState>("state"))!;

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
      { becomePlaying: true },
    );
  }

  // ── Tour de jeu ───────────────────────────────────────────────────────

  private async turn(meta: SessionMeta, body: unknown): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const input = (body as { player_input?: unknown }).player_input;
    if (typeof input !== "string" || input.length > MAX_PLAYER_INPUT_CHARS) {
      return json({ error: "invalid_player_input" }, 400);
    }

    const state = (await this.ctx.storage.get<GameState>("state"))!;
    if (state.pending_roll) {
      const request = normalizeRollRequest(state.pending_roll);
      return json(
        { error: "roll_required", request, reason: request.reason },
        409,
      );
    }

    // Le résultat du dernier jet est consommé par ce tour. Une saisie vide
    // n'est valide que pour lui : c'est le tour de continuation post-jet,
    // où le MJ reprend la narration là où il l'avait suspendue.
    const consumedRoll = state.last_roll;
    if (input.trim() === "" && !consumedRoll) {
      return json({ error: "invalid_player_input" }, 400);
    }
    state.last_roll = null;

    const stored = buildTurnMessage(input.trim(), consumedRoll);
    return this.generate(
      meta,
      state,
      { stored, sent: await this.withTurnContext(meta, state, stored) },
      consumedRoll,
    );
  }

  // ── Jet de d6 serveur ─────────────────────────────────────────────────

  private async roll(meta: SessionMeta, body: unknown): Promise<Response> {
    if (meta.status !== "playing") {
      return json({ error: "invalid_status", status: meta.status }, 409);
    }
    const state = (await this.ctx.storage.get<GameState>("state"))!;
    if (state.last_roll) {
      // Anti-triche : pas de relance tant que le résultat n'est pas joué.
      return json({ error: "roll_already_pending" }, 409);
    }

    // Les conditions du jet viennent du MJ (état serveur) : le client ne peut
    // pas se choisir une difficulté ni un avantage. Sa `reason` ne sert que
    // pour un jet libre, hors demande du MJ.
    const bodyReason = (body as { reason?: unknown }).reason;
    const request: RollRequest = state.pending_roll
      ? normalizeRollRequest(state.pending_roll)
      : normalizeRollRequest(
          typeof bodyReason === "string" ? bodyReason : null,
        );

    const result = performRoll(request);
    state.last_roll = result;
    state.pending_roll = null;

    await this.ctx.storage.put("state", state);
    await this.syncKV(meta, state);
    return json(result);
  }

  // ── État public ───────────────────────────────────────────────────────

  private async stateResponse(): Promise<Response> {
    const meta = await this.ctx.storage.get<SessionMeta>("meta");
    if (!meta) return json({ error: "session_not_initialized" }, 409);
    const state = (await this.ctx.storage.get<GameState>("state"))!;
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
    const turns = await this.listTurns(LOG_TURNS);
    return {
      session_id: meta.sessionId,
      status: meta.status,
      format: meta.format,
      trame: meta.trame,
      character: meta.characterName
        ? { name: meta.characterName, sheet: safeParse(meta.characterSheet) }
        : null,
      souffle: state.souffle,
      souffle_max: SOUFFLE_MAX,
      facts: state.facts,
      skills: state.skills ?? [],
      pending_roll: state.pending_roll
        ? normalizeRollRequest(state.pending_roll)
        : null,
      last_roll: state.last_roll,
      turn_count: state.turn_count,
      log: turns.map((t) => ({
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

    const state = (await this.ctx.storage.get<GameState>("state"))!;
    // Le résumé profite du contexte serveur (faits, compétences) mais pas des
    // extraits RAG (inutiles pour synthétiser ce qui s'est joué).
    const messages = await this.buildMessages(
      buildTurnContext(state) + "\n\n" + SUMMARY_MESSAGE,
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

    // Arbre de compétences : les acquis de la session rejoignent le
    // personnage (fusion sans régression) — la prochaine session repart avec.
    if (meta.characterId && (state.skills ?? []).length > 0) {
      const row = await this.env.DB.prepare(
        `SELECT skills_json FROM characters WHERE id = ?`,
      )
        .bind(meta.characterId)
        .first<{ skills_json: string | null }>();
      if (row) {
        let saved: SkillEntry[] = [];
        try {
          saved = sanitizeSkills(JSON.parse(row.skills_json ?? "[]"));
        } catch {
          saved = [];
        }
        await this.env.DB.prepare(
          `UPDATE characters SET skills_json = ? WHERE id = ?`,
        )
          .bind(
            JSON.stringify(mergeSkills(saved, state.skills ?? [])),
            meta.characterId,
          )
          .run();
      }
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

  // ── Génération streamée (setup et turn) ───────────────────────────────

  private async generate(
    meta: SessionMeta,
    state: GameState,
    // sent : contexte de tour + saisie, envoyé au modèle ; stored : saisie
    // seule, persistée dans l'historique (préfixe stable → cache de prompt).
    text: { sent: string; stored: string },
    consumedRoll: RollResult | null = null,
    opts: { becomePlaying?: boolean } = {},
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
  ): Promise<void> {
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (event: string, data: unknown) =>
      writer.write(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );

    try {
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
      const inventions =
        (await this.ctx.storage.get<Invention[]>("inventions")) ?? [];
      let raw = "";

      const handle = async (chunk: {
        text: string;
        events: GmTagEvent[];
      }): Promise<void> => {
        if (chunk.text) await send("narration", { text: chunk.text });
        for (const event of chunk.events) {
          switch (event.type) {
            case "roll_request":
              state.pending_roll = event.request;
              await send("state_patch", { pending_roll: event.request });
              break;
            case "souffle_delta":
              state.souffle = applySouffleDelta(state.souffle, event.delta);
              await send("state_patch", { souffle: state.souffle });
              break;
            case "scene_break":
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
            case "skill_update":
              // Mémoire longue : la compétence survit à la fenêtre d'historique.
              state.skills ??= [];
              if (
                applySkillUpdate(
                  state.skills,
                  event.name,
                  event.tier,
                  event.note,
                )
              ) {
                await send("state_patch", { skills: state.skills });
              }
              break;
            case "fact":
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
        }
      }
      await handle(parser.flush());

      // Garde-fou de fin de tour (§7) : si le tour retombe fermé (ni question
      // ni options) ET qu'aucun jet n'est en attente, on relance le modèle
      // pour une vraie relance — filet best-effort, invisible pour le joueur.
      if (!state.pending_roll && !turnEndsOpen(stripGmTags(raw))) {
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
      state.turn_count += 1;
      if (becomePlaying) meta.status = "playing";
      await this.ctx.storage.put({
        [turnKey(stored)]: { role: "user", text: storedText } as StoredTurn,
        [turnKey(stored + 1)]: { role: "assistant", text: raw } as StoredTurn,
        turn_count_stored: stored + 2,
        state,
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
      await this.syncKV(meta, state);

      await send("done", { turn: state.turn_count, souffle: state.souffle });
    } catch (err) {
      console.error(`[game-session] génération ${meta.sessionId} :`, err);
      try {
        await send("error", { error: "generation_failed" });
      } catch {
        // flux déjà fermé côté client
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // idem
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

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
    const narration = (await this.listTurns(CONTEXT_TURNS))
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
    return buildTurnContext(state, canonExcerpts) + "\n\n" + storedText;
  }

  /**
   * Historique stocké + nouveau message utilisateur, fenêtré. Le dernier tour
   * stocké porte le point de cache : à la requête suivante, tout le préfixe
   * (system + historique) est relu depuis le cache, seuls le nouveau tour et
   * le contexte volatile sont facturés plein tarif.
   */
  private async buildMessages(
    sentText: string,
  ): Promise<Anthropic.MessageParam[]> {
    const turns = await this.listTurns(CONTEXT_TURNS);
    return [
      ...turns.map((t, i): Anthropic.MessageParam => ({
        role: t.role,
        content:
          i === turns.length - 1 && t.text !== ""
            ? [{ type: "text", text: t.text, cache_control: CACHE_CONTROL }]
            : t.text,
      })),
      { role: "user" as const, content: sentText },
    ];
  }

  private async listTurns(limit: number): Promise<StoredTurn[]> {
    const map = await this.ctx.storage.list<StoredTurn>({
      prefix: "turn:",
      reverse: true,
      limit,
    });
    return [...map.values()].reverse();
  }
}

function safeParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
