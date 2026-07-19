// §6bis — Incarner vs Créer : schéma de fiche et personnages jouables
// produits par l'analyse, questionnaire éclair, suggestion ✨, validation.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicText,
} from "./anthropic-mock";

const BASE = "http://loreforge.test";

beforeAll(() => {
  installAnthropicMock();
});

afterEach(() => {
  assertAnthropicMockConsumed();
});

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

async function createBible(cookie: string): Promise<string> {
  const res = await post(cookie, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles. Kael veille.",
  });
  const { id } = (await res.json()) as { id: string };
  return id;
}

const ANALYSIS_PAYLOAD = {
  cosmology: 8, characters: 6, plots: 7, tone: 5, geography: 4,
  gaps: [{ axis: "geography", description: "Aucune carte." }],
  sheet_fields: [
    {
      key: "temperament", label: "Tempérament", type: "text",
      options: [], suggestions: ["Fervent", "Sceptique"], hint: "",
    },
    {
      key: "faille", label: "Faille liée", type: "select",
      options: ["Faille du Nord", "Faille Muette"], suggestions: [], hint: "",
    },
  ],
  playable_characters: [
    {
      name: "Kael",
      sheet: [
        { key: "concept", value: "Veilleur des failles" },
        { key: "faille", value: "Faille du Nord" },
      ],
    },
  ],
};

/** Lance l'analyse (mockée) et attend son aboutissement. */
async function analyze(
  cookie: string,
  bibleId: string,
  payload: unknown = ANALYSIS_PAYLOAD,
): Promise<void> {
  mockAnthropicText(JSON.stringify(payload));
  const res = await post(cookie, `/api/bibles/${bibleId}/analyze`);
  expect(res.status).toBe(202);
  for (let i = 0; i < 50; i++) {
    const poll = await get(cookie, `/api/bibles/${bibleId}/richness`);
    const body = (await poll.json()) as { status: string };
    if (body.status === "analyzed") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("analyse mockée jamais aboutie");
}

describe("analyse §6bis : schéma de fiche + personnages jouables", () => {
  it("expose le schéma dérivé et les personnages canon", async () => {
    const cookie = await login("embody@example.com");
    const bibleId = await createBible(cookie);
    await analyze(cookie, bibleId);

    const schemaRes = await get(cookie, `/api/bibles/${bibleId}/sheet-schema`);
    expect(schemaRes.status).toBe(200);
    const schema = (await schemaRes.json()) as {
      status: string;
      version: number;
      schema: { fields: Array<{ key: string; type: string; suggestions: string[] }> };
    };
    expect(schema.status).toBe("ready");
    expect(schema.version).toBe(1);
    const keys = schema.schema.fields.map((f) => f.key);
    // Champs de base toujours présents + champ spécifique au monde.
    for (const k of ["name", "concept", "temperament", "ability", "weakness", "hook"]) {
      expect(keys).toContain(k);
    }
    expect(keys).toContain("faille");
    expect(
      schema.schema.fields.find((f) => f.key === "temperament")!.suggestions,
    ).toEqual(["Fervent", "Sceptique"]);

    const playableRes = await get(cookie, `/api/bibles/${bibleId}/playable`);
    const { characters } = (await playableRes.json()) as {
      characters: Array<Record<string, unknown>>;
    };
    expect(characters).toHaveLength(1);
    expect(characters[0].name).toBe("Kael");
    expect(characters[0].origin).toBe("canon");
    expect((characters[0].sheet as Record<string, string>).faille).toBe("Faille du Nord");

    // La liste générale inclut le canon.
    const all = (await (
      await get(cookie, `/api/characters?bible_id=${bibleId}`)
    ).json()) as { characters: Array<Record<string, unknown>> };
    expect(all.characters.some((ch) => ch.name === "Kael" && ch.is_canon === true)).toBe(true);
  });

  it("la ré-analyse versionne le schéma et met à jour le canon sans dupliquer", async () => {
    const cookie = await login("embody2@example.com");
    const bibleId = await createBible(cookie);
    await analyze(cookie, bibleId);
    await analyze(cookie, bibleId, {
      ...ANALYSIS_PAYLOAD,
      playable_characters: [
        { name: "Kael", sheet: [{ key: "concept", value: "Veilleur déchu" }] },
      ],
    });

    const schema = (await (
      await get(cookie, `/api/bibles/${bibleId}/sheet-schema`)
    ).json()) as { version: number };
    expect(schema.version).toBe(2);

    const { characters } = (await (
      await get(cookie, `/api/bibles/${bibleId}/playable`)
    ).json()) as { characters: Array<Record<string, unknown>> };
    expect(characters).toHaveLength(1);
    expect((characters[0].sheet as Record<string, string>).concept).toBe("Veilleur déchu");
  });
});

describe("questionnaire éclair (Incarner-express)", () => {
  it("génère les questions puis la fiche complète (origin = quick)", async () => {
    const cookie = await login("quiz@example.com");
    const bibleId = await createBible(cookie);

    mockAnthropicText(
      JSON.stringify({
        questions: [
          {
            question: "Quel genre ?",
            choices: [
              { label: "Femme", description: "" },
              { label: "Homme", description: "" },
            ],
          },
          {
            question: "Quel pouvoir des failles ?",
            choices: [
              { label: "Écho", description: "Renvoie les sorts adverses." },
              { label: "Verrou", description: "Scelle une faille d'un mot." },
              { label: "Chant", description: "Ouvre les failles par la voix." },
            ],
          },
        ],
      }),
    );
    const quizRes = await post(cookie, "/api/characters/embody-quiz", {
      bible_id: bibleId,
    });
    expect(quizRes.status).toBe(200);
    const { questions } = (await quizRes.json()) as {
      questions: Array<{ question: string; choices: Array<{ label: string; description: string }> }>;
    };
    expect(questions).toHaveLength(2);
    expect(questions[1].choices.map((c) => c.label)).toContain("Écho");
    expect(questions[1].choices[0].description).not.toBe("");

    mockAnthropicText(
      JSON.stringify({
        name: "Sel des Brumes",
        sheet: [
          { key: "concept", value: "Contrebandier au chant des failles" },
          { key: "temperament", value: "Sceptique" },
        ],
      }),
    );
    const charRes = await post(cookie, "/api/characters/embody-quiz/answers", {
      bible_id: bibleId,
      answers: [{ question: questions[0].question, answer: "Chant" }],
    });
    expect(charRes.status).toBe(201);
    const ch = (await charRes.json()) as Record<string, unknown>;
    expect(ch.name).toBe("Sel des Brumes");
    expect(ch.origin).toBe("quick");
    expect((ch.sheet as Record<string, string>).temperament).toBe("Sceptique");

    // La session accepte la fiche et le mode §6bis.
    const sess = await post(cookie, "/api/sessions", {
      bible_id: bibleId,
      character_id: ch.id,
      character_mode: "embody_quiz",
      format: "oneshot",
    });
    expect(sess.status).toBe(201);
  });
});

describe("suggestion ✨ et validation de fiche", () => {
  it("suggère un champ et relit la fiche", async () => {
    const cookie = await login("forge@example.com");
    const bibleId = await createBible(cookie);

    mockAnthropicText(JSON.stringify({ value: "Entend le chant des failles" }));
    const suggest = await post(cookie, "/api/characters/suggest", {
      bible_id: bibleId,
      field_key: "ability",
      sheet: { name: "Vera" },
    });
    expect(suggest.status).toBe(200);
    expect(((await suggest.json()) as { value: string }).value).toBe(
      "Entend le chant des failles",
    );

    mockAnthropicText(
      JSON.stringify({
        issues: [
          { field: "ability", severity: "blocking", message: "Ce pouvoir n'existe pas ici." },
          { field: "hook", severity: "info", message: "Zone grise à interpréter." },
        ],
      }),
    );
    const validate = await post(cookie, "/api/characters/validate", {
      bible_id: bibleId,
      sheet: { name: "Vera", ability: "Contrôle du temps" },
    });
    expect(validate.status).toBe(200);
    const { issues } = (await validate.json()) as {
      issues: Array<{ severity: string }>;
    };
    expect(issues).toHaveLength(2);
    expect(issues[0].severity).toBe("blocking");
  });

  it("valide les entrées : field_key manquant, mode de session inconnu", async () => {
    const cookie = await login("forge2@example.com");
    const bibleId = await createBible(cookie);

    expect(
      (
        await post(cookie, "/api/characters/suggest", {
          bible_id: bibleId,
          sheet: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(cookie, "/api/sessions", {
          bible_id: bibleId,
          format: "oneshot",
          character_mode: "téléportation",
        })
      ).status,
    ).toBe(400);
  });
});
