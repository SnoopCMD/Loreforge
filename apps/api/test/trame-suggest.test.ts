// Fils rouges proposés à la mise en place (SPEC §4).
//
// Le champ libre reste la voie principale : ces propositions ne servent qu'à
// sortir de la page blanche. Deux exigences comptent — elles coûtent un appel
// au modèle SEULEMENT quand on les demande, et deux propositions identiques ne
// seraient pas un choix.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  lastAnthropicPrompt,
  mockAnthropicStream,
  mockAnthropicText,
} from "./anthropic-mock";
import { buildTramePrompt, parseTrames, TRAME_SUGGESTIONS } from "../src/sessions/trame";

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

const CANON = "# Les Mondes Fêlés\n\nLa Garde Blanche veille sur les failles de Karnos.";

/** Session solo en mise en place : le moment exact où l'on pose son fil rouge. */
async function enMiseEnPlace(prefix: string): Promise<{
  cookie: string;
  sessionId: string;
}> {
  const cookie = await login(`${prefix}@example.com`);
  const bibleRes = await post(cookie, "/api/bibles", { markdown: CANON });
  const { id: bibleId } = (await bibleRes.json()) as { id: string };
  const charRes = await post(cookie, "/api/characters", {
    bible_id: bibleId,
    name: "Kael",
    sheet_json: { pouvoir: "marche-faille" },
  });
  const { id: characterId } = (await charRes.json()) as { id: string };

  const createRes = await post(cookie, "/api/sessions", {
    bible_id: bibleId,
    character_id: characterId,
    format: "campaign",
  });
  expect(createRes.status).toBe(201);
  const { session_id } = (await createRes.json()) as { session_id: string };
  return { cookie, sessionId: session_id };
}

const DEUX = {
  trames: [
    "Retrouver la trace de la Garde Blanche et découvrir ce qu'elle cache.",
    "Refermer la faille de Karnos avant qu'elle n'avale le quartier bas.",
  ],
};

describe("POST /api/sessions/:id/trame/suggest", () => {
  it("rend deux pistes ancrées dans le canon, à la demande", async () => {
    const { cookie, sessionId } = await enMiseEnPlace("trame-hote");

    mockAnthropicText(JSON.stringify(DEUX));
    const res = await post(cookie, `/api/sessions/${sessionId}/trame/suggest`);
    expect(res.status).toBe(200);
    const { trames } = (await res.json()) as { trames: string[] };
    expect(trames).toHaveLength(TRAME_SUGGESTIONS);
    expect(trames[0]).toContain("Garde Blanche");

    // Le modèle a bien reçu la bible ET le personnage assis : un fil rouge qui
    // ne donne rien à faire au personnage ne sert à personne.
    const envoye = lastAnthropicPrompt();
    expect(envoye).toContain("La Garde Blanche veille");
    expect(envoye).toContain("Kael");
    expect(envoye).toContain("campagne");
  });

  it("ne coûte rien tant qu'on ne les demande pas", async () => {
    // Créer la session et ouvrir la mise en place n'appelle pas le modèle :
    // assertAnthropicMockConsumed le garantit, aucun mock n'ayant été posé.
    const { cookie, sessionId } = await enMiseEnPlace("trame-gratuit");
    const state = await SELF.fetch(
      `${BASE}/api/sessions/${sessionId}/state`,
      { headers: { cookie } },
    );
    expect(state.status).toBe(200);
  });

  it("réserve les suggestions à l'hôte", async () => {
    const { cookie, sessionId } = await enMiseEnPlace("trame-invite");
    const { code } = (await (
      await post(cookie, `/api/sessions/${sessionId}/invite`)
    ).json()) as { code: string };
    const joueur = await login("trame-invite-joueur@example.com");
    await post(joueur, "/api/sessions/join", { code });

    const res = await post(joueur, `/api/sessions/${sessionId}/trame/suggest`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("host_only");
  });

  it("refuse une fois la partie lancée : le fil rouge se pose avant", async () => {
    const { cookie, sessionId } = await enMiseEnPlace("trame-tard");
    mockAnthropicStream(["La brume s'ouvre. Que fais-tu ?"]);
    await (
      await post(cookie, `/api/sessions/${sessionId}/setup`, { answers: [] })
    ).text();

    const res = await post(cookie, `/api/sessions/${sessionId}/trame/suggest`);
    expect(res.status).toBe(409);
    expect((await res.json()) as { status: string }).toMatchObject({
      error: "invalid_status",
      status: "playing",
    });
  });

  it("un modèle qui déraille ne casse pas la mise en place", async () => {
    const { cookie, sessionId } = await enMiseEnPlace("trame-rate");
    mockAnthropicText("pas du JSON");
    const res = await post(cookie, `/api/sessions/${sessionId}/trame/suggest`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "trame_suggest_failed",
    );
  });
});

describe("parseTrames — deux propositions, vraiment deux", () => {
  it("nettoie les guillemets et borne la longueur", () => {
    const trames = parseTrames({
      trames: ["  « Refermer la faille »  ", "Retrouver la Garde Blanche"],
    });
    expect(trames).toEqual(["Refermer la faille", "Retrouver la Garde Blanche"]);
  });

  it("refuse un doublon : ce ne serait pas un choix", () => {
    expect(parseTrames({ trames: ["Même piste", "Même piste"] })).toBeNull();
  });

  it("refuse une liste incomplète ou mal formée", () => {
    expect(parseTrames({ trames: ["Une seule"] })).toBeNull();
    expect(parseTrames({ trames: [42, null] })).toBeNull();
    expect(parseTrames({})).toBeNull();
  });
});

describe("buildTramePrompt", () => {
  it("dit au modèle qu'il n'y a encore personne à la table", () => {
    const prompt = buildTramePrompt({
      bibleTitle: "Les Mondes Fêlés",
      canonMd: CANON,
      format: "oneshot",
      characters: [],
    });
    expect(prompt).toContain("Personne n'est encore assis");
    expect(prompt).toContain("one-shot");
  });

  it("nomme les personnages assis quand il y en a", () => {
    const prompt = buildTramePrompt({
      bibleTitle: "Les Mondes Fêlés",
      canonMd: CANON,
      format: "campaign",
      characters: ["Kael", "Mira"],
    });
    expect(prompt).toContain("Kael, Mira");
    expect(prompt).not.toContain("Personne n'est encore assis");
  });
});
