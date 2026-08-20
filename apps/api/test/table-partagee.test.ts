// M8 — la table partagée, pour de vrai.
//
// Deux bugs se ressemblaient : dans les deux cas, un état qui appartient à
// l'univers ou à la table appartenait en fait à une seule personne. Les
// personnages étaient filtrés par joueur (chacun jouait dans sa copie de la
// bible), et le moteur ignorait qui s'asseyait (le MJ improvisait des fiches
// que deux joueurs venaient d'écrire).
//
// Le test le plus important de ce fichier est le dernier des tests
// d'intégration : il regarde ce que le MJ REÇOIT, pas ce qu'il répond. Vérifier
// sa sortie ne dit rien de son contexte — et c'est exactement là que ça
// cassait, sans que rien n'échoue.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  lastAnthropicPrompt,
  lastAnthropicRequest,
  mockAnthropicStream,
} from "./anthropic-mock";
import { buildSystemPrompt, buildTurnContext } from "../src/sessions/prompt";
import { initialGameState } from "../src/sessions/rules";

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

async function put(
  cookie: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function get(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { cookie } });
}

interface PublicCharacter {
  id: string;
  name: string;
  mine?: boolean;
}

async function listeFiches(
  cookie: string,
  bibleId: string,
): Promise<PublicCharacter[]> {
  const res = await get(cookie, `/api/characters?bible_id=${bibleId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { characters: PublicCharacter[] }).characters;
}

/** Crée une fiche dans une bible (POST /api/characters répond 201, pas 200). */
async function creerFiche(
  cookie: string,
  bibleId: string,
  name: string,
  sheet: Record<string, string>,
): Promise<string> {
  const res = await post(cookie, "/api/characters", {
    bible_id: bibleId,
    name,
    sheet_json: sheet,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Je m'assois avec ce personnage. */
async function assoir(
  cookie: string,
  sessionId: string,
  characterId: string,
): Promise<Response> {
  return put(cookie, `/api/sessions/${sessionId}/members/me`, {
    character_id: characterId,
  });
}

interface Table {
  hote: string;
  joueur: string;
  sessionId: string;
  bibleId: string;
  /** Fiche de l'hôte, qu'il occupe depuis la création de la table. */
  kael: string;
  /** Fiche de l'hôte que PERSONNE n'occupe. */
  sombre: string;
  /** Fiche écrite par l'invité, dans l'univers de l'hôte. */
  mira: string;
}

/**
 * Une table en lobby : l'hôte s'y est assis sur Kael, l'invité a rejoint et
 * écrit sa fiche, mais ne s'est pas encore assis. C'est l'état exact d'où
 * partent les deux bugs.
 *
 * La table naît SANS personnage — c'est le vrai parcours du lobby, et c'est
 * précisément ce qui laissait le moteur avec « pas de fiche de personnage ».
 */
async function tableEnLobby(prefix: string): Promise<Table> {
  const hote = await login(`${prefix}-hote@example.com`);
  const bibleRes = await post(hote, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };

  const kael = await creerFiche(hote, bibleId, "Kael", {
    pouvoir: "marche-faille",
  });
  const sombre = await creerFiche(hote, bibleId, "Sombre", {
    pouvoir: "ombre portée",
  });

  const createRes = await post(hote, "/api/sessions", {
    bible_id: bibleId,
    format: "campaign",
    mode: "table",
  });
  expect(createRes.status).toBe(201);
  const { session_id: sessionId } = (await createRes.json()) as {
    session_id: string;
  };
  // L'hôte prend sa place depuis le lobby, comme n'importe quel joueur.
  expect((await assoir(hote, sessionId, kael)).status).toBe(200);

  const inviteRes = await post(hote, `/api/sessions/${sessionId}/invite`);
  expect(inviteRes.status).toBe(201);
  const { code } = (await inviteRes.json()) as { code: string };

  const joueur = await login(`${prefix}-joueur@example.com`);
  expect((await post(joueur, "/api/sessions/join", { code })).status).toBe(201);

  // L'invité écrit sa fiche DANS l'univers de l'hôte : c'est tout l'objet de
  // findPlayableBible, et le point de départ du bug de liste.
  const mira = await creerFiche(joueur, bibleId, "Mira", {
    pouvoir: "lecture des vents",
  });

  return { hote, joueur, sessionId, bibleId, kael, sombre, mira };
}

describe("les personnages appartiennent à la bible, pas au joueur", () => {
  it("chacun voit toutes les fiches de l'univers, en sachant lesquelles sont les siennes", async () => {
    const { hote, joueur, bibleId } = await tableEnLobby("liste");

    // L'invité arrivait dans un univers vide : il ne voyait aucune fiche de
    // l'hôte, et l'hôte ne retrouvait jamais celle de l'invité.
    const vueJoueur = await listeFiches(joueur, bibleId);
    expect(vueJoueur.map((c) => c.name).sort()).toEqual([
      "Kael",
      "Mira",
      "Sombre",
    ]);
    expect(vueJoueur.find((c) => c.name === "Mira")!.mine).toBe(true);
    expect(vueJoueur.find((c) => c.name === "Kael")!.mine).toBe(false);
    // Mes fiches d'abord : sans ce drapeau et cet ordre, l'interface ne peut
    // pas distinguer ma fiche de celle du voisin.
    expect(vueJoueur[0].name).toBe("Mira");

    const vueHote = await listeFiches(hote, bibleId);
    expect(vueHote.map((c) => c.name).sort()).toEqual([
      "Kael",
      "Mira",
      "Sombre",
    ]);
    expect(vueHote.find((c) => c.name === "Mira")!.mine).toBe(false);
    expect(vueHote.find((c) => c.name === "Kael")!.mine).toBe(true);
    expect(vueHote[vueHote.length - 1].name).toBe("Mira");
  });

  it("un inconnu ne sait même pas que l'univers existe", async () => {
    const { bibleId } = await tableEnLobby("inconnu-liste");
    const inconnu = await login("inconnu-liste@example.com");

    const res = await get(inconnu, `/api/characters?bible_id=${bibleId}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "bible_not_found",
    );
  });

  it("l'invité obtient la forge de l'univers joué, l'inconnu non", async () => {
    const { joueur, bibleId } = await tableEnLobby("forge");
    const inconnu = await login("inconnu-forge@example.com");

    // Sans ça, la forge s'ouvre vide pour un invité : il n'a pas le formulaire
    // de fiche de l'univers dans lequel il joue.
    expect((await get(joueur, `/api/bibles/${bibleId}/sheet-schema`)).status).toBe(200);
    expect((await get(joueur, `/api/bibles/${bibleId}/playable`)).status).toBe(200);

    expect((await get(inconnu, `/api/bibles/${bibleId}/sheet-schema`)).status).toBe(404);
    expect((await get(inconnu, `/api/bibles/${bibleId}/playable`)).status).toBe(404);
  });

  it("voir la fiche d'un autre ne donne pas le droit de la réécrire", async () => {
    const { joueur, kael } = await tableEnLobby("edition");

    // À une table on incarne, on ne réécrit pas : l'édition reste à l'auteur.
    const res = await put(joueur, `/api/characters/${kael}`, {
      name: "Kael le Traître",
    });
    expect(res.status).toBe(404);
  });
});

describe("le siège est exclusif", () => {
  it("un invité s'assoit avec un personnage qui n'est pas le sien", async () => {
    const { joueur, sessionId, sombre } = await tableEnLobby("siege");

    const res = await assoir(joueur, sessionId, sombre);
    expect(res.status).toBe(200);
    expect((await res.json()) as { character_id: string }).toMatchObject({
      ok: true,
      character_id: sombre,
    });
  });

  it("refuse deux joueurs sur la même fiche", async () => {
    const { joueur, sessionId, kael } = await tableEnLobby("double");

    // Le moteur indexe l'état par character_id : deux joueurs sur une même
    // fiche partageraient un seul Souffle, un seul jeu d'acquis, un seul jet.
    const res = await assoir(joueur, sessionId, kael);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "character_taken",
    );
  });

  it("refuse un personnage venu d'un autre univers", async () => {
    const { joueur, sessionId } = await tableEnLobby("ailleurs");
    const autreBible = await post(joueur, "/api/bibles", {
      markdown: "# Autre monde\n\nRien à voir.",
    });
    const { id: autreBibleId } = (await autreBible.json()) as { id: string };
    const etranger = await creerFiche(joueur, autreBibleId, "Étranger", {});

    const res = await assoir(joueur, sessionId, etranger);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "character_not_found",
    );
  });

  it("bloque le lancement tant qu'un membre n'est pas assis, puis le laisse passer", async () => {
    const { hote, joueur, sessionId, mira } = await tableEnLobby("lancement");

    const refus = await post(hote, `/api/sessions/${sessionId}/start`);
    expect(refus.status).toBe(409);
    expect(((await refus.json()) as { error: string }).error).toBe(
      "members_without_character",
    );

    expect((await assoir(joueur, sessionId, mira)).status).toBe(200);

    const lance = await post(hote, `/api/sessions/${sessionId}/start`);
    expect(lance.status).toBe(200);
    expect(((await lance.json()) as { status: string }).status).toBe("setup");
  });
});

/** Tout ce que le modèle a reçu sur le dernier appel, système compris. */
function texteEnvoye(): string {
  return lastAnthropicPrompt();
}

/** Le prompt système seul (le préfixe mis en cache). */
function systemeEnvoye(): string {
  const system = lastAnthropicRequest()?.system;
  if (typeof system === "string") return system;
  return (Array.isArray(system) ? system : [])
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n");
}

/** Le dernier message joueur : c'est lui qui porte [CONTEXTE DU TOUR]. */
function dernierMessageEnvoye(): string {
  const messages = lastAnthropicRequest()?.messages ?? [];
  const dernier = messages[messages.length - 1];
  if (!dernier) return "";
  if (typeof dernier.content === "string") return dernier.content;
  return (Array.isArray(dernier.content) ? dernier.content : [])
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n");
}

describe("le moteur sait qui est à la table", () => {
  it("les fiches des DEUX joueurs arrivent jusqu'au modèle", async () => {
    const { hote, joueur, sessionId, mira } = await tableEnLobby("moteur");
    expect((await assoir(joueur, sessionId, mira)).status).toBe(200);
    expect((await post(hote, `/api/sessions/${sessionId}/start`)).status).toBe(200);

    mockAnthropicStream(["La brume s'ouvre. Que faites-vous ?"]);
    await (
      await post(hote, `/api/sessions/${sessionId}/setup`, { answers: [] })
    ).text();

    // Simultané : le tour part quand tout le monde a soumis.
    const attente = await post(hote, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'ouvre la faille",
    });
    expect(attente.status).toBe(202);

    mockAnthropicStream(["La faille s'élargit."]);
    const resolu = await post(joueur, `/api/sessions/${sessionId}/turn`, {
      player_input: "je lis les vents",
    });
    expect(resolu.status).toBe(200);
    await resolu.text();

    // Le cœur du bug : le MJ improvisait des personnages qui existaient déjà.
    const envoye = texteEnvoye();
    expect(envoye).toContain("marche-faille");
    expect(envoye).toContain("lecture des vents");
    expect(envoye).toContain("Kael");
    expect(envoye).toContain("Mira");
    expect(envoye).not.toContain("improvise une fiche minimale");

    // …et elles voyagent dans le contexte de tour, JAMAIS dans le prompt
    // système : celui-ci est le préfixe mis en cache, il doit rester
    // identique à l'octet près, or les joueurs vont et viennent.
    const systeme = systemeEnvoye();
    expect(systeme).not.toContain("marche-faille");
    expect(systeme).not.toContain("lecture des vents");
    expect(systeme).toContain("Ne les invente jamais");
    expect(dernierMessageEnvoye()).toContain("marche-faille");
  });

  it("le solo garde sa fiche dans le prompt système, et rien dans le contexte de tour", async () => {
    const cookie = await login("solo-moteur@example.com");
    const bibleRes = await post(cookie, "/api/bibles", {
      markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
    });
    const { id: bibleId } = (await bibleRes.json()) as { id: string };
    const kael = await creerFiche(cookie, bibleId, "Kael", {
      pouvoir: "marche-faille",
    });

    const createRes = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      character_id: kael,
      format: "oneshot",
    });
    expect(createRes.status).toBe(201);
    const { session_id: sessionId } = (await createRes.json()) as {
      session_id: string;
    };

    mockAnthropicStream(["La brume s'ouvre. Que fais-tu ?"]);
    await (
      await post(cookie, `/api/sessions/${sessionId}/setup`, { answers: [] })
    ).text();

    mockAnthropicStream(["Tu passes."]);
    const tour = await post(cookie, `/api/sessions/${sessionId}/turn`, {
      player_input: "j'avance",
    });
    expect(tour.status).toBe(200);
    await tour.text();

    // Le solo ne bouge pas d'un octet : la fiche reste au système…
    expect(systemeEnvoye()).toContain("Personnage joueur : Kael");
    expect(systemeEnvoye()).toContain("marche-faille");
    expect(systemeEnvoye()).not.toContain("Ne les invente jamais");
    // …et le message de tour ne la répète pas.
    expect(dernierMessageEnvoye()).not.toContain("Fiche :");
    expect(dernierMessageEnvoye()).toContain("[CONTEXTE DU TOUR");
  });
});

describe("buildTurnContext — la fiche voyage avec l'état", () => {
  const state = {
    ...initialGameState("kael"),
    facts: ["Karnos existe."],
  };

  it("préfixe chaque personnage par sa fiche quand elle est fournie", () => {
    const ctx = buildTurnContext(state, {
      characters: [
        {
          key: "kael",
          name: "Kael",
          sheet: '{"pouvoir":"marche-faille"}',
          state: state.characters.kael,
        },
        {
          key: "mira",
          name: "Mira",
          sheet: '{"pouvoir":"lecture des vents"}',
          state: {
            souffle: 3,
            skills: [],
            pending_roll: null,
            last_roll: null,
          },
        },
      ],
    });
    expect(ctx).toContain("Kael —\nFiche : {\"pouvoir\":\"marche-faille\"}");
    expect(ctx).toContain("Mira —\nFiche : {\"pouvoir\":\"lecture des vents\"}");
    expect(ctx).toContain("Souffle : 3/3");
  });

  it("sans fiche fournie, la sortie est celle d'avant — au caractère près", () => {
    const sansFiche = buildTurnContext(state, {
      characters: [
        { key: "kael", name: "Kael", state: state.characters.kael },
      ],
    });
    const avecChampVide = buildTurnContext(state, {
      characters: [
        { key: "kael", name: "Kael", sheet: null, state: state.characters.kael },
      ],
    });
    expect(sansFiche).not.toContain("Fiche :");
    expect(avecChampVide).toBe(sansFiche);
  });
});

describe("buildSystemPrompt — table contre solo", () => {
  const base = {
    bibleTitle: "Les Mondes Fêlés",
    canonMd: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
    scores: null,
    gaps: [],
    toneProfile: null,
    characterName: "Kael",
    characterSheet: '{"pouvoir":"marche-faille"}',
    format: "campaign",
    trame: null,
  };

  it("à une table, renvoie le MJ au contexte de tour au lieu d'une fiche figée", () => {
    const table = buildSystemPrompt({ ...base, multiplayer: true });
    expect(table).toContain("[CONTEXTE DU TOUR]");
    expect(table).toContain("Ne les invente jamais");
    // Aucune fiche ici : ce bloc est mis en cache et les joueurs vont et viennent.
    expect(table).not.toContain("marche-faille");
    expect(table).not.toContain("Personnage joueur : Kael");
    expect(table).not.toContain("improvise une fiche minimale");
  });

  it("le solo est inchangé, avec ou sans personnage", () => {
    const solo = buildSystemPrompt(base);
    expect(solo).toContain("Personnage joueur : Kael");
    expect(solo).toContain("marche-faille");
    expect(solo).not.toContain("Ne les invente jamais");

    const sansFiche = buildSystemPrompt({
      ...base,
      characterName: null,
      characterSheet: null,
    });
    expect(sansFiche).toContain("improvise une fiche minimale");
  });
});
