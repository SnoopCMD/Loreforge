// Routes /api/sessions (SPEC §5) : validation + propriété côté worker,
// puis délégation au Durable Object GameSession (un DO par session).

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { findOwnedBible } from "../bibles/db";
import { parsePalette, serializePalette } from "../bibles/palette";
import { loreKvPrefix, normalizeTrame, sessionKvKey } from "./do";
import { suggestTrames } from "./trame";
import { purgeSessionAudio } from "../tts/cartesia";
import {
  generateInviteCode,
  INVITE_MAX_USES,
  INVITE_TTL_MS,
  listMembers,
  loadSessionAccess,
  normalizeInviteCode,
  SESSION_MODES,
  type SessionAccess,
} from "./members";

const FORMATS = ["oneshot", "mini", "campaign"] as const;
const CHARACTER_MODES = ["embody_canon", "embody_quiz", "create"] as const;

export const sessions = new Hono<AppEnv>();

sessions.use("*", requireAuth);

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
    mode?: unknown;
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

  // Mode : solo par défaut. Une table ne change pas de moteur — seulement la
  // politique de tour, l'interface et les permissions.
  const mode = body.mode === undefined ? "solo" : body.mode;
  if (typeof mode !== "string" || !(SESSION_MODES as readonly string[]).includes(mode)) {
    return c.json({ error: "invalid_mode" }, 400);
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

  // La session et son hôte naissent ensemble : sans la ligne de membre,
  // l'auteur n'aurait pas accès à sa propre partie une seconde plus tard.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO game_sessions
         (id, bible_id, user_id, character_id, format, trame, status, created_at, palette_json, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sessionId,
      bible.id,
      user.id,
      characterId,
      body.format,
      trame,
      // Une table se retrouve d'abord dans un lobby ; le solo attaque
      // directement sa mise en place.
      mode === "table" ? "lobby" : "setup",
      now,
      paletteJson,
      mode,
    ),
    c.env.DB.prepare(
      `INSERT INTO session_members
         (session_id, user_id, character_id, role, joined_at)
       VALUES (?, ?, ?, 'host', ?)`,
    ).bind(sessionId, user.id, characterId, now),
  ]);

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
      mode,
    }),
  });
  if (!res.ok) {
    // Init impossible (bible vidée entre-temps...) : pas de ligne orpheline.
    // Le membre part d'abord, il référence la session.
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM session_members WHERE session_id = ?`).bind(
        sessionId,
      ),
      c.env.DB.prepare(`DELETE FROM game_sessions WHERE id = ?`).bind(sessionId),
    ]);
    return c.json({ error: "session_init_failed" }, 500);
  }

  const { setup_questions } = (await res.json()) as {
    setup_questions: string[];
  };
  return c.json({ session_id: sessionId, mode, setup_questions }, 201);
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

  // Les sessions où l'on est ASSIS, pas seulement celles qu'on a créées : un
  // invité doit retrouver la partie qu'il a rejointe sur son accueil.
  const { results } = await c.env.DB.prepare(
    `SELECT gs.id, gs.bible_id, b.title AS bible_title,
            sm.character_id, ch.name AS character_name, gs.format,
            gs.trame, gs.status, gs.mode, sm.role, gs.created_at,
            gs.finished_at, gs.palette_json
     FROM session_members sm
     JOIN game_sessions gs ON gs.id = sm.session_id
     JOIN bibles b ON b.id = gs.bible_id
     LEFT JOIN characters ch ON ch.id = sm.character_id
     WHERE sm.user_id = ? AND (? IS NULL OR gs.bible_id = ?)
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

/**
 * Accès d'un membre à une session, ou null. Toutes les routes passent par là :
 * un seul oubli, et un joueur invité prend un 404 sur une partie où il est
 * assis. `opts.host` réserve le geste à l'hôte (403 sinon).
 */
async function access(
  c: Context<AppEnv>,
  opts: { host?: boolean } = {},
): Promise<SessionAccess | Response> {
  const found = await loadSessionAccess(
    c.env.DB,
    c.req.param("id")!,
    c.get("user").id,
  );
  if (!found) return c.json({ error: "not_found" }, 404);
  if (opts.host && found.role !== "host") {
    return c.json({ error: "host_only" }, 403);
  }
  return found;
}

/** `access()` a-t-il rendu une erreur plutôt qu'un accès ? */
function denied(result: SessionAccess | Response): result is Response {
  return result instanceof Response;
}

/** Proxy d'un endpoint du DO ; le corps de la requête est transmis tel quel. */
function proxy(path: string, opts: { host?: boolean } = {}) {
  return async (c: Context<AppEnv, "/:id">): Promise<Response> => {
    const found = await access(c, opts);
    if (denied(found)) return found;

    // Le DO a besoin de savoir QUI agit : la narration part en SSE à l'auteur
    // du tour et en WebSocket au reste de la table, et l'auteur ne doit pas
    // recevoir les deux. Ces en-têtes sont posés par le Worker, seul à pouvoir
    // joindre le DO — ils ne viennent jamais du client.
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-lf-user-id", c.get("user").id);
    headers.set("x-lf-role", found.role);
    headers.set("x-lf-character-id", found.characterId ?? "");

    const stub = c.env.GAME_SESSIONS.get(
      c.env.GAME_SESSIONS.idFromString(found.row.id),
    );
    return stub.fetch(
      new Request(`https://do${path}`, {
        method: c.req.method,
        headers,
        body: c.req.raw.body,
      }),
    );
  };
}

// GET /api/sessions/:id/palette — ambiance en cours (null = DA par défaut).
// Vit en D1 et non dans le DO : c'est une préférence d'affichage, pas de la
// fiction — elle survit donc au refresh sans réveiller le Durable Object.
sessions.get("/:id/palette", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;
  return c.json({ palette: parsePalette(found.row.palette_json) });
});

// PUT /api/sessions/:id/palette — { palette } pour changer d'ambiance en cours
// de partie, ou { palette: null } pour revenir à la DA par défaut.
sessions.put("/:id/palette", async (c) => {
  // Hôte seulement : l'ambiance s'applique à toute la table.
  const found = await access(c, { host: true });
  if (denied(found)) return found;
  const row = found.row;

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

// Mise en place et fin de partie : gestes d'hôte. Jouer un tour et lancer un
// dé, eux, appartiennent à tout membre de la table.
// ── Membres et invitations (M8 lot 8.1) ──────────────────────────────────

// POST /api/sessions/:id/invite (hôte) → { code, expires_at }.
// Un nouveau code n'invalide pas les précédents : on peut relancer un joueur
// qui a perdu le sien sans casser l'invitation des autres.
sessions.post("/:id/invite", async (c) => {
  const found = await access(c, { host: true });
  if (denied(found)) return found;
  if (found.row.status === "finished") {
    return c.json({ error: "session_finished" }, 409);
  }

  const now = Date.now();
  const code = generateInviteCode();
  const expiresAt = now + INVITE_TTL_MS;
  await c.env.DB.prepare(
    `INSERT INTO session_invites
       (code, session_id, created_by, expires_at, max_uses, uses, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(code, found.row.id, c.get("user").id, expiresAt, INVITE_MAX_USES, now)
    .run();

  return c.json({ code, expires_at: expiresAt, max_uses: INVITE_MAX_USES }, 201);
});

// POST /api/sessions/join { code } → rejoint la table.
// Pas de :id dans l'URL : celui qui rejoint ne connaît que le code.
sessions.post("/join", async (c) => {
  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const code = normalizeInviteCode(body.code);
  if (!code) return c.json({ error: "invalid_code" }, 400);

  const invite = await c.env.DB.prepare(
    `SELECT i.code, i.session_id, i.expires_at, i.max_uses, i.uses,
            gs.status, gs.mode
     FROM session_invites i
     JOIN game_sessions gs ON gs.id = i.session_id
     WHERE i.code = ?`,
  )
    .bind(code)
    .first<{
      code: string;
      session_id: string;
      expires_at: number;
      max_uses: number;
      uses: number;
      status: string;
      mode: string;
    }>();
  if (!invite) return c.json({ error: "invalid_code" }, 404);
  if (invite.expires_at < Date.now() || invite.uses >= invite.max_uses) {
    return c.json({ error: "code_expired" }, 410);
  }
  if (invite.status === "finished") {
    return c.json({ error: "session_finished" }, 409);
  }

  const user = c.get("user");
  // Déjà membre : on ne consomme pas d'usage, et rejoindre reste idempotent
  // (un lien recliqué ne doit pas épuiser le code de la table).
  const existing = await loadSessionAccess(c.env.DB, invite.session_id, user.id);
  if (existing) {
    return c.json({ session_id: invite.session_id, role: existing.role });
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO session_members
         (session_id, user_id, character_id, role, joined_at)
       VALUES (?, ?, NULL, 'player', ?)`,
    ).bind(invite.session_id, user.id, Date.now()),
    // L'usage est décompté au même endroit : un code épuisé l'est vraiment,
    // même si deux joueurs cliquent en même temps.
    c.env.DB.prepare(
      `UPDATE session_invites SET uses = uses + 1 WHERE code = ?`,
    ).bind(code),
  ]);

  return c.json({ session_id: invite.session_id, role: "player" }, 201);
});

// GET /api/sessions/:id/members — qui est à la table, et avec quel personnage.
sessions.get("/:id/members", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;
  return c.json({
    members: await listMembers(c.env.DB, found.row.id),
    mode: found.row.mode,
    role: found.role,
  });
});

// DELETE /api/sessions/:id/members/:userId — l'hôte exclut, chacun part.
// L'hôte ne peut pas se retirer lui-même : une table sans hôte n'aurait plus
// personne pour la lancer, la clore ou inviter.
sessions.delete("/:id/members/:userId", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;

  const target = c.req.param("userId");
  const self = c.get("user").id;
  if (target !== self && found.role !== "host") {
    return c.json({ error: "host_only" }, 403);
  }
  if (target === found.row.user_id) {
    return c.json({ error: "host_cannot_leave" }, 409);
  }

  const res = await c.env.DB.prepare(
    `DELETE FROM session_members WHERE session_id = ? AND user_id = ?`,
  )
    .bind(found.row.id, target)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_a_member" }, 404);
  return c.json({ ok: true });
});

// GET /api/sessions/:id/ws — la table en direct.
//
// L'authentification se fait ICI, sur la requête d'upgrade : c'est une requête
// HTTP same-origin normale, le cookie y est présent, requireAuth s'y applique
// tel quel. On ne fait donc JAMAIS confiance à un identifiant envoyé dans un
// message WebSocket ensuite — l'identité est figée au moment de l'upgrade.
sessions.get("/:id/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected_websocket" }, 426);
  }
  const found = await access(c);
  if (denied(found)) return found;

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-lf-user-id", c.get("user").id);
  headers.set("x-lf-role", found.role);
  headers.set("x-lf-character-id", found.characterId ?? "");

  return stubFor(c, found.row.id).fetch(
    new Request("https://do/ws", { method: "GET", headers }),
  );
});

// POST /api/sessions/:id/start (hôte) — lance la partie depuis le lobby, ou
// rassemble la table sur une partie déjà en cours.
sessions.post("/:id/start", async (c) => {
  const found = await access(c, { host: true });
  if (denied(found)) return found;

  // Un membre sans personnage bloque le lancement, avec de quoi agir : dire
  // « il manque quelqu'un » sans dire qui ne sert à rien.
  const members = await listMembers(c.env.DB, found.row.id);
  const sansFiche = members.filter((m) => !m.character_id);
  if (sansFiche.length > 0) {
    return c.json(
      {
        error: "members_without_character",
        members: sansFiche.map((m) => ({
          user_id: m.user_id,
          display_name: m.display_name ?? m.email,
        })),
      },
      409,
    );
  }

  return stubFor(c, found.row.id).fetch("https://do/start", { method: "POST" });
});

// PUT /api/sessions/:id/members/me — je choisis (ou change) mon personnage.
//
// Changer de fiche EN COURS de partie est refusé : l'état de jeu est indexé
// par personnage, et le Souffle déjà dépensé resterait sur l'ancien. Mais
// s'asseoir quand on n'a encore personne reste possible à tout moment — un
// joueur invité après le lancement doit pouvoir rejoindre la table, sinon il
// jouerait sans fiche, ce que le serveur refuse par ailleurs.
sessions.put("/:id/members/me", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;
  const enPlace = found.row.status === "lobby" || found.row.status === "setup";
  if (!enPlace && found.characterId) {
    return c.json({ error: "character_already_chosen" }, 409);
  }
  if (found.row.status === "finished") {
    return c.json({ error: "invalid_status", status: found.row.status }, 409);
  }

  let body: { character_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const characterId = body.character_id;
  if (typeof characterId !== "string") {
    return c.json({ error: "invalid_character_id" }, 400);
  }

  // La fiche doit appartenir à l'UNIVERS joué, plus au joueur : à une table on
  // incarne un personnage de la bible, fût-il écrit par quelqu'un d'autre. On
  // ne s'assoit toujours pas avec le personnage d'un autre monde.
  const character = await c.env.DB.prepare(
    `SELECT id FROM characters WHERE id = ? AND bible_id = ?`,
  )
    .bind(characterId, found.row.bible_id)
    .first();
  if (!character) return c.json({ error: "character_not_found" }, 404);

  // …mais le siège est exclusif. Le moteur indexe l'état par character_id :
  // deux joueurs sur une même fiche partageraient un seul Souffle, un seul
  // jeu d'acquis, un seul jet.
  const occupant = await c.env.DB.prepare(
    `SELECT user_id FROM session_members
     WHERE session_id = ? AND character_id = ? AND user_id != ?`,
  )
    .bind(found.row.id, characterId, c.get("user").id)
    .first<{ user_id: string }>();
  if (occupant) {
    return c.json(
      { error: "character_taken", user_id: occupant.user_id },
      409,
    );
  }

  await c.env.DB.prepare(
    `UPDATE session_members SET character_id = ?
     WHERE session_id = ? AND user_id = ?`,
  )
    .bind(characterId, found.row.id, c.get("user").id)
    .run();

  await seatCharacter(c, found.row.id, c.get("user").id, characterId);

  return c.json({ ok: true, character_id: characterId });
});

/**
 * Prévient le moteur qu'un joueur vient de s'asseoir.
 *
 * Sans ça, le DO garde la composition figée à l'init — or une table naît dans
 * son lobby, AVANT que quiconque soit assis : le MJ improvisait des fiches
 * minimales pendant que deux joueurs venaient d'écrire les leurs.
 *
 * L'échec ne fait PAS échouer la prise de place : la ligne de membre est déjà
 * écrite et le roster est de toute façon relu depuis D1 à chaque tour. Seuls
 * l'event temps réel et l'amorçage des compétences seraient perdus.
 */
async function seatCharacter(
  c: Context<AppEnv>,
  sessionId: string,
  userId: string,
  characterId: string,
): Promise<void> {
  try {
    const res = await stubFor(c, sessionId).fetch("https://do/seat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, characterId }),
    });
    if (!res.ok) {
      console.error(`[sessions] /seat refusé pour ${sessionId}: ${res.status}`);
    }
  } catch (err) {
    console.error(`[sessions] /seat échoué pour ${sessionId}:`, err);
  }
}

// POST /api/sessions/:id/trame/suggest (hôte) — deux fils rouges possibles.
//
// À la demande, jamais à l'ouverture de l'écran : la mise en place ne doit
// coûter un appel au modèle que si on le réclame. Le champ libre reste la voie
// principale — ces propositions ne servent qu'à sortir de la page blanche.
sessions.post("/:id/trame/suggest", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "trame_ai_not_configured" }, 503);
  }
  const found = await access(c, { host: true });
  if (denied(found)) return found;
  if (found.row.status !== "setup") {
    return c.json({ error: "invalid_status", status: found.row.status }, 409);
  }

  const bible = await c.env.DB.prepare(
    `SELECT title, canon_md FROM bibles WHERE id = ?`,
  )
    .bind(found.row.bible_id)
    .first<{ title: string; canon_md: string | null }>();
  if (!bible?.canon_md) return c.json({ error: "empty_bible" }, 400);

  // Les personnages déjà assis : un fil rouge qui ne leur donne rien à faire
  // ne sert à personne.
  const members = await listMembers(c.env.DB, found.row.id);
  try {
    const trames = await suggestTrames(c.env.ANTHROPIC_API_KEY, {
      bibleTitle: bible.title,
      canonMd: bible.canon_md,
      format: found.row.format,
      characters: members
        .map((m) => m.character_name)
        .filter((n): n is string => Boolean(n)),
    });
    return c.json({ trames });
  } catch (err) {
    console.error(`[sessions] fils rouges échoués pour ${found.row.id} :`, err);
    return c.json({ error: "trame_suggest_failed" }, 502);
  }
});

sessions.post("/:id/trame", proxy("/trame", { host: true }));
sessions.post("/:id/setup", proxy("/setup", { host: true }));
sessions.post("/:id/turn", proxy("/turn"));
// L'hôte force la résolution sans attendre les retardataires (M8 lot 8.5).
sessions.post("/:id/turn/resolve", proxy("/turn/resolve", { host: true }));
sessions.post("/:id/roll", proxy("/roll"));
sessions.post("/:id/finish", proxy("/finish", { host: true }));
// Clôture d'acte (M7) : l'historique de l'acte est remplacé par son résumé et
// la fenêtre de contexte repart de zéro — c'est ce qui empêche une partie
// longue de perdre son passé et de payer plein tarif à chaque tour.
sessions.post("/:id/acts/close", proxy("/act/close", { host: true }));

// GET /api/sessions/:id/acts — les actes clos et leurs résumés.
// Lu directement en D1 : pas besoin de réveiller le Durable Object pour
// afficher un historique qui, par définition, ne bouge plus.
sessions.get("/:id/acts", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;
  const row = found.row;

  const { results } = await c.env.DB.prepare(
    `SELECT act_index, title, context_summary_md, narrated_summary_md,
            audio_key IS NOT NULL AS has_audio, turn_start, turn_end, closed_at
     FROM session_acts WHERE session_id = ? ORDER BY act_index`,
  )
    .bind(row.id)
    .all<Record<string, unknown>>();

  return c.json({
    acts: results.map((a) => ({ ...a, has_audio: Boolean(a.has_audio) })),
  });
});

/** Stub du DO d'une session, pour les handlers qui portent une query string. */
function stubFor(c: Context<AppEnv>, id: string): DurableObjectStub {
  return c.env.GAME_SESSIONS.get(c.env.GAME_SESSIONS.idFromString(id));
}

// POST /api/sessions/:id/acts/:index/narrate — le récit d'un acte, pour le
// joueur. Idempotent : un acte déjà narré renvoie l'existant (?force=1 pour
// régénérer). Handler dédié : le proxy générique perdrait la query string.
sessions.post("/:id/acts/:index/narrate", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;
  const row = found.row;

  // Écrire un récit absent : tout membre. Le RÉÉCRIRE : l'hôte seul. Sans
  // cette borne, n'importe quel invité pourrait boucler des générations
  // d'une page sur la bible de quelqu'un d'autre.
  const force = c.req.query("force") === "1";
  if (force && found.role !== "host") {
    return c.json({ error: "host_only" }, 403);
  }

  const qs = new URLSearchParams({
    index: c.req.param("index"),
    ...(force ? { force: "1" } : {}),
  }).toString();
  return stubFor(c, row.id).fetch(`https://do/act/narrate?${qs}`, {
    method: "POST",
  });
});

// GET /api/sessions/:id/acts/:index/audio — le récit lu à voix haute.
// Protégée par l'accès à la session : l'objet R2 n'est jamais servi
// directement, et un non-membre prend 404 sur la session avant tout le reste.
sessions.get("/:id/acts/:index/audio", async (c) => {
  const found = await access(c);
  if (denied(found)) return found;
  const row = found.row;

  return stubFor(c, row.id).fetch(
    `https://do/act/audio?index=${encodeURIComponent(c.req.param("index"))}`,
  );
});

// DELETE /api/sessions/:id — efface une session et tout ce qu'elle a laissé :
// storage du DO (historique, faits, inventions), caches KV, propositions de
// canon issues d'elle, puis la ligne D1. Le canon déjà accepté, lui, reste —
// il appartient à la bible. Les compétences déjà versées au personnage aussi.
sessions.delete("/:id", async (c) => {
  const found = await access(c, { host: true });
  if (denied(found)) return found;
  const row = found.row;

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
  // Les actes partent avec : sans ça, session_acts garderait des orphelins
  // référençant une game_sessions qui n'existe plus.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM canon_proposals WHERE session_id = ?`).bind(
      row.id,
    ),
    c.env.DB.prepare(`DELETE FROM session_acts WHERE session_id = ?`).bind(
      row.id,
    ),
    c.env.DB.prepare(`DELETE FROM session_invites WHERE session_id = ?`).bind(
      row.id,
    ),
    c.env.DB.prepare(`DELETE FROM session_members WHERE session_id = ?`).bind(
      row.id,
    ),
    c.env.DB.prepare(`DELETE FROM game_sessions WHERE id = ?`).bind(row.id),
  ]);

  c.executionCtx.waitUntil(purgeSessionCache(c.env.CACHE, row.id));
  // Les récits audio des actes partent aussi : ce sont les seuls objets R2
  // que la session ait créés, et plus rien ne les référence.
  c.executionCtx.waitUntil(purgeSessionAudio(c.env.BUCKET, row.id));
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
  const found = await access(c);
  if (denied(found)) return found;
  const row = found.row;

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
  const found = await access(c);
  if (denied(found)) return found;
  const row = found.row;

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
