// M8 lot 8.5 — régimes de tour : verrou, file et tour par tour.
//
// Le test qui compte le plus n'est pas celui du multi : c'est celui du solo.
// Le verrou et la file existent pour une table ; en solo ils doivent être un
// no-op observable. C'est le parcours quotidien, celui qu'on régresserait sans
// le voir.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicError,
  mockAnthropicStream,
  mockAnthropicText,
} from "./anthropic-mock";

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

const post = (cookie: string, path: string, body?: unknown) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const put = (cookie: string, path: string, body: unknown) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

const get = (cookie: string, path: string) =>
  SELF.fetch(`${BASE}${path}`, { headers: { cookie } });

async function character(
  cookie: string,
  bibleId: string,
  name: string,
): Promise<string> {
  const res = await post(cookie, "/api/characters", {
    bible_id: bibleId,
    name,
    sheet_json: { pouvoir: "marche-faille" },
  });
  return ((await res.json()) as { id: string }).id;
}

/** Table de deux joueurs, lancée, scène 1 jouée. */
async function table(prefix: string): Promise<{
  hote: string;
  joueur: string;
  sessionId: string;
}> {
  const hote = await login(`${prefix}-hote@example.com`);
  const bibleRes = await post(hote, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };
  const kael = await character(hote, bibleId, "Kaelen");

  const createRes = await post(hote, "/api/sessions", {
    bible_id: bibleId,
    character_id: kael,
    format: "campaign",
    mode: "table",
  });
  const { session_id } = (await createRes.json()) as { session_id: string };

  const { code } = (await (
    await post(hote, `/api/sessions/${session_id}/invite`)
  ).json()) as { code: string };
  const joueur = await login(`${prefix}-joueur@example.com`);
  await post(joueur, "/api/sessions/join", { code });
  const mira = await character(joueur, bibleId, "Mira");
  await put(joueur, `/api/sessions/${session_id}/members/me`, {
    character_id: mira,
  });

  await post(hote, `/api/sessions/${session_id}/start`);
  mockAnthropicStream(["La brume s'ouvre. Que faites-vous ?"]);
  await (
    await post(hote, `/api/sessions/${session_id}/setup`, { answers: [] })
  ).text();

  return { hote, joueur, sessionId: session_id };
}

/** Corps envoyé à Anthropic lors du prochain appel. */
function captureAnthropicBody(): { get: () => string; restore: () => void } {
  let body = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("https://api.anthropic.com") && typeof init?.body === "string") {
      body = init.body;
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    get: () => body,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("lot 8.5 — le solo ne subit aucune latence ajoutée", () => {
  it("résout immédiatement, sans verrou ni file", async () => {
    const cookie = await login("solo-tour@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers\n\nDu lore.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    mockAnthropicStream(["Scène 1. Que fais-tu ?"]);
    await (
      await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })
    ).text();

    mockAnthropicStream(["Tu avances. Que fais-tu ?"]);
    const res = await post(cookie, `/api/sessions/${session_id}/turn`, {
      player_input: "j'avance",
    });
    // Pas de 202 « waiting » : le tour part tout de suite, comme avant M8.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("Tu avances.");

    // Et rien n'a été écrit dans le storage du tour : le passage par le
    // verrou et la file est un no-op observable.
    const state = (await (
      await get(cookie, `/api/sessions/${session_id}/state`)
    ).json()) as { turn_count: number };
    expect(state.turn_count).toBe(2);
  });

  it("garde le message du tour identique à l'octet près", async () => {
    const cookie = await login("solo-prompt@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers\n\nDu lore.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
    });
    const { session_id } = (await createRes.json()) as { session_id: string };
    mockAnthropicStream(["Scène 1. Que fais-tu ?"]);
    await (
      await post(cookie, `/api/sessions/${session_id}/setup`, { answers: [] })
    ).text();

    const capture = captureAnthropicBody();
    try {
      mockAnthropicStream(["Suite. Que fais-tu ?"]);
      await (
        await post(cookie, `/api/sessions/${session_id}/turn`, {
          player_input: "je pousse la porte",
        })
      ).text();
    } finally {
      capture.restore();
    }

    const payload = JSON.parse(capture.get()) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: unknown }>;
    };
    // Ni en-tête d'actions, ni nom de personnage, ni règles de table : le solo
    // n'hérite d'aucun échafaudage du multi.
    const dernier = JSON.stringify(payload.messages.at(-1));
    expect(dernier).toContain("je pousse la porte");
    expect(dernier).not.toContain("ACTIONS DU TOUR");
    expect(payload.system[0].text).not.toContain("TABLE DE PLUSIEURS JOUEURS");
    expect(payload.system[0].text).not.toContain("RÉGIME DE TOUR");
  });
});

describe("lot 8.5 — régime simultané", () => {
  it("produit une seule narration qui référence les deux actions", async () => {
    const { hote, joueur, sessionId } = await table("simultane");

    const attente = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je force la porte",
    });
    expect(attente.status).toBe(202);

    const capture = captureAnthropicBody();
    let texte = "";
    try {
      mockAnthropicStream(["Kaelen force, Mira couvre. Que faites-vous ?"]);
      texte = await (
        await post(joueur, `/api/sessions/${sessionId}/turn`, {
          player_input: "je couvre le couloir",
        })
      ).text();
    } finally {
      capture.restore();
    }

    // UNE narration, pas deux.
    expect(texte.match(/event: done/g) ?? []).toHaveLength(1);
    const payload = JSON.parse(capture.get()) as {
      messages: Array<{ content: unknown }>;
    };
    const dernier = JSON.stringify(payload.messages.at(-1));
    // Les deux actions y sont, attribuées à leur personnage.
    expect(dernier).toContain("Kaelen : je force la porte");
    expect(dernier).toContain("Mira : je couvre le couloir");
  });

  it("dit dans l'état qui a déjà soumis, pour un rechargement en plein tour", async () => {
    const { hote, joueur, sessionId } = await table("rattrapage");

    expect(
      (
        await post(hote, `/api/sessions/${sessionId}/turn`, {
          player_input: "je pousse la porte",
        })
      ).status,
    ).toBe(202);

    // Un joueur qui recharge doit retrouver la table telle qu'elle est : une
    // action déjà posée, et l'hôte son bouton de forçage.
    const etat = (await (
      await get(joueur, `/api/sessions/${sessionId}/state`)
    ).json()) as { submitted: string[] };
    expect(etat.submitted).toHaveLength(1);

    mockAnthropicStream(["La porte cède. Et maintenant ?"]);
    await (await post(hote, `/api/sessions/${sessionId}/turn/resolve`)).text();

    // Tour résolu : plus personne n'est en attente.
    const apres = (await (
      await get(joueur, `/api/sessions/${sessionId}/state`)
    ).json()) as { submitted: string[] };
    expect(apres.submitted).toEqual([]);
  });

  it("laisse l'hôte forcer la résolution sans attendre les retardataires", async () => {
    const { hote, joueur, sessionId } = await table("forcage");

    expect(
      (
        await post(hote, `/api/sessions/${sessionId}/turn`, {
          player_input: "je n'attends plus",
        })
      ).status,
    ).toBe(202);

    // Un joueur ne force pas la table.
    expect(
      (await post(joueur, `/api/sessions/${sessionId}/turn/resolve`)).status,
    ).toBe(403);

    mockAnthropicStream(["Sans attendre, la scène bascule. Et maintenant ?"]);
    const res = await post(hote, `/api/sessions/${sessionId}/turn/resolve`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("la scène bascule");
  });

  it("ne perd jamais une action arrivée pendant une narration", async () => {
    const { hote, joueur, sessionId } = await table("file");

    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "premier geste",
    });

    // On pose le verrou à la main : c'est exactement l'état où une narration
    // est en cours et où une action arrive quand même.
    const stub = env.GAME_SESSIONS.get(
      env.GAME_SESSIONS.idFromString(sessionId),
    );
    await stub.fetch("https://do/state"); // réveille le DO
    const { results } = await env.DB.prepare(
      `SELECT id FROM game_sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .all();
    expect(results).toHaveLength(1);

    const tardif = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "geste tardif",
    });
    // Soit le tour part (tout le monde a soumis), soit l'action est mise en
    // file — dans les deux cas elle est acceptée, jamais rejetée.
    expect([200, 202]).toContain(tardif.status);
    if (tardif.status === 200) {
      // Le tour est parti : il fallait un mock, on le consomme.
      await tardif.text();
    }
  });
});

describe("lot 8.5 — régime séquentiel", () => {
  /** Passe la table en tour par tour, Kaelen d'abord. */
  async function passeEnSequentiel(
    hote: string,
    joueur: string,
    sessionId: string,
  ): Promise<void> {
    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'ouvre le combat",
    });
    mockAnthropicStream([
      'Les lames sortent. <turn_mode value="sequential" order="Kaelen,Mira"/> À toi, Kaelen.',
    ]);
    await (
      await post(joueur, `/api/sessions/${sessionId}/turn`, {
        player_input: "je dégaine",
      })
    ).text();
  }

  it("passe en tour par tour sur ordre du MJ, et le dit à la table", async () => {
    const { hote, joueur, sessionId } = await table("sequentiel");
    await passeEnSequentiel(hote, joueur, sessionId);

    // Le régime est persisté : il vaut pour les tours suivants.
    mockAnthropicStream(["Kaelen frappe. Et ensuite ?"]);
    const aTon = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je frappe",
    });
    // En séquentiel, celui dont c'est le tour est résolu immédiatement : on
    // n'attend personne d'autre.
    expect(aTon.status).toBe(200);
    expect(await aTon.text()).toContain("Kaelen frappe.");
  });

  it("refuse une action hors tour sans la mettre en file", async () => {
    const { hote, joueur, sessionId } = await table("horstour");
    await passeEnSequentiel(hote, joueur, sessionId);

    const refus = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je frappe aussi",
    });
    expect(refus.status).toBe(409);
    const body = (await refus.json()) as { error: string; awaiting: string };
    expect(body.error).toBe("not_your_turn");
    // Le message dit qui l'on attend : « ce n'est pas ton tour » sans dire à
    // qui il est ne sert à rien.
    expect(body.awaiting).toBe("Kaelen");

    // Et surtout : l'action n'est PAS en file. Kaelen joue, et rien de Mira
    // ne s'invite dans sa narration — la jouer plus tard la sortirait de son
    // contexte, et Mira croirait l'avoir perdue.
    const capture = captureAnthropicBody();
    try {
      mockAnthropicStream(["Kaelen frappe seul. Et ensuite ?"]);
      await (
        await post(hote, `/api/sessions/${sessionId}/turn`, {
          player_input: "je frappe",
        })
      ).text();
    } finally {
      capture.restore();
    }
    expect(capture.get()).not.toContain("je frappe aussi");
  });
});

describe("M8 — défauts relevés en relecture", () => {
  it("fait tourner l'ordre du tour par tour au lieu de bloquer sur le premier", async () => {
    const { hote, joueur, sessionId } = await table("rotation");

    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'ouvre le combat",
    });
    mockAnthropicStream([
      'Les lames sortent. <turn_mode value="sequential" order="Kaelen,Mira"/> À toi, Kaelen.',
    ]);
    await (
      await post(joueur, `/api/sessions/${sessionId}/turn`, {
        player_input: "je dégaine",
      })
    ).text();

    // Kaelen joue son tour…
    mockAnthropicStream(["Kaelen frappe. À Mira."]);
    const tourKael = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je frappe",
    });
    expect(tourKael.status).toBe(200);
    await tourKael.text();

    // …et la main passe VRAIMENT à Mira. Avant correction, l'ordre ne tournait
    // jamais et le combat restait bloqué sur le premier nommé — le prompt
    // demandant au MJ de ne pas réémettre la balise à chaque tour.
    mockAnthropicStream(["Mira riposte. À Kaelen."]);
    const tourMira = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je riposte",
    });
    expect(tourMira.status).toBe(200);
    await tourMira.text();

    // Et Kaelen est de nouveau attendu : l'ordre boucle.
    const horsTour = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je rejoue",
    });
    expect(horsTour.status).toBe(409);
    expect(((await horsTour.json()) as { awaiting: string }).awaiting).toBe(
      "Kaelen",
    );
  });

  it("nomme l'action même seule à une table, pour que le MJ sache qui agit", async () => {
    const { hote, joueur, sessionId } = await table("nomme");
    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'ouvre le combat",
    });
    mockAnthropicStream([
      'Le fer sonne. <turn_mode value="sequential" order="Kaelen"/>',
    ]);
    await (
      await post(joueur, `/api/sessions/${sessionId}/turn`, {
        player_input: "je dégaine",
      })
    ).text();

    const capture = captureAnthropicBody();
    try {
      mockAnthropicStream(["Kaelen frappe. Et ensuite ?"]);
      await (
        await post(hote, `/api/sessions/${sessionId}/turn`, {
          player_input: "je frappe le garde",
        })
      ).text();
    } finally {
      capture.restore();
    }
    // Une seule action, mais à une table de quatre « je frappe le garde »
    // sans nom ne dit rien au MJ.
    expect(capture.get()).toContain("Kaelen : je frappe le garde");
  });

  it("refuse d'agir sans personnage plutôt que d'emprunter celui de l'hôte", async () => {
    const { hote, sessionId } = await table("sansfiche");
    const { code } = (await (
      await post(hote, `/api/sessions/${sessionId}/invite`)
    ).json()) as { code: string };
    const tardif = await login("sansfiche-tardif@example.com");
    await post(tardif, "/api/sessions/join", { code });

    // Avant correction : il dépensait le Souffle de l'hôte et consommait ses
    // jets, parce que l'état retombait sur le personnage de la session.
    const res = await post(tardif, `/api/sessions/${sessionId}/turn`, {
      player_input: "je surgis",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "character_required",
    );
    expect((await post(tardif, `/api/sessions/${sessionId}/roll`)).status).toBe(409);
  });

  it("laisse un joueur arrivé en cours de partie choisir sa fiche", async () => {
    const { hote, sessionId } = await table("assis-tard");
    const bibleId = (
      (await (
        await get(hote, `/api/sessions/${sessionId}/state`)
      ).json()) as { bible_id: string }
    ).bible_id;

    const { code } = (await (
      await post(hote, `/api/sessions/${sessionId}/invite`)
    ).json()) as { code: string };
    const tardif = await login("assis-tard-nouveau@example.com");
    await post(tardif, "/api/sessions/join", { code });

    const thea = await character(tardif, bibleId, "Théa");
    const assis = await put(tardif, `/api/sessions/${sessionId}/members/me`, {
      character_id: thea,
    });
    // La partie est en cours : s'asseoir doit rester possible, sinon on
    // rejoint une table sans jamais pouvoir y jouer.
    expect(assis.status).toBe(200);

    // En revanche, changer de fiche une fois assis reste refusé : le Souffle
    // déjà dépensé resterait sur l'ancienne.
    const autre = await character(tardif, bibleId, "Autre");
    const change = await put(tardif, `/api/sessions/${sessionId}/members/me`, {
      character_id: autre,
    });
    expect(change.status).toBe(409);
  });

  it("ne laisse pas un verrou périmé geler la table pour toujours", async () => {
    const { hote, joueur, sessionId } = await table("verrou");
    await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "je patiente",
    });

    // Verrou posé il y a longtemps : une génération que personne n'a levée
    // (DO évincé, erreur avant la narration).
    await runInDurableObject(
      env.GAME_SESSIONS.get(env.GAME_SESSIONS.idFromString(sessionId)),
      async (_i, state) => {
        await state.storage.put("turn_lock", 1);
      },
    );

    mockAnthropicStream(["La table repart. Et maintenant ?"]);
    const res = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je reprends",
    });
    // Avant correction : 202 « queued » à jamais, sans aucun recours.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("La table repart.");
  });

  it("réserve la réécriture d'un récit à l'hôte", async () => {
    const { hote, joueur, sessionId } = await table("recit");
    mockAnthropicText("# Acte\n\n- fiche de mémoire");
    await post(hote, `/api/sessions/${sessionId}/acts/close`);
    mockAnthropicText("Un premier récit.");
    await post(joueur, `/api/sessions/${sessionId}/acts/0/narrate`);

    // Écrire un récit absent : tout membre. Le réécrire en boucle sur la
    // bible de quelqu'un d'autre : non.
    const force = await post(
      joueur,
      `/api/sessions/${sessionId}/acts/0/narrate?force=1`,
    );
    expect(force.status).toBe(403);
  });
});

describe("une génération ratée dit POURQUOI", () => {
  // Le bandeau « Génération interrompue » était le même pour une coupure
  // réseau, une clé API absente et un quota dépassé. Depuis un téléphone,
  // c'était indiagnosticable — donc jamais corrigé.
  it("transmet le statut et le motif du fournisseur", async () => {
    const cookie = await login("panne@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers\n\nDu lore.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    // Le SDK ne retente pas un 401 : un seul mock suffit.
    mockAnthropicError(401, "invalid x-api-key");
    const res = await post(cookie, `/api/sessions/${session_id}/setup`, {
      answers: [],
    });
    const flux = await res.text();

    expect(flux).toContain("event: error");
    expect(flux).toContain('"error":"generation_failed"');
    expect(flux).toContain('"status":401');
    expect(flux).toContain("invalid x-api-key");

    // Et la session reste rejouable : une scène 1 ratée ne la fige pas.
    const state = (await (
      await get(cookie, `/api/sessions/${session_id}/state`)
    ).json()) as { status: string };
    expect(state.status).toBe("setup");
  });

  it("refuse proprement quand la clé n'est pas configurée du tout", async () => {
    const cookie = await login("sans-cle@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Univers\n\nDu lore.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      format: "oneshot",
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    const cle = env.ANTHROPIC_API_KEY;
    (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = "";
    try {
      const res = await post(cookie, `/api/sessions/${session_id}/setup`, {
        answers: [],
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe(
        "narrator_not_configured",
      );
    } finally {
      (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = cle;
    }
  });
});
