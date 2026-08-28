// M7 lot 7.1 — découpage d'une session en actes : bornage de la fenêtre de
// contexte et stabilité du préfixe de messages (le point qui protège le cache).
//
// Ces tests attaquent le DO directement (runInDurableObject) plutôt que par le
// SSE : monter une partie de 60 tours par l'API demanderait 60 générations
// mockées pour vérifier une mécanique de fenêtrage qui n'en a pas besoin.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
  mockAnthropicText,
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

/** Toutes les clés de tours présentes dans le storage d'un DO. */
async function listTurnKeys(
  storage: DurableObjectState["storage"],
): Promise<string[]> {
  const map = await storage.list({ prefix: "turn:" });
  return [...map.keys()];
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

async function readSse(
  res: Response,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    // Les commentaires SSE (signe de vie avant le premier mot du MJ) ne sont
    // pas des events : le front les ignore, ce helper aussi.
    .filter((b) => b.trim() !== "" && !b.trimStart().startsWith(":"))
    .map((b) => ({
      event: /^event: (.+)$/m.exec(b)![1],
      data: JSON.parse(/^data: (.+)$/m.exec(b)![1]),
    }));
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

    mockAnthropicText("# Ouverture\n\n- la brume, la ville, le seuil");
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

    mockAnthropicText("# Ouverture\n\n- résumé du premier acte");
    await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    // Deuxième appel : aucun tour joué depuis, donc AUCUN appel au modèle —
    // l'idempotence protège aussi la facture.
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
    mockAnthropicText("# Ouverture\n\n- résumé à purger");
    const closeRes = await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    expect(closeRes.status).toBe(200);

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

describe("lot 7.2 — clôture d'acte et reprise", () => {
  it("génère une fiche de mémoire dense sans toucher à l'état de jeu", async () => {
    const { cookie, sessionId } = await playingSession("resume@example.com");

    // Un tour qui fait bouger l'état : Souffle dépensé, compétence, fait.
    mockAnthropicStream([
      "Tu forces la serrure. ",
      '<souffle delta="-1"/>',
      '<skill name="Crochetage" tier="apprentissage" note="serrures simples"/>',
      '<fait texte="La porte du sanctuaire est ouverte."/>',
      " Que fais-tu ?",
    ]);
    await (
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "je crochète la serrure",
      })
    ).text();

    const avant = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(avant.souffle).toBe(2);

    mockAnthropicText(
      "# La porte du sanctuaire\n\n" +
        "## Personnages\n- Reika — guide, laissée au seuil\n\n" +
        "## Faits établis\n- La porte du sanctuaire est ouverte\n\n" +
        "## Promesses ouvertes\n- Ce qui dort derrière la porte\n\n" +
        "## Relations\n- Reika : confiance fragile",
    );
    const res = await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    expect(res.status).toBe(200);
    const { act } = (await res.json()) as {
      act: { title: string | null; context_summary_md: string };
    };
    expect(act.title).toBe("La porte du sanctuaire");
    // Le titre est extrait, pas laissé dans le corps du résumé.
    expect(act.context_summary_md.startsWith("## Personnages")).toBe(true);

    // La clôture borne la mémoire narrative, pas la partie : rien de l'état
    // de jeu ne doit avoir bougé.
    const apres = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(apres.souffle).toBe(avant.souffle);
    expect(apres.facts).toEqual(avant.facts);
    expect(apres.skills).toEqual(avant.skills);
  });

  it("empile les résumés de deux actes clos dans l'ordre", async () => {
    const { cookie, sessionId } = await playingSession("empile@example.com");

    mockAnthropicText("# Acte un\n\n- premier résumé");
    await post(cookie, `/api/sessions/${sessionId}/acts/close`);

    mockAnthropicStream(["La suite s'ouvre. Que fais-tu ?"]);
    await (
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "j'avance",
      })
    ).text();

    mockAnthropicText("# Acte deux\n\n- second résumé");
    await post(cookie, `/api/sessions/${sessionId}/acts/close`);

    const { acts } = (await (
      await get(cookie, `/api/sessions/${sessionId}/acts`)
    ).json()) as {
      acts: Array<{ act_index: number; title: string; context_summary_md: string }>;
    };
    expect(acts.map((a) => a.title)).toEqual(["Acte un", "Acte deux"]);

    await runInDurableObject(stubFor(sessionId), async (instance) => {
      const messages = await (
        instance as unknown as GameSessionInternals
      ).buildMessages("tour suivant");
      const bloc = textOf(messages[0]);
      expect(bloc.indexOf("premier résumé")).toBeLessThan(
        bloc.indexOf("second résumé"),
      );
      expect(bloc).toContain("## Acte 1 — Acte un");
      expect(bloc).toContain("## Acte 2 — Acte deux");
    });
  });

  it("reconstruit les résumés depuis D1 si le storage du DO les a perdus", async () => {
    const { cookie, sessionId } = await playingSession("reprise@example.com");
    mockAnthropicText("# Acte un\n\n- ce qui est établi");
    await post(cookie, `/api/sessions/${sessionId}/acts/close`);

    // Simule un DO réveillé sans sa liste (session ouverte avant le lot 7.1).
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.delete("closed_acts");
    });

    await runInDurableObject(stubFor(sessionId), async (instance) => {
      const messages = await (
        instance as unknown as GameSessionInternals
      ).buildMessages("tour après reprise");
      expect(messages.map(textOf).join("\n")).toContain("ce qui est établi");
    });
  });

  it("laisse l'acte ouvert quand la génération du résumé échoue", async () => {
    const { cookie, sessionId } = await playingSession("echec@example.com");

    mockAnthropicText(""); // le modèle ne rend rien
    const res = await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    expect(res.status).toBe(502);

    // Rien n'a été borné : on n'efface jamais le passé sans contrepartie.
    const state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.act_index).toBe(0);
    expect(state.acts_closed).toBe(0);
  });

  it("force la clôture à 35 tours, bien avant la fenêtre de contexte", async () => {
    const { cookie, sessionId } = await playingSession("force@example.com");

    // On amène l'acte à 34 tours joués sans passer par 34 générations.
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.put("turn_count_stored", 34 * 2);
    });

    mockAnthropicStream([
      "Le tour de trop.\n- J'avance encore\n- Je fais demi-tour",
    ]);
    mockAnthropicText("# Acte forcé\n\n- résumé de clôture forcée");
    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "encore un pas",
      }),
    );

    const closed = events.find((e) => e.event === "act_closed");
    expect(closed, "la clôture forcée doit être diffusée au client").toBeTruthy();
    expect(closed!.data.forced).toBe(true);
    // Elle arrive APRÈS le `done` : le tour est validé avant d'être résumé.
    expect(events.findIndex((e) => e.event === "done")).toBeLessThan(
      events.findIndex((e) => e.event === "act_closed"),
    );

    const state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.act_index).toBe(1);
    expect(state.act_turns).toBe(0);
    // 35 tours = 70 entrées, la fenêtre en tolère 80 : on n'y touche jamais.
    expect(35).toBeLessThan(40);
  });

  it("propose la clôture sur une rupture de scène passé le seuil souple", async () => {
    const { cookie, sessionId } = await playingSession("propose@example.com");
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.put("turn_count_stored", 21 * 2);
    });

    mockAnthropicStream(["La scène bascule. <scene_break/> Que fais-tu ?"]);
    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "je quitte la salle",
      }),
    );
    const suggestion = events.find((e) => e.event === "act_close_suggested");
    expect(suggestion).toBeTruthy();
    expect(suggestion!.data.turns).toBe(22);
  });

  it("ne propose rien sans rupture de scène, même passé le seuil souple", async () => {
    const { cookie, sessionId } = await playingSession("silence@example.com");
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.put("turn_count_stored", 25 * 2);
    });

    mockAnthropicStream(["La conversation continue. Que réponds-tu ?"]);
    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "je réponds",
      }),
    );
    expect(events.some((e) => e.event === "act_close_suggested")).toBe(false);
  });

  it("plafonne le résumé de contexte, seul texte payé éternellement", async () => {
    const { cookie, sessionId } = await playingSession("plafond@example.com");

    mockAnthropicText("# Trop long\n\n" + "Une phrase de remplissage. ".repeat(400));
    const res = await post(cookie, `/api/sessions/${sessionId}/acts/close`);
    const { act } = (await res.json()) as {
      act: { context_summary_md: string };
    };
    expect(act.context_summary_md.length).toBeLessThanOrEqual(2000);
    // Coupé sur une frontière de phrase, pas au milieu d'un mot.
    expect(act.context_summary_md.endsWith(".")).toBe(true);
  });
});

describe("lot 7.3 — récit narré et audio", () => {
  // La voix n'est pas configurée dans l'environnement de test (tts.test.ts
  // s'appuie dessus). On l'active pour ce bloc seulement.
  beforeAll(() => {
    env.CARTESIA_API_KEY = "test-cartesia-key";
    env.CARTESIA_VOICE_ID = "test-voice";
  });
  afterAll(() => {
    delete env.CARTESIA_API_KEY;
    delete env.CARTESIA_VOICE_ID;
  });

  /** Session avec un acte 0 déjà clos, prête à être narrée. */
  async function withClosedAct(
    email: string,
  ): Promise<{ cookie: string; sessionId: string }> {
    const session = await playingSession(email);
    mockAnthropicText("# L'acte clos\n\n- ce qui a été établi");
    const res = await post(
      session.cookie,
      `/api/sessions/${session.sessionId}/acts/close`,
    );
    expect(res.status).toBe(200);
    return session;
  }

  it("narre un acte en prose, distincte de sa fiche de mémoire", async () => {
    const { cookie, sessionId } = await withClosedAct("narre@example.com");

    mockAnthropicText(
      "La brume s'était ouverte sur la ville, et Kael y était entré sans " +
        "savoir ce qui l'attendait derrière le seuil.",
    );
    const res = await post(
      cookie,
      `/api/sessions/${sessionId}/acts/0/narrate`,
    );
    expect(res.status).toBe(200);
    const { act, generated } = (await res.json()) as {
      act: { narrated_summary_md: string; context_summary_md: string };
      generated: boolean;
    };
    expect(generated).toBe(true);
    expect(act.narrated_summary_md).toContain("La brume s'était ouverte");
    // Deux objets distincts : le narré ne remplace jamais le contexte.
    expect(act.context_summary_md).not.toContain("La brume s'était ouverte");
    expect(act.context_summary_md).toContain("ce qui a été établi");
  });

  it("est idempotent : un acte déjà narré ne rappelle pas le modèle", async () => {
    const { cookie, sessionId } = await withClosedAct("idemnarre@example.com");

    mockAnthropicText("Un premier récit.");
    await post(cookie, `/api/sessions/${sessionId}/acts/0/narrate`);

    // Aucun mock n'est posé : un second appel qui générerait ferait échouer
    // le test sur « appel Anthropic non mocké ».
    const second = await post(
      cookie,
      `/api/sessions/${sessionId}/acts/0/narrate`,
    );
    const body = (await second.json()) as {
      generated: boolean;
      act: { narrated_summary_md: string };
    };
    expect(body.generated).toBe(false);
    expect(body.act.narrated_summary_md).toBe("Un premier récit.");
  });

  it("narre depuis la seule fiche de mémoire quand les tours ont disparu", async () => {
    const { cookie, sessionId } = await withClosedAct("purgé@example.com");

    // Les tours d'origine ne sont plus là (purge, storage réinitialisé).
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.delete(await listTurnKeys(state.storage));
    });

    mockAnthropicText("Un récit reconstruit depuis la fiche.");
    const res = await post(
      cookie,
      `/api/sessions/${sessionId}/acts/0/narrate`,
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { act: { narrated_summary_md: string } }).act
        .narrated_summary_md,
    ).toBe("Un récit reconstruit depuis la fiche.");
  });

  it("refuse de lire un acte qui n'a pas encore de récit", async () => {
    const { cookie, sessionId } = await withClosedAct("muet@example.com");
    const res = await get(cookie, `/api/sessions/${sessionId}/acts/0/audio`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "act_not_narrated",
    );
  });

  it("ne synthétise l'audio qu'une fois, même sur deux appels", async () => {
    const { cookie, sessionId } = await withClosedAct("audio@example.com");
    mockAnthropicText("Le récit à mettre en voix.");
    await post(cookie, `/api/sessions/${sessionId}/acts/0/narrate`);

    let synthesisCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("https://api.cartesia.ai")) {
        synthesisCalls++;
        return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          headers: { "content-type": "audio/mpeg" },
        });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      const first = await get(cookie, `/api/sessions/${sessionId}/acts/0/audio`);
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("audio/mpeg");

      const second = await get(cookie, `/api/sessions/${sessionId}/acts/0/audio`);
      expect(second.status).toBe(200);
      // Le second appel vient de R2 : c'est le poste de coût le plus facile à
      // faire exploser par un double clic.
      expect(synthesisCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }

    const key = `acts/${sessionId}/0.mp3`;
    expect(await env.BUCKET.get(key)).toBeTruthy();
    const row = await env.DB.prepare(
      `SELECT audio_key FROM session_acts WHERE session_id = ? AND act_index = 0`,
    )
      .bind(sessionId)
      .first<{ audio_key: string }>();
    expect(row!.audio_key).toBe(key);

    // Supprimer la session emporte l'objet R2 avec elle (purge en waitUntil,
    // d'où l'attente : la réponse ne l'attend pas, et c'est voulu).
    await SELF.fetch(`${BASE}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    for (let i = 0; i < 30 && (await env.BUCKET.get(key)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await env.BUCKET.get(key)).toBeNull();
  });

  it("ne laisse pas un autre compte lire le récit audio", async () => {
    const { cookie, sessionId } = await withClosedAct("proprio@example.com");
    mockAnthropicText("Un récit privé.");
    await post(cookie, `/api/sessions/${sessionId}/acts/0/narrate`);

    const intrus = await login("intrus@example.com");
    const res = await get(intrus, `/api/sessions/${sessionId}/acts/0/audio`);
    expect(res.status).toBe(404);

    const narrate = await post(
      intrus,
      `/api/sessions/${sessionId}/acts/0/narrate`,
    );
    expect(narrate.status).toBe(404);
  });
});

describe("M7 — défauts relevés en relecture", () => {
  it("supprimer une bible dont une session a un acte clos ne casse pas la clé étrangère", async () => {
    const cookie = await login("bible-purge@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers jetable\n\nUn monde de passage.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };

    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
    });
    const { session_id } = (await createRes.json()) as { session_id: string };
    mockAnthropicStream(["La scène s'ouvre. Que fais-tu ?"]);
    await (
      await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })
    ).text();

    mockAnthropicText("# Un acte\n\n- de quoi bloquer la suppression");
    expect(
      (await post(cookie, `/api/sessions/${session_id}/acts/close`)).status,
    ).toBe(200);

    // Avant correction : FOREIGN KEY constraint failed → 500, et la bible
    // devenait indestructible par l'API.
    const del = await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const { count } = (await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM session_acts WHERE session_id = ?`,
    )
      .bind(session_id)
      .first<{ count: number }>())!;
    expect(count).toBe(0);
    expect(
      await env.DB.prepare(`SELECT id FROM bibles WHERE id = ?`)
        .bind(bibleId)
        .first(),
    ).toBeNull();
  });

  it("annonce la clôture forcée avant de la générer, pour tenir le flux ouvert", async () => {
    const { cookie, sessionId } = await playingSession("battement@example.com");
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.put("turn_count_stored", 34 * 2);
    });

    mockAnthropicStream([
      "Le dernier tour de l'acte.\n- Je pousse la porte\n- Je recule",
    ]);
    mockAnthropicText("# Acte plein\n\n- résumé");
    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "j'avance encore",
      }),
    );

    const noms = events.map((e) => e.event);
    // Le signe de vie part AVANT la génération du résumé : sans lui, 20 s de
    // silence coupaient le flux côté client et la clôture était perdue.
    expect(noms.indexOf("act_closing")).toBeGreaterThan(noms.indexOf("done"));
    expect(noms.indexOf("act_closing")).toBeLessThan(noms.indexOf("act_closed"));
  });

  it("rend la main au joueur quand la clôture forcée échoue", async () => {
    const { cookie, sessionId } = await playingSession("echec-force@example.com");
    await runInDurableObject(stubFor(sessionId), async (_i, state) => {
      await state.storage.put("turn_count_stored", 34 * 2);
    });

    mockAnthropicStream(["Un tour de plus. Que fais-tu ?"]);
    mockAnthropicText(""); // résumé vide → clôture impossible
    const events = await readSse(
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "encore",
      }),
    );
    expect(events.some((e) => e.event === "act_close_failed")).toBe(true);

    // L'acte reste ouvert : rien n'a été effacé sans contrepartie.
    const state = (await (
      await get(cookie, `/api/sessions/${sessionId}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.act_index).toBe(0);
  });

  it("régénère vraiment un récit quand force est demandé", async () => {
    const session = await playingSession("reecrire@example.com");
    mockAnthropicText("# Acte\n\n- fiche");
    await post(session.cookie, `/api/sessions/${session.sessionId}/acts/close`);

    mockAnthropicText("Premier récit.");
    await post(
      session.cookie,
      `/api/sessions/${session.sessionId}/acts/0/narrate`,
    );

    mockAnthropicText("Second récit, réécrit.");
    const res = await post(
      session.cookie,
      `/api/sessions/${session.sessionId}/acts/0/narrate?force=1`,
    );
    const body = (await res.json()) as {
      generated: boolean;
      act: { narrated_summary_md: string };
    };
    expect(body.generated).toBe(true);
    expect(body.act.narrated_summary_md).toBe("Second récit, réécrit.");
  });

  it("garde les sources de lore des actes précédents", async () => {
    const { cookie, sessionId } = await playingSession("lore-actes@example.com");

    mockAnthropicStream([
      'Le <lore term="Sanctuaire" kind="lieu">Sanctuaire</lore> est scellé ' +
        "depuis mille ans. Que fais-tu ?",
    ]);
    await (
      await post(cookie, `/api/sessions/${sessionId}/turn`, {
        player_input: "je regarde autour",
      })
    ).text();

    mockAnthropicText("# Acte un\n\n- le Sanctuaire est scellé");
    await post(cookie, `/api/sessions/${sessionId}/acts/close`);

    // L'acte est clos : les tours qui parlaient du Sanctuaire sont sortis de
    // la fenêtre du modèle, mais la fiche de lore doit toujours les voir.
    await runInDurableObject(stubFor(sessionId), async (instance) => {
      const turns = await (
        instance as unknown as GameSessionInternals
      ).listTurns(1000);
      expect(turns).toHaveLength(0); // rien dans l'acte courant
    });

    mockAnthropicText("Le Sanctuaire est un lieu scellé depuis mille ans.");
    const res = await get(
      cookie,
      `/api/sessions/${sessionId}/lore?term=Sanctuaire&kind=lieu`,
    );
    expect(res.status).toBe(200);
    const fiche = (await res.json()) as { sources?: unknown[] };
    // La fiche s'appuie encore sur la narration passée, pas sur le seul canon.
    expect(JSON.stringify(fiche)).toContain("scellé");
  });
});
