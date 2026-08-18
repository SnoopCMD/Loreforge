// M8 lot 8.1 — appartenance à une session et invitations.
//
// Le point sensible n'est pas d'ajouter des routes : c'est que TOUTES les
// routes existantes basculent de « propriétaire » à « membre ». Un seul oubli,
// et un joueur invité prend un 404 sur la partie où il est assis ; un oubli
// dans l'autre sens, et n'importe qui clôt la session de quelqu'un d'autre.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
} from "./anthropic-mock";
import { generateInviteCode, normalizeInviteCode } from "../src/sessions/members";

const BASE = "http://loreforge.test";

beforeAll(() => installAnthropicMock());
afterEach(() => assertAnthropicMockConsumed());

async function login(email: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const { dev_link } = (await res.json()) as { dev_link: string };
  const cb = await SELF.fetch(dev_link, { redirect: "manual" });
  return (cb.headers.get("set-cookie") ?? "").split(";")[0];
}

async function post(
  cookie: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { cookie } });
}

async function del(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { method: "DELETE", headers: { cookie } });
}

/** Table créée par un hôte, scène 1 déjà jouée. */
async function table(
  email: string,
  mode: "solo" | "table" = "table",
): Promise<{ cookie: string; sessionId: string; bibleId: string }> {
  const cookie = await login(email);
  const bibleRes = await post(cookie, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };

  const createRes = await post(cookie, "/api/sessions", {
    bible_id: bibleId,
    format: "campaign",
    mode,
  });
  expect(createRes.status).toBe(201);
  const { session_id } = (await createRes.json()) as { session_id: string };

  mockAnthropicStream(["La brume s'ouvre. Que fais-tu ?"]);
  await (
    await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })
  ).text();

  return { cookie, sessionId: session_id, bibleId };
}

async function inviteCode(cookie: string, sessionId: string): Promise<string> {
  const res = await post(cookie, `/api/sessions/${sessionId}/invite`);
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

describe("lot 8.1 — codes d'invitation", () => {
  it("tire des codes non devinables, lisibles à voix haute", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(generateInviteCode());
    // Aucune collision sur 500 tirages, et surtout aucune séquence.
    expect(codes.size).toBe(500);
    for (const code of codes) {
      expect(code).toHaveLength(8);
      // Ni 0/O ni 1/I/L : on dicte ces codes de vive voix.
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("accepte un code saisi à la main, quelle qu'en soit la casse", () => {
    const code = generateInviteCode();
    expect(normalizeInviteCode(code.toLowerCase())).toBe(code);
    expect(normalizeInviteCode(`${code.slice(0, 4)}-${code.slice(4)}`)).toBe(code);
    expect(normalizeInviteCode("trop court")).toBeNull();
    expect(normalizeInviteCode(42)).toBeNull();
  });
});

describe("lot 8.1 — l'accès passe par l'appartenance", () => {
  it("un invité voit la partie, un inconnu ne sait même pas qu'elle existe", async () => {
    const { cookie: hote, sessionId } = await table("hote@example.com");
    const code = await inviteCode(hote, sessionId);

    const inconnu = await login("inconnu@example.com");
    expect((await get(inconnu, `/api/sessions/${sessionId}/state`)).status).toBe(404);

    const joueur = await login("joueur@example.com");
    const join = await post(joueur, "/api/sessions/join", { code });
    expect(join.status).toBe(201);
    expect((await join.json()) as { role: string }).toMatchObject({
      session_id: sessionId,
      role: "player",
    });

    // Toutes les lectures s'ouvrent d'un coup.
    expect((await get(joueur, `/api/sessions/${sessionId}/state`)).status).toBe(200);
    expect((await get(joueur, `/api/sessions/${sessionId}/acts`)).status).toBe(200);
    expect((await get(joueur, `/api/sessions/${sessionId}/palette`)).status).toBe(200);
    expect((await get(joueur, `/api/sessions/${sessionId}/members`)).status).toBe(200);
  });

  it("réserve à l'hôte les gestes qui engagent toute la table", async () => {
    const { cookie: hote, sessionId } = await table("hote2@example.com");
    const joueur = await login("joueur2@example.com");
    await post(joueur, "/api/sessions/join", {
      code: await inviteCode(hote, sessionId),
    });

    for (const path of [
      `/api/sessions/${sessionId}/finish`,
      `/api/sessions/${sessionId}/acts/close`,
      `/api/sessions/${sessionId}/trame`,
      `/api/sessions/${sessionId}/setup`,
      `/api/sessions/${sessionId}/invite`,
    ]) {
      const res = await post(joueur, path, {});
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("host_only");
    }
    expect((await del(joueur, `/api/sessions/${sessionId}`)).status).toBe(403);
    expect(
      (
        await SELF.fetch(`${BASE}/api/sessions/${sessionId}/palette`, {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: joueur },
          body: JSON.stringify({ palette: null }),
        })
      ).status,
    ).toBe(403);
  });

  it("la session rejointe apparaît sur l'accueil de l'invité", async () => {
    const { cookie: hote, sessionId } = await table("hote3@example.com");
    const joueur = await login("joueur3@example.com");
    await post(joueur, "/api/sessions/join", {
      code: await inviteCode(hote, sessionId),
    });

    const { sessions } = (await (await get(joueur, "/api/sessions")).json()) as {
      sessions: Array<{ id: string; role: string; mode: string }>;
    };
    expect(sessions.map((s) => s.id)).toContain(sessionId);
    expect(sessions[0].role).toBe("player");
    expect(sessions[0].mode).toBe("table");
  });
});

describe("lot 8.1 — cycle de vie des invitations", () => {
  it("refuse un code expiré ou épuisé, sans confondre les deux avec un code faux", async () => {
    const { cookie: hote, sessionId } = await table("hote4@example.com");
    const code = await inviteCode(hote, sessionId);

    await env.DB.prepare(`UPDATE session_invites SET expires_at = 1 WHERE code = ?`)
      .bind(code)
      .run();
    const tardif = await login("tardif@example.com");
    expect((await post(tardif, "/api/sessions/join", { code })).status).toBe(410);

    await env.DB.prepare(
      `UPDATE session_invites SET expires_at = ?, uses = max_uses WHERE code = ?`,
    )
      .bind(Date.now() + 60_000, code)
      .run();
    expect((await post(tardif, "/api/sessions/join", { code })).status).toBe(410);

    // Un code qui n'a jamais existé, lui, est un 404 : rien à dire de plus.
    expect(
      (await post(tardif, "/api/sessions/join", { code: "ZZZZZZZZ" })).status,
    ).toBe(404);
  });

  it("rejoindre deux fois ne consomme qu'un usage", async () => {
    const { cookie: hote, sessionId } = await table("hote5@example.com");
    const code = await inviteCode(hote, sessionId);
    const joueur = await login("joueur5@example.com");

    expect((await post(joueur, "/api/sessions/join", { code })).status).toBe(201);
    const rejoin = await post(joueur, "/api/sessions/join", { code });
    expect(rejoin.status).toBe(200);

    const { uses } = (await env.DB.prepare(
      `SELECT uses FROM session_invites WHERE code = ?`,
    )
      .bind(code)
      .first<{ uses: number }>())!;
    expect(uses).toBe(1);
  });

  it("laisse un joueur partir, mais jamais l'hôte", async () => {
    const { cookie: hote, sessionId } = await table("hote6@example.com");
    const joueur = await login("joueur6@example.com");
    await post(joueur, "/api/sessions/join", {
      code: await inviteCode(hote, sessionId),
    });
    const { members } = (await (
      await get(hote, `/api/sessions/${sessionId}/members`)
    ).json()) as { members: Array<{ user_id: string; role: string }> };
    expect(members).toHaveLength(2);

    const hoteId = members.find((m) => m.role === "host")!.user_id;
    const joueurId = members.find((m) => m.role === "player")!.user_id;

    // Un joueur ne peut exclure personne — la raison exacte est qu'il n'est
    // pas hôte, pas que la cible est protégée.
    expect(
      (await del(joueur, `/api/sessions/${sessionId}/members/${hoteId}`)).status,
    ).toBe(403);

    // …mais il peut partir de lui-même.
    expect(
      (await del(joueur, `/api/sessions/${sessionId}/members/${joueurId}`)).status,
    ).toBe(200);
    expect((await get(joueur, `/api/sessions/${sessionId}/state`)).status).toBe(404);

    // Une table sans hôte n'aurait plus personne pour la lancer ou la clore.
    expect(
      (await del(hote, `/api/sessions/${sessionId}/members/${hoteId}`)).status,
    ).toBe(409);
  });

  it("supprimer la session emporte membres et invitations", async () => {
    const { cookie: hote, sessionId } = await table("hote7@example.com");
    const code = await inviteCode(hote, sessionId);
    const joueur = await login("joueur7@example.com");
    await post(joueur, "/api/sessions/join", { code });

    expect((await del(hote, `/api/sessions/${sessionId}`)).status).toBe(200);
    const { members } = (await env.DB.prepare(
      `SELECT COUNT(*) AS members FROM session_members WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ members: number }>())!;
    expect(members).toBe(0);
    const { invites } = (await env.DB.prepare(
      `SELECT COUNT(*) AS invites FROM session_invites WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ invites: number }>())!;
    expect(invites).toBe(0);
  });

  it("supprimer la bible emporte les tables qu'elle portait", async () => {
    const { cookie: hote, sessionId, bibleId } = await table("hote8@example.com");
    const joueur = await login("joueur8@example.com");
    await post(joueur, "/api/sessions/join", {
      code: await inviteCode(hote, sessionId),
    });

    expect((await del(hote, `/api/bibles/${bibleId}`)).status).toBe(200);
    const { members } = (await env.DB.prepare(
      `SELECT COUNT(*) AS members FROM session_members WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ members: number }>())!;
    expect(members).toBe(0);
  });
});

describe("lot 8.1 — le solo garde son parcours", () => {
  it("naît en solo, avec son auteur pour seul membre et tous les droits", async () => {
    const { cookie, sessionId } = await table("solo@example.com", "solo");

    const { mode, members, role } = (await (
      await get(cookie, `/api/sessions/${sessionId}/members`)
    ).json()) as {
      mode: string;
      role: string;
      members: Array<{ role: string }>;
    };
    expect(mode).toBe("solo");
    expect(role).toBe("host");
    expect(members).toHaveLength(1);

    // Le joueur solo EST l'hôte : aucun geste ne lui est refusé.
    mockAnthropicStream(["La suite arrive. Que fais-tu ?"]);
    expect(
      (
        await post(cookie, `/api/sessions/${sessionId}/turn`, {
          player_input: "j'avance",
        })
      ).status,
    ).toBe(200);
  });

  it("refuse un mode inconnu plutôt que de l'ignorer", async () => {
    const cookie = await login("mode@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers\n\nDu lore.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const res = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
      mode: "coop",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_mode");
  });
});
