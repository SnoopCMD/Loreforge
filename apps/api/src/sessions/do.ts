// Durable Object GameSession : un DO = une session de jeu (SPEC §2).
// Toute mutation d'état passe par lui ; D1 ne reçoit que les transitions
// de statut et le résumé final ; KV sert de cache chaud de l'état public.
//
// API interne (appelée uniquement par les routes worker, déjà authentifiées) :
//   POST /init    {sessionId, userId, bibleId, characterId, format, trame}
//   POST /setup   {answers[]}      → SSE (scène 1)
//   POST /turn    {player_input}   → SSE
//   POST /roll    {reason?}        → JSON {value, outcome, reason}
//   GET  /state                    → JSON état public
//   POST /finish                   → JSON {summary_md, inventions}

import { DurableObject } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { RichnessGap, RichnessScores } from "../richness/logic";
import {
  applySouffleDelta,
  initialGameState,
  outcomeForRoll,
  rollD6,
  SOUFFLE_MAX,
  type GameState,
  type RollResult,
} from "./rules";
import { GmStreamParser, stripGmTags, type GmTagEvent } from "./tags";
import { resolveLore } from "./lore";
import { retrieveCanonExcerpts } from "../rag/store";
import {
  buildSetupMessage,
  buildSetupQuestions,
  buildSystemPrompt,
  buildTurnMessage,
  RELANCE_MESSAGE,
  SUMMARY_MESSAGE,
  turnEndsOpen,
} from "./prompt";

export const NARRATION_MODEL = "claude-sonnet-5";
const MAX_NARRATION_TOKENS = 2048;
const MAX_PLAYER_INPUT_CHARS = 4000;
const MAX_ANSWERS = 10;
// Fenêtre de contexte : derniers tours envoyés au modèle.
const CONTEXT_TURNS = 40;
const LOG_TURNS = 20;
// Relance de fin de tour (§7) : court, sans retry (filet best-effort).
const MAX_RELANCE_TOKENS = 256;
// Cache des fiches lore résolues (une semaine).
const LORE_TTL_SECONDS = 60 * 60 * 24 * 7;

export function sessionKvKey(sessionId: string): string {
  return `session:${sessionId}:state`;
}

export function loreKvKey(sessionId: string, term: string): string {
  return `lore:${sessionId}:${term.toLowerCase()}`;
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
  scores: RichnessScores | null;
  gaps: RichnessGap[];
  format: string;
  trame: string | null;
  status: "setup" | "playing" | "finished";
}

interface StoredTurn {
  role: "user" | "assistant";
  text: string;
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

      const meta = await this.ctx.storage.get<SessionMeta>("meta");
      if (!meta) return json({ error: "session_not_initialized" }, 409);

      if (request.method === "GET" && path === "/lore") {
        return await this.lore(meta, new URL(request.url));
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

    let characterName: string | null = null;
    let characterSheet: string | null = null;
    if (payload.characterId) {
      const character = await this.env.DB.prepare(
        `SELECT name, sheet_json FROM characters WHERE id = ?`,
      )
        .bind(payload.characterId)
        .first<{ name: string; sheet_json: string }>();
      if (!character) return json({ error: "character_not_found" }, 400);
      characterName = character.name;
      characterSheet = character.sheet_json;
    }

    const meta: SessionMeta = {
      sessionId: payload.sessionId,
      userId: payload.userId,
      bibleId: payload.bibleId,
      characterId: payload.characterId,
      characterName,
      characterSheet,
      bibleTitle: bible.title,
      toneProfile: bible.tone_profile,
      scores,
      gaps,
      format: payload.format,
      trame: payload.trame,
      status: "setup",
    };
    const state = initialGameState();
    const questions = buildSetupQuestions(scores, gaps);

    this.canonCache = bible.canon_md;
    await this.ctx.storage.put({
      meta,
      state,
      setup_questions: questions,
      inventions: [] as Invention[],
      turn_count_stored: 0,
    });
    await this.syncKV(meta, state);

    return json({ setup_questions: questions });
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

    const questions =
      (await this.ctx.storage.get<string[]>("setup_questions")) ?? [];
    const state = (await this.ctx.storage.get<GameState>("state"))!;

    // Les réponses deviennent des faits établis de la session (en mémoire :
    // elles ne sont persistées qu'au succès de la scène 1, voir becomePlaying).
    questions.forEach((q, i) => {
      const answer = (answers[i] as string | undefined)?.trim();
      if (answer) state.facts.push(`${q} → ${answer}`);
    });

    // Le passage en 'playing' n'est commité qu'à la fin de la génération : une
    // scène 1 interrompue laisse la session en 'setup', donc rejouable via
    // POST /setup (le dernier état validé reste l'avant-setup, §résilience).
    return this.generate(
      meta,
      state,
      buildSetupMessage(questions, answers),
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
      return json({ error: "roll_required", reason: state.pending_roll }, 409);
    }

    // Le résultat du dernier jet est consommé par ce tour. Une saisie vide
    // n'est valide que pour lui : c'est le tour de continuation post-jet,
    // où le MJ reprend la narration là où il l'avait suspendue.
    const consumedRoll = state.last_roll;
    if (input.trim() === "" && !consumedRoll) {
      return json({ error: "invalid_player_input" }, 400);
    }
    state.last_roll = null;

    return this.generate(
      meta,
      state,
      buildTurnMessage(input.trim(), consumedRoll),
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

    const bodyReason = (body as { reason?: unknown }).reason;
    const reason =
      (typeof bodyReason === "string" && bodyReason.trim().slice(0, 200)) ||
      state.pending_roll ||
      "action risquée";

    const value = rollD6();
    const result: RollResult = { value, outcome: outcomeForRoll(value), reason };
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
      pending_roll: state.pending_roll,
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
            : t.text.replace(/^\[Jet d6 [^\]]*\]\s*/, ""),
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
    const messages = await this.buildMessages(SUMMARY_MESSAGE);
    const system = await this.systemPrompt(meta, state);

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
        created_at: now,
      }));
    if (proposals.length > 0) {
      const stmt = this.env.DB.prepare(
        `INSERT INTO canon_proposals
           (id, session_id, bible_id, content_md, axis, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      );
      await this.env.DB.batch(
        proposals.map((p) =>
          stmt.bind(p.id, p.session_id, p.bible_id, p.content_md, p.axis, p.created_at),
        ),
      );
    }
    return json({ summary_md: summaryMd, inventions, proposals });
  }

  // ── Génération streamée (setup et turn) ───────────────────────────────

  private async generate(
    meta: SessionMeta,
    state: GameState,
    userText: string,
    consumedRoll: RollResult | null = null,
    opts: { becomePlaying?: boolean } = {},
  ): Promise<Response> {
    if (!this.env.ANTHROPIC_API_KEY) {
      return json({ error: "narrator_not_configured" }, 503);
    }
    const system = await this.systemPrompt(meta, state, userText);
    const messages = await this.buildMessages(userText);

    const { readable, writable } = new TransformStream();
    // Le DO reste actif tant que la réponse streamée est ouverte.
    void this.pump(
      writable,
      meta,
      state,
      userText,
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
    userText: string,
    system: string,
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
              state.pending_roll = event.reason;
              await send("state_patch", { pending_roll: event.reason });
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
        [turnKey(stored)]: { role: "user", text: userText } as StoredTurn,
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

  // ── Fiche lore (§7) : résolue une fois par session, cachée en KV ──────────

  private async lore(meta: SessionMeta, url: URL): Promise<Response> {
    const term = (url.searchParams.get("term") ?? "").trim().slice(0, 120);
    if (!term) return json({ error: "missing_term" }, 400);

    const key = loreKvKey(meta.sessionId, term);
    const cached = await this.env.CACHE.get(key);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const canon = await this.ensureCanon(meta.bibleId);
    const inventions =
      (await this.ctx.storage.get<Invention[]>("inventions")) ?? [];
    const fiche = resolveLore(
      canon,
      inventions,
      term,
      url.searchParams.get("kind"),
    );
    const payload = JSON.stringify({ ...fiche, bible_id: meta.bibleId });
    // Best-effort : un échec de cache ne doit pas priver le joueur de la fiche.
    try {
      await this.env.CACHE.put(key, payload, { expirationTtl: LORE_TTL_SECONDS });
    } catch (err) {
      console.error(`[game-session] cache lore ${meta.sessionId} :`, err);
    }
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private async systemPrompt(
    meta: SessionMeta,
    state: GameState,
    queryText = "",
  ): Promise<string> {
    const canon = await this.ensureCanon(meta.bibleId);
    // RAG (M6) : bible volumineuse → top-6 d'extraits re-rankés pour ce
    // tour ; null (bindings absents, index périmé...) → troncature.
    const canonExcerpts = await retrieveCanonExcerpts(
      this.env,
      meta.bibleId,
      canon,
      queryText || (meta.trame ?? meta.bibleTitle),
      {
        trame: meta.trame,
        names: [
          ...(meta.characterName ? [meta.characterName] : []),
          ...state.facts.slice(-5),
        ],
      },
      (p) => this.ctx.waitUntil(p),
    );
    return buildSystemPrompt({
      bibleTitle: meta.bibleTitle,
      canonMd: canon,
      canonExcerpts,
      scores: meta.scores,
      gaps: meta.gaps,
      toneProfile: meta.toneProfile,
      characterName: meta.characterName,
      characterSheet: meta.characterSheet,
      format: meta.format,
      trame: meta.trame,
      state,
    });
  }

  /** Historique stocké + nouveau message utilisateur, fenêtré. */
  private async buildMessages(
    userText: string,
  ): Promise<Anthropic.MessageParam[]> {
    const turns = await this.listTurns(CONTEXT_TURNS);
    return [
      ...turns.map((t) => ({ role: t.role, content: t.text })),
      { role: "user" as const, content: userText },
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
