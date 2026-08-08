// Test d'intégration du DO GameSession (DoD M3) : parcours complet
// « jouable en curl » — création, setup SSE, tours, d6 serveur, Souffle,
// invention loggée, fin de session, cache KV.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
  mockAnthropicText,
} from "./anthropic-mock";

const BASE = "http://loreforge.test";

beforeAll(() => {
  installAnthropicMock();
});

afterEach(() => {
  assertAnthropicMockConsumed();
});

// ── Helpers HTTP ──────────────────────────────────────────────────────────

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

// ── Helpers SSE ───────────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function readSse(res: Response): Promise<SseEvent[]> {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      expect(event, `bloc SSE malformé : ${block}`).toBeTruthy();
      return { event: event!, data: JSON.parse(data!) };
    });
}

function narrationOf(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === "narration")
    .map((e) => e.data.text as string)
    .join("");
}

// ── Fixture : bible analysée + personnage ────────────────────────────────

async function setupBible(cookie: string): Promise<string> {
  const res = await post(cookie, "/api/bibles", {
    markdown:
      "# Les Mondes Fêlés\n\nLa magie vient des failles entre les Mondes.",
  });
  const { id } = (await res.json()) as { id: string };

  mockAnthropicText(
    JSON.stringify({
      cosmology: 9,
      characters: 6,
      plots: 8,
      tone: 5,
      geography: 3,
      gaps: [
        { axis: "geography", description: "Aucune carte des Mondes." },
        { axis: "geography", description: "La capitale n'est pas décrite." },
      ],
    }),
  );
  await post(cookie, `/api/bibles/${id}/analyze`);
  for (let i = 0; i < 50; i++) {
    const body = (await (
      await get(cookie, `/api/bibles/${id}/richness`)
    ).json()) as { status: string };
    if (body.status === "analyzed") return id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("analyse trop lente");
}

describe("M3 — moteur de session (DO GameSession)", () => {
  it("parcours complet : setup → tours → d6 → Souffle → finish", async () => {
    const cookie = await login("author@example.com");
    const bibleId = await setupBible(cookie);

    // Personnage (contrat §5).
    const charRes = await post(cookie, "/api/characters", {
      bible_id: bibleId,
      name: "Kael",
      sheet_json: { pouvoir: "marche-faille", temperament: "taciturne" },
    });
    expect(charRes.status).toBe(201);
    const { id: characterId } = (await charRes.json()) as { id: string };

    const list = (await (
      await get(cookie, `/api/characters?bible_id=${bibleId}`)
    ).json()) as { characters: Array<{ name: string }> };
    expect(list.characters.map((c) => c.name)).toEqual(["Kael"]);

    // Création de session : questions issues des lacunes geography (score 3).
    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      character_id: characterId,
      format: "oneshot",
    });
    expect(createRes.status).toBe(201);
    const { session_id, setup_questions } = (await createRes.json()) as {
      session_id: string;
      setup_questions: string[];
    };
    expect(setup_questions).toHaveLength(2);
    expect(setup_questions[0]).toContain("Aucune carte des Mondes.");

    // État initial.
    let state = (await (
      await get(cookie, `/api/sessions/${session_id}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.status).toBe("setup");
    expect(state.souffle).toBe(3);
    expect((state.character as { name: string }).name).toBe("Kael");

    // Setup → scène 1 en SSE.
    mockAnthropicStream([
      "La brume s'ouvre sur ",
      "Karnos. Que fais-tu ?",
      "<scene_break/>",
    ]);
    const setupRes = await post(cookie, `/api/sessions/${session_id}/setup`, {
      answers: ["Trois Mondes reliés par des failles", "Karnos, cité-pont"],
    });
    const setupEvents = await readSse(setupRes);
    expect(narrationOf(setupEvents)).toBe(
      "La brume s'ouvre sur Karnos. Que fais-tu ?",
    );
    expect(setupEvents.some((e) => e.event === "scene_break")).toBe(true);
    expect(setupEvents.at(-1)).toEqual({
      event: "done",
      data: { turn: 1, souffle: 3 },
    });

    // Tour 1 : le MJ demande un jet.
    mockAnthropicStream([
      "Tu t'élances au-dessus de la faille. ",
      '<roll reason="saut au-dessus de la faille" difficulty="hard" ' +
        'stance="advantage" dice="1" skills="Acrobatie"/>',
    ]);
    const turn1 = await readSse(
      await post(cookie, `/api/sessions/${session_id}/turn`, {
        player_input: "Je saute par-dessus la faille.",
      }),
    );
    expect(turn1.find((e) => e.event === "state_patch")?.data).toEqual({
      pending_roll: {
        reason: "saut au-dessus de la faille",
        difficulty: "hard",
        stance: "advantage",
        bonus_dice: 1,
        skills: ["Acrobatie"],
      },
    });

    // Tour interdit tant que le jet n'est pas résolu.
    const blocked = await post(cookie, `/api/sessions/${session_id}/turn`, {
      player_input: "Je continue sans lancer le dé.",
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe(
      "roll_required",
    );

    // Dés serveur : la poignée suit les conditions posées par le MJ
    // (1 dé de base + 1 dé de compétence + 1 dé d'avantage).
    const rollRes = await post(cookie, `/api/sessions/${session_id}/roll`, {
      // Le client ne choisit rien : ces conditions-là doivent être ignorées.
      difficulty: "easy",
      stance: "advantage",
      dice: 4,
    });
    expect(rollRes.status).toBe(200);
    const roll = (await rollRes.json()) as {
      value: number;
      outcome: string;
      reason: string;
      difficulty: string;
      stance: string;
      threshold: number;
      dice: Array<{ value: number; kept: boolean }>;
    };
    expect(roll.value).toBeGreaterThanOrEqual(1);
    expect(roll.value).toBeLessThanOrEqual(6);
    expect(roll.reason).toBe("saut au-dessus de la faille");
    expect(roll.difficulty).toBe("hard");
    expect(roll.stance).toBe("advantage");
    expect(roll.threshold).toBe(5);
    expect(roll.dice).toHaveLength(3);
    expect(roll.dice.filter((d) => d.kept)).toHaveLength(1);
    expect(["critical_failure", "failure", "success", "critical_success"]).toContain(
      roll.outcome,
    );

    // Pas de relance tant que le résultat n'est pas joué (anti-triche).
    const reroll = await post(cookie, `/api/sessions/${session_id}/roll`, {});
    expect(reroll.status).toBe(409);

    // Tour 2 : le résultat est injecté, Souffle -1, invention loggée,
    // compétence et fait enregistrés (mémoire longue).
    mockAnthropicStream([
      "Tu retombes de l'autre côté. ",
      '<souffle delta="-1"/>',
      '<invention axis="geography">La faille de Karnos chante la nuit.',
      "</invention>",
      '<skill name="Saut de faille" tier="apprentissage"/>',
      '<fait texte="Kael a franchi la faille de Karnos."/>',
      "La nuit tombe.",
    ]);
    const turn2 = await readSse(
      await post(cookie, `/api/sessions/${session_id}/turn`, {
        player_input: "Je me relève en brûlant mon Souffle.",
      }),
    );
    // Le résultat du jet ouvre le flux.
    expect(turn2[0].event).toBe("roll");
    expect(turn2[0].data.value).toBe(roll.value);
    expect(turn2.find((e) => e.event === "state_patch")?.data).toEqual({
      souffle: 2,
    });
    expect(
      turn2.find((e) => e.event === "state_patch" && "skills" in e.data)?.data,
    ).toEqual({
      skills: [{ name: "Saut de faille", tier: "apprentissage" }],
    });
    // Les réponses de setup sont déjà des faits : le patch porte la liste à jour.
    const factsPatch = turn2.find(
      (e) => e.event === "state_patch" && "facts" in e.data,
    )?.data.facts as string[];
    expect(factsPatch.at(-1)).toBe("Kael a franchi la faille de Karnos.");
    // L'invention est invisible dans la narration.
    expect(narrationOf(turn2)).toBe(
      "Tu retombes de l'autre côté. La nuit tombe.",
    );
    expect(turn2.at(-1)?.data).toEqual({ turn: 3, souffle: 2 });

    // État consolidé (servi par le cache KV).
    state = (await (
      await get(cookie, `/api/sessions/${session_id}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.status).toBe("playing");
    expect(state.souffle).toBe(2);
    expect(state.turn_count).toBe(3);
    expect(state.pending_roll).toBeNull();
    expect(state.last_roll).toBeNull();
    expect(state.skills).toEqual([
      { name: "Saut de faille", tier: "apprentissage" },
    ]);
    expect((state.facts as string[]).at(-1)).toBe(
      "Kael a franchi la faille de Karnos.",
    );
    const log = state.log as Array<{ role: string; text: string }>;
    expect(log).toHaveLength(6);
    expect(log.at(-1)?.text).not.toContain("invention");
    expect(log.at(-1)?.text).toContain("La nuit tombe.");

    // Fin de session : résumé + inventions, purge KV, D1 à jour.
    mockAnthropicText("## Résumé\n\nKael a franchi la faille de Karnos.");
    const finishRes = await post(
      cookie,
      `/api/sessions/${session_id}/finish`,
    );
    expect(finishRes.status).toBe(200);
    const finish = (await finishRes.json()) as {
      summary_md: string;
      inventions: Array<{ axis: string; content: string }>;
    };
    expect(finish.summary_md).toContain("## Résumé");
    expect(finish.inventions).toEqual([
      {
        axis: "geography",
        content: "La faille de Karnos chante la nuit.",
        turn: 3,
      },
    ]);

    // KV purgé (SPEC §5).
    expect(await env.CACHE.get(`session:${session_id}:state`)).toBeNull();

    // /state relit le DO : session close.
    state = (await (
      await get(cookie, `/api/sessions/${session_id}/state`)
    ).json()) as Record<string, unknown>;
    expect(state.status).toBe("finished");

    // Plus de tours possibles.
    const afterFinish = await post(
      cookie,
      `/api/sessions/${session_id}/turn`,
      { player_input: "Encore un tour ?" },
    );
    expect(afterFinish.status).toBe(409);
  });

  it("valide les entrées de création de session", async () => {
    const cookie = await login("author2@example.com");
    const bibleId = await setupBible(cookie);

    const badFormat = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "marathon",
    });
    expect(badFormat.status).toBe(400);

    const badBible = await post(cookie, "/api/sessions", {
      bible_id: "inexistante",
      format: "oneshot",
    });
    expect(badBible.status).toBe(404);

    const badCharacter = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      character_id: "inexistant",
      format: "oneshot",
    });
    expect(badCharacter.status).toBe(404);
  });

  it("cloisonne les sessions par utilisateur", async () => {
    const alice = await login("alice2@example.com");
    const bob = await login("bob2@example.com");
    const bibleId = await setupBible(alice);

    const { session_id } = (await (
      await post(alice, "/api/sessions", {
        bible_id: bibleId,
        format: "oneshot",
      })
    ).json()) as { session_id: string };

    expect(
      (await get(bob, `/api/sessions/${session_id}/state`)).status,
    ).toBe(404);
    expect(
      (
        await post(bob, `/api/sessions/${session_id}/turn`, {
          player_input: "intrusion",
        })
      ).status,
    ).toBe(404);
    expect(
      (await SELF.fetch(`${BASE}/api/sessions/${session_id}/state`)).status,
    ).toBe(401);
  });

  it("setup exigé avant les tours, et une seule fois", async () => {
    const cookie = await login("author3@example.com");
    const bibleId = await setupBible(cookie);
    const { session_id } = (await (
      await post(cookie, "/api/sessions", {
        bible_id: bibleId,
        format: "oneshot",
      })
    ).json()) as { session_id: string };

    // Tour avant setup → 409.
    const early = await post(cookie, `/api/sessions/${session_id}/turn`, {
      player_input: "Je commence direct.",
    });
    expect(early.status).toBe(409);

    mockAnthropicStream(["Scène 1."]);
    await readSse(
      await post(cookie, `/api/sessions/${session_id}/setup`, {
        answers: [],
      }),
    );

    // Second setup → 409.
    const again = await post(cookie, `/api/sessions/${session_id}/setup`, {
      answers: [],
    });
    expect(again.status).toBe(409);
  });
});
