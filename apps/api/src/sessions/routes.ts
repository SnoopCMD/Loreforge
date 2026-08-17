// Routes /api/sessions (SPEC §5) : validation + propriété côté worker,
// puis délégation au Durable Object GameSession (un DO par session).

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";
import { parsePalette, serializePalette } from "../bibles/palette";
import { loreKvPrefix, normalizeTrame, sessionKvKey } from "./do";

const FORMATS = ["oneshot", "mini", "campaign"] as const;
const CHARACTER_MODES = ["embody_canon", "embody_quiz", "create"] as const;

export const sessions = new Hono<AppEnv>();

sessions.use("*", requireAuth);

interface GameSessionRow {
  id: string;
  bible_id: string;
  user_id: string;
  character_id: string | null;
  format: string;
  trame: string | null;
  status: string;
  summary_md: string | null;
  created_at: number;
  finished_at: number | null;
  palette_json: string | null;
}

// POST /api/sessions — { bible_id, character_id?, format, trame? }
// → crée le DO, retourne { session_id, setup_questions[] }.
sessions.post("/", async (c) => {
  let body: {
    bible_id?: unknown;
    character_id?: unknown;
    character_mode?: unknown;
    format?: unknown;
    trame?: unknown;
    palette?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (typeof body.bible_id !== "string") {
    return c.json({ error: "missing_bible_id" }, 400);
  }
  if (
    typeof body.format !== "string" ||
    !(FORMATS as readonly string[]).includes(body.format)
  ) {
    return c.json({ error: "invalid_format" }, 400);
  }
  // Fil rouge : facultatif ici — le joueur peut aussi le poser à la mise en
  // place, une fois son personnage choisi (POST /:id/setup).
  const trame = normalizeTrame(body.trame);
  if (trame === undefined) return c.json({ error: "invalid_trame" }, 400);
  const characterId =
    body.character_id === undefined || body.character_id === null
      ? null
      : typeof body.character_id === "string"
        ? body.character_id
        : undefined;
  if (characterId === undefined) {
    return c.json({ error: "invalid_character_id" }, 400);
  }
  // character_mode (§6bis) : informatif — la voie choisie ne change rien au
  // moteur, la fiche finale a la même structure quelle que soit l'origine.
  if (
    body.character_mode !== undefined &&
    !(CHARACTER_MODES as readonly string[]).includes(
      body.character_mode as string,
    )
  ) {
    return c.json({ error: "invalid_character_mode" }, 400);
  }

  // Palette d'ambiance (§8) : facultative, modifiable en cours de partie.
  let paletteJson: string | null = null;
  if (body.palette !== undefined && body.palette !== null) {
    paletteJson = serializePalette(body.palette);
    if (paletteJson === null) return c.json({ error: "invalid_palette" }, 400);
  }

  const user = c.get("user");
  const bible = await findOwnedBible(c.env.DB, body.bible_id, user.id);
  if (!bible) return c.json({ error: "bible_not_found" }, 404);
  if (!bible.canon_md) return c.json({ error: "empty_bible" }, 400);

  if (characterId) {
    const character = await c.env.DB.prepare(
      `SELECT id FROM characters WHERE id = ? AND user_id = ? AND bible_id = ?`,
    )
      .bind(characterId, user.id, bible.id)
      .first();
    if (!character) return c.json({ error: "character_not_found" }, 404);
  }

  const doId = c.env.GAME_SESSIONS.newUniqueId();
  const sessionId = doId.toString();
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO game_sessions
       (id, bible_id, user_id, character_id, format, trame, status, created_at, palette_json)
     VALUES (?, ?, ?, ?, ?, ?, 'setup', ?, ?)`,
  )
    .bind(
      sessionId,
      bible.id,
      user.id,
      characterId,
      body.format,
      trame,
      now,
      paletteJson,
    )
    .run();

  const stub = c.env.GAME_SESSIONS.get(doId);
  const res = await stub.fetch("https://do/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      userId: user.id,
      bibleId: bible.id,
      characterId,
      format: body.format,
      trame,
    }),
  });
  if (!res.ok) {
    // Init impossible (bible vidée entre-temps...) : pas de ligne orpheline.
    await c.env.DB.prepare(`DELETE FROM game_sessions WHERE id = ?`)
      .bind(sessionId)
      .run();
    return c.json({ error: "session_init_failed" }, 500);
  }

  const { setup_questions } = (await res.json()) as {
    setup_questions: string[];
  };
  return c.json({ session_id: sessionId, setup_questions }, 201);
});

// GET /api/sessions?bible_id= — sessions de l'utilisateur pour une bible ;
// sans bible_id : toutes ses sessions (accueil, reprise rapide).
sessions.get("/", async (c) => {
  const bibleId = c.req.query("bible_id");
  const user = c.get("user");

  if (bibleId) {
    const bible = await findOwnedBible(c.env.DB, bibleId, user.id);
    if (!bible) return c.json({ error: "bible_not_found" }, 404);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT gs.id, gs.bible_id, b.title AS bible_title,
            gs.character_id, ch.name AS character_name, gs.format,
            gs.trame, gs.status, gs.created_at, gs.finished_at, gs.palette_json
     FROM game_sessions gs
     JOIN bibles b ON b.id = gs.bible_id
     LEFT JOIN characters ch ON ch.id = gs.character_id
     WHERE gs.user_id = ? AND (? IS NULL OR gs.bible_id = ?)
     ORDER BY gs.created_at DESC`,
  )
    .bind(user.id, bibleId ?? null, bibleId ?? null)
    .all<Record<string, unknown>>();

  // La palette voyage décodée : le client la pose telle quelle en variables CSS.
  const sessions = results.map(({ palette_json, ...row }) => ({
    ...row,
    palette: parsePalette(palette_json),
  }));
  return c.json({ sessions });
});

async function loadOwnedSession(
  db: D1Database,
  id: string,
  userId: string,
): Promise<GameSessionRow | null> {
  return db
    .prepare(`SELECT * FROM game_sessions WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<GameSessionRow>();
}

/** Proxy d'un endpoint du DO ; le corps de la requête est transmis tel quel. */
function proxy(path: string) {
  return async (c: Context<AppEnv, "/:id">): Promise<Response> => {
    const row = await loadOwnedSession(
      c.env.DB,
      c.req.param("id"),
      c.get("user").id,
    );
    if (!row) return c.json({ error: "not_found" }, 404);

    const stub = c.env.GAME_SESSIONS.get(
      c.env.GAME_SESSIONS.idFromString(row.id),
    );
    return stub.fetch(new Request(`https://do${path}`, c.req.raw));
  };
}

// GET /api/sessions/:id/palette — ambiance en cours (null = DA par défaut).
// Vit en D1 et non dans le DO : c'est une préférence d'affichage, pas de la
// fiction — elle survit donc au refresh sans réveiller le Durable Object.
sessions.get("/:id/palette", async (c) => {
  const row = await loadOwnedSession(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ palette: parsePalette(row.palette_json) });
});

// PUT /api/sessions/:id/palette — { palette } pour changer d'ambiance en cours
// de partie, ou { palette: null } pour revenir à la DA par défaut.
sessions.put("/:id/palette", async (c) => {
  const row = await loadOwnedSession(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!row) return c.json({ error: "not_found" }, 404);

  let body: { palette?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (body.palette === undefined) return c.json({ error: "empty_patch" }, 400);

  let paletteJson: string | null = null;
  if (body.palette !== null) {
    paletteJson = serializePalette(body.palette);
    if (paletteJson === null) return c.json({ error: "invalid_palette" }, 400);
  }

  await c.env.DB.prepare(`UPDATE game_sessions SET palette_json = ? WHERE id = ?`)
    .bind(paletteJson, row.id)
    .run();
  return c.json({ palette: parsePalette(paletteJson) });
});

sessions.post("/:id/trame", proxy("/trame"));
sessions.post("/:id/setup", proxy("/setup"));
sessions.post("/:id/turn", proxy("/turn"));
sessions.post("/:id/roll", proxy("/roll"));
sessions.post("/:id/finish", proxy("/finish"));

// DELETE /api/sessions/:id — efface une session et tout ce qu'elle a laissé :
// storage du DO (historique, faits, inventions), caches KV, propositions de
// canon issues d'elle, puis la ligne D1. Le canon déjà accepté, lui, reste —
// il appartient à la bible. Les compétences déjà versées au personnage aussi.
sessions.delete("/:id", async (c) => {
  const row = await loadOwnedSession(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!row) return c.json({ error: "not_found" }, 404);

  const stub = c.env.GAME_SESSIONS.get(
    c.env.GAME_SESSIONS.idFromString(row.id),
  );
  // Best-effort : un DO injoignable ne doit pas bloquer la suppression D1,
  // sinon la session resterait affichée sans moyen de s'en débarrasser.
  try {
    await stub.fetch("https://do/destroy", { method: "POST" });
  } catch (err) {
    console.error(`[sessions] purge du DO ${row.id} :`, err);
  }

  // Une lacune répondue par cette session redevient ouverte : sa proposition
  // en attente disparaît, la question reviendra à la prochaine mise en place.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM canon_proposals WHERE session_id = ?`).bind(
      row.id,
    ),
    c.env.DB.prepare(`DELETE FROM game_sessions WHERE id = ?`).bind(row.id),
  ]);

  c.executionCtx.waitUntil(purgeSessionCache(c.env.CACHE, row.id));
  return c.json({ ok: true });
});

/** Caches KV d'une session : état public + fiches lore résolues. */
async function purgeSessionCache(
  cache: KVNamespace,
  sessionId: string,
): Promise<void> {
  try {
    await cache.delete(sessionKvKey(sessionId));
    const prefix = loreKvPrefix(sessionId);
    let cursor: string | undefined;
    do {
      const page = await cache.list({ prefix, cursor });
      await Promise.all(page.keys.map((k) => cache.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    // Les fiches lore expirent d'elles-mêmes (TTL) : pas de quoi échouer.
    console.error(`[sessions] purge du cache ${sessionId} :`, err);
  }
}

// GET /api/sessions/:id/lore?term=&kind= — fiche d'un terme d'univers (§7).
// Handler dédié : le proxy générique perdrait la query string.
sessions.get("/:id/lore", async (c) => {
  const row = await loadOwnedSession(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!row) return c.json({ error: "not_found" }, 404);

  const qs = new URLSearchParams({
    term: c.req.query("term") ?? "",
    kind: c.req.query("kind") ?? "",
  }).toString();
  const stub = c.env.GAME_SESSIONS.get(
    c.env.GAME_SESSIONS.idFromString(row.id),
  );
  return stub.fetch(`https://do/lore?${qs}`);
});

// GET /api/sessions/:id/state — cache chaud KV, sinon DO (qui repeuple KV).
sessions.get("/:id/state", async (c) => {
  const row = await loadOwnedSession(
    c.env.DB,
    c.req.param("id"),
    c.get("user").id,
  );
  if (!row) return c.json({ error: "not_found" }, 404);

  if (row.status !== "finished") {
    const cached = await c.env.CACHE.get(sessionKvKey(row.id));
    if (cached) {
      return c.body(cached, 200, { "content-type": "application/json" });
    }
  }

  const stub = c.env.GAME_SESSIONS.get(
    c.env.GAME_SESSIONS.idFromString(row.id),
  );
  const res = await stub.fetch("https://do/state");
  if (row.status !== "finished" || !res.ok) return res;

  // Session finie : le KV est purgé et le snapshot du DO n'a pas le résumé —
  // on le fusionne depuis D1 pour que l'écran de fin survive au refresh.
  const snapshot = (await res.json()) as Record<string, unknown>;
  snapshot.summary_md = row.summary_md;
  return c.json(snapshot);
});
