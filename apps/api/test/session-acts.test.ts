// M7 lot 7.1 — découpage d'une session en actes : bornage de la fenêtre de
// contexte et stabilité du préfixe de messages (le point qui protège le cache).
//
// Ces tests attaquent le DO directement (runInDurableObject) plutôt que par le
// SSE : monter une partie de 60 tours par l'API demanderait 60 générations
// mockées pour vérifier une mécanique de fenêtrage qui n'en a pas besoin.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
} from "./anthropic-mock";

const BASE = "http://loreforge.test";

beforeAll(() => installAnthropicMock());
afterEach(() => assertAnthropicMockConsumed());

// ── Accès au DO ───────────────────────────────────────────────────────────

interface StoredTurn {
  role: "user" | "assistant";
  text: string;
}

/** Surface privée du DO que ces tests inspectent (private = compile-time). */
interface GameSessionInternals {
  buildMessages(sentText: string): Promise<Array<Record<string, unknown>>>;
  listTurns(limit: number): Promise<StoredTurn[]>;
}

const turnKey = (i: number) => `turn:${String(i).padStart(6, "0")}`;

function stubFor(id: string) {
  return env.GAME_SESSIONS.get(env.GAME_SESSIONS.idFromString(id));
}

/** Écrit `count` tours de jeu (2 entrées chacun) dans le storage du DO. */
async function seedTurns(
  id: string,
  count: number,
  { from = 0 }: { from?: number } = {},
): Promise<void> {
  await runInDurableObject(stubFor(id), async (_instance, state) => {
    for (let t = from; t < from + count; t++) {
      await state.storage.put(turnKey(t * 2), {
        role: "user",
        text: `saisie ${t}`,
      });
      await state.storage.put(turnKey(t * 2 + 1), {
        role: "assistant",
        text: `narration ${t}`,
      });
    }
    await state.storage.put("turn_count_stored", (from + count) * 2);
  });
}

/** Texte de tous les blocs d'un message, quelle que soit sa forme. */
function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return (content as Array<{ text: string }>).map((b) => b.text).join("");
}

/** Positions des points de cache dans une liste de messages. */
function cachePoints(messages: Array<Record<string, unknown>>): string[] {
  const points: string[] = [];
  messages.forEach((m, i) => {
    const content = m.content;
    if (typeof content === "string") return;
    (content as Array<{ cache_control?: unknown; text: string }>).forEach(
      (block, j) => {
        if (block.cache_control) points.push(`${i}.${j}`);
      },
    );
  });
  return points;
}

// ── Fixture : session réelle (pour la clôture, qui écrit en D1) ───────────

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

/** Session en cours de jeu (statut 'playing'), scène 1 déjà générée. */
async function playingSession(
  email: string,
): Promise<{ cookie: string; sessionId: string }> {
  const cookie = await login(email);
  const bibleRes = await post(cookie, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };

  // Pas de richness_scores : la mise en place ne pose aucune question et
  // n'appelle donc pas le tri de pertinence.
  const createRes = await post(cookie, "/api/sessions", {
    bible_id: bibleId,
    format: "campaign",
  });
  const { session_id } = (await createRes.json()) as { session_id: string };

  mockAnthropicStream(["La brume s'ouvre. Que fais-tu ?"]);
  await (await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })).text();

  return { cookie, sessionId: session_id };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("lot 7.1 — fenêtre de contexte bornée à l'acte", () => {
  it("sans acte clos, la session se comporte exactement comme avant", async () => {
    const id = env.GAME_SESSIONS.newUniqueId().toString();
    await seedTurns(id, 5);

    await runInDurableObject(stubFor(id), async (instance) => {
      const messages = await (
        instance as unknown as GameSessionInternals
      ).buildMessages("nouveau tour");

      // 5 tours = 10 entrées, plus le message du tour.
      expect(messages).toHaveLength(11);
      expect(textOf(messages[0])).toBe("saisie 0");
      expect(typeof messages[0].content).toBe("string");
      expect(textOf(messages[9])).toBe("narration 4");
      expect(textOf(messages[10])).toBe("nouveau tour");
      // Point de cache unique, sur le dernier tour stocké — forme historique.
      expect(cachePoints(messages)).toEqual(["9.0"]);
    });
  });

  it("un acte clos au tour 30 remplace les tours 1-30 par son résumé", async () => {
    const id = env.GAME_SESSIONS.newUniqueId().toString();
    await seedTurns(id, 60);
    await runInDurableObject(stubFor(id), async (_i, state) => {
      await state.storage.put({
        act_index: 1,
        act_start_index: 60, // 30 tours joués × 2 entrées
        closed_acts: [
          {
            act_index: 0,
            title: "La traversée",
            context_summary_md: "Kael a franchi la faille. Reika le suit.",
          },
        ],
      });
    });

    await runInDurableObject(stubFor(id), async (instance) => {
      const internals = instance as unknown as GameSessionInternals;

      // La fenêtre ne remonte plus avant l'acte courant.
      const turns = await internals.listTurns(1000);
      expect(turns).toHaveLength(60);
      expect(turns[0].text).toBe("saisie 30");

      const messages = await internals.buildMessages("nouveau tour");
      const joined = messages.map(textOf).join("\n");
      expect(joined).toContain("Kael a franchi la faille");
      expect(joined).toContain("saisie 30");
      expect(joined).toContain("narration 59");
      // Aucun tour de l'acte clos ne repart au modèle.
      expect(joined).not.toContain("saisie 29");
      expect(joined).not.toContain("narration 0\n");
    });
  });

  it("le préfixe des messages est identique entre deux tours du même acte", async () => {
    const id = env.GAME_SESSIONS.newUniqueId().toString();
    await seedTurns(id, 4);
    await runInDurableObject(stubFor(id), async (_i, state) => {
      await state.storage.put({
        act_index: 1,
        act_start_index: 0,
        closed_acts: [
          {
            act_index: 0,
            title: null,
            context_summary_md: "Faits établis de l'acte précédent.",
          },
        ],
      });
    });

    const avant = await runInDurableObject(stubFor(id), (instance) =>
      (instance as unknown as GameSessionInternals).buildMessages("tour A"),
    );

    // Un tour de plus s'ajoute — c'est le seul changement.
    await seedTurns(id, 1, { from: 4 });

    const apres = await runInDurableObject(stubFor(id), (instance) =>
      (instance as unknown as GameSessionInternals).buildMessages("tour B"),
    );

    // C'EST L'ASSERTION QUI PROTÈGE LE CACHE : l'ancre (bloc des actes clos, en
    // tête du premier message) est identique à l'octet près, et tout ce qui la
    // précède ou l'accompagne dans le préfixe n'a pas bougé. C'est exactement
    // ce que la fenêtre glissante cassait à chaque tour passé le plafond.
    expect(JSON.stringify(avant[0])).toBe(JSON.stringify(apres[0]));
    const prefixeAvant = avant.slice(0, -1).map(textOf);
    const prefixeApres = apres.slice(0, -1).map(textOf);
    expect(prefixeApres.slice(0, prefixeAvant.length - 1)).toEqual(
      prefixeAvant.slice(0, prefixeAvant.length - 1),
    );

    // Deux points de cache : l'ancre stable, puis le dernier tour stocké
    // (cache incrémental — l'historique de l'acte ne fait que s'allonger).
    expect(cachePoints(avant)).toEqual(["0.0", "7.0"]);
    expect(cachePoints(apres)).toEqual(["0.0", "9.0"]);
  });

  it("un acte tout juste ouvert porte l'ancre en tête du message du tour", async () => {
    const id = env.GAME_SESSIONS.newUniqueId().toString();
    await seedTurns(id, 3);
    await runInDurableObject(stubFor(id), async (_i, state) => {
      await state.storage.put({
        act_index: 1,
        act_start_index: 6, // tout l'historique appartient à l'acte clos
        closed_acts: [
          { act_index: 0, title: null, context_summary_md: "Résumé de l'acte 1." },
        ],
      });
    });

    await runInDurableObject(stubFor(id), async (instance) => {
      const messages = await (
        instance as unknown as GameSessionInternals
      ).buildMessages("premier tour du nouvel acte");
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(textOf(messages[0])).toContain("Résumé de l'acte 1.");
      expect(textOf(messages[0])).toContain("premier tour du nouvel acte");
      // Le point de cache reste DEVANT le contexte volatile du tour.
      expect(cachePoints(messages)).toEqual(["0.0"]);
    });
  });

  it("la fenêtre de sécurité s'exprime en tours de jeu, pas en entrées", async () => {
    // 60 tours dans un même acte : la fenêtre plafonne à CONTEXT_TURNS (40)
    // tours de jeu, soit 80 entrées — et pas 40 entrées comme le laissait
    // croire l'ancien appel listTurns(CONTEXT_TURNS).
    const id = env.GAME_SESSIONS.newUniqueId().toString();
    await seedTurns(id, 60);

    await runInDurableObject(stubFor(id), async (instance) => {
      const messages = await (
        instance as unknown as GameSessionInternals
      ).buildMessages("nouveau tour");
      expect(messages).toHaveLength(81);
      expect(textOf(messages[0])).toBe("saisie 20");
    });
  });
});

describe("lot 7.1 — clôture d'acte (mécanique)", () => {
  it("clôt l'acte, avance la fenêtre et expose l'acte courant dans /state", async () => {
    const { cookie, sessionId } = await playingSession("actes@example.com");

    let state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.act_index).toBe(0);
    expect(state.act_turns).toBe(1);
    expect(state.acts_closed).toBe(0);

    const res = await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    expect(res.status).toBe(200);
    const { act, closed } = (await res.json()) as {
      act: { act_index: number; context_summary_md: string };
      closed: boolean;
    };
    expect(closed).toBe(true);
    expect(act.act_index).toBe(0);

    const row = await env.DB.prepare(
      `SELECT act_index, turn_start, turn_end FROM session_acts WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ act_index: number; turn_start: number; turn_end: number }>();
    expect(row).toMatchObject({ act_index: 0, turn_start: 0, turn_end: 2 });

    state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.act_index).toBe(1);
    expect(state.act_turns).toBe(0);
    expect(state.acts_closed).toBe(1);
    // Le journal affiché, lui, garde la continuité : le joueur ne voit pas son
    // écran se vider parce qu'un acte vient de se clore.
    expect((state.log as unknown[]).length).toBeGreaterThan(0);
  });

  it("est idempotente : rappelée sur un acte vide, elle n'en crée pas un second", async () => {
    const { cookie, sessionId } = await playingSession("idem@example.com");

    await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    const second = await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { closed: boolean }).closed).toBe(false);

    const { count } = (await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM session_acts WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ count: number }>())!;
    expect(count).toBe(1);
  });

  it("supprimer la session purge ses actes", async () => {
    const { cookie, sessionId } = await playingSession("purge@example.com");
    await post(cookie, `/api/sessions/${sessionId}/acts/close`);

    const del = await SELF.fetch(`${BASE}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const { count } = (await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM session_acts WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ count: number }>())!;
    expect(count).toBe(0);
  });
});
