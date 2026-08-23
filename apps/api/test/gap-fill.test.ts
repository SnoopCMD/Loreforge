// Comblement d'une zone floue : la réponse de l'auteur est réécrite DANS les
// sections concernées, pas empilée à leur suite. Logique pure (choix des
// sections candidates, validation de la sortie du modèle) et parcours complet
// — proposer, relire, écrire.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  lastAnthropicPrompt,
  mockAnthropicError,
  mockAnthropicText,
} from "./anthropic-mock";
import {
  appendEdit,
  MAX_GAP_EDITS,
  MAX_REWRITABLE_CHARS,
  parseGapFill,
  selectGapCandidates,
} from "../src/richness/gap-fill";
import type { SectionRow } from "../src/bibles/sections";

const BASE = "http://loreforge.test";

beforeAll(() => installAnthropicMock());
afterEach(() => assertAnthropicMockConsumed());

function section(over: Partial<SectionRow> = {}): SectionRow {
  return {
    id: "sec-1",
    bible_id: "b1",
    title: "Cosmologie & règles du monde",
    content_md: "La sorcellerie se lance à la voix.",
    is_base: 1,
    axis: "cosmology",
    sort_order: 0,
    updated_at: 0,
    parent_id: null,
    kind: "section",
    ...over,
  };
}

// ── Unitaires (purs) ───────────────────────────────────────────────────────

describe("selectGapCandidates", () => {
  it("place les sections de l'axe et leur descendance en tête", () => {
    const rows = [
      section({ id: "geo", title: "Géographie", axis: "geography" }),
      section({ id: "cosmo" }),
      section({ id: "cosmo-fils", parent_id: "cosmo", axis: null, title: "Rituels" }),
    ];
    expect(selectGapCandidates(rows, "cosmology").map((s) => s.id)).toEqual([
      "cosmo",
      "cosmo-fils",
      "geo",
    ]);
  });

  it("écarte les dossiers et les sections trop longues pour être réécrites d'un bloc", () => {
    const rows = [
      section({ id: "dossier", kind: "folder" }),
      section({ id: "enorme", content_md: "x".repeat(MAX_REWRITABLE_CHARS + 1) }),
      section({ id: "cosmo" }),
    ];
    expect(selectGapCandidates(rows, "cosmology").map((s) => s.id)).toEqual(["cosmo"]);
  });
});

describe("parseGapFill", () => {
  const candidates = [section(), section({ id: "sec-2", title: "Ton & style", axis: "tone" })];

  it("garde une réécriture visant une section candidate", () => {
    const out = parseGapFill(
      {
        summary: "L'énergie de la sorcellerie est tranchée.",
        edits: [{ section_id: "sec-1", content_md: "La sorcellerie ne se stocke pas." }],
      },
      candidates,
    );
    expect(out?.summary).toContain("énergie");
    expect(out?.edits).toEqual([
      {
        section_id: "sec-1",
        title: "Cosmologie & règles du monde",
        content_md: "La sorcellerie ne se stocke pas.",
        previous_md: "La sorcellerie se lance à la voix.",
        mode: "rewrite",
      },
    ]);
  });

  it("ignore une section inconnue, un corps vide et les doublons", () => {
    const out = parseGapFill(
      {
        summary: "",
        edits: [
          { section_id: "inconnue", content_md: "Perdu." },
          { section_id: "sec-1", content_md: "   " },
          { section_id: "sec-2", content_md: "Premier." },
          { section_id: "sec-2", content_md: "Doublon." },
        ],
      },
      candidates,
    );
    expect(out?.edits).toHaveLength(1);
    expect(out?.edits[0]).toMatchObject({ section_id: "sec-2", content_md: "Premier." });
  });

  it("refuse une réécriture amputée : intégrer n'est pas élaguer", () => {
    const long = section({ id: "long", content_md: "Détail. ".repeat(200) });
    const out = parseGapFill(
      { summary: "", edits: [{ section_id: "long", content_md: "Trois mots." }] },
      [long],
    );
    expect(out?.edits).toEqual([]);
  });

  it("plafonne le nombre de sections touchées", () => {
    const many = Array.from({ length: MAX_GAP_EDITS + 3 }, (_, i) =>
      section({ id: "s" + i, content_md: "" }),
    );
    const out = parseGapFill(
      { summary: "", edits: many.map((s) => ({ section_id: s.id, content_md: "Texte." })) },
      many,
    );
    expect(out?.edits).toHaveLength(MAX_GAP_EDITS);
  });

  it("rejette une sortie sans tableau d'éditions", () => {
    expect(parseGapFill({ summary: "x" }, candidates)).toBeNull();
    expect(parseGapFill(null, candidates)).toBeNull();
  });
});

describe("appendEdit", () => {
  it("repli : la réponse rejoint la fin du corps, rien n'est perdu", () => {
    expect(appendEdit(section(), "  Pas de stockage.  ")).toMatchObject({
      content_md: "La sorcellerie se lance à la voix.\n\nPas de stockage.",
      mode: "append",
    });
    expect(appendEdit(section({ content_md: "" }), "Seule ligne.").content_md).toBe(
      "Seule ligne.",
    );
  });
});

// ── Parcours complet ───────────────────────────────────────────────────────

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

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

interface PublicSection {
  id: string;
  title: string;
  content_md: string;
  axis: string | null;
}

async function sectionsOf(cookie: string, bibleId: string): Promise<PublicSection[]> {
  const res = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/sections`, {
    headers: { cookie },
  });
  return ((await res.json()) as { sections: PublicSection[] }).sections;
}

const CANON =
  "# Les Mondes Fêlés\n\n## Cosmologie\n\nLa sorcellerie se lance à la voix, apprise auprès d'un maître.";

/** Bible analysée : une lacune de cosmologie, prête à être comblée. */
async function analyzedBible(cookie: string): Promise<string> {
  const created = await post("/api/bibles", cookie, { markdown: CANON });
  const { id } = (await created.json()) as { id: string };

  mockAnthropicText(
    JSON.stringify({
      cosmology: 6,
      characters: 5,
      plots: 5,
      tone: 5,
      geography: 5,
      gaps: [
        { axis: "cosmology", description: "L'origine et le stockage de l'énergie magique ne sont pas définis." },
      ],
    }),
  );
  await post(`/api/bibles/${id}/analyze`, cookie, {});
  for (let i = 0; i < 50; i++) {
    const res = await SELF.fetch(`${BASE}/api/bibles/${id}/richness`, {
      headers: { cookie },
    });
    if (((await res.json()) as { status: string }).status === "analyzed") return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("analyse jamais terminée");
}

describe("POST /api/bibles/:id/gaps/:gapId/fill + /apply", () => {
  it("réécrit la section concernée au lieu d'ajouter à sa suite", async () => {
    const cookie = await login("gapfill1@example.com");
    const bibleId = await analyzedBible(cookie);
    const cosmo = (await sectionsOf(cookie, bibleId)).find((s) => s.axis === "cosmology")!;

    const rewritten =
      "La sorcellerie se lance à la voix, apprise auprès d'un maître : elle ne " +
      "puise dans aucune réserve, seulement dans la connaissance et l'endurance " +
      "du lanceur. Parchemins et fioles font exception, pour un usage unique.";
    mockAnthropicText(
      JSON.stringify({
        summary: "La cosmologie tranche l'absence de réserve d'énergie.",
        edits: [{ section_id: cosmo.id, content_md: rewritten }],
      }),
    );
    const fill = await post(
      `/api/bibles/${bibleId}/gaps/cosmology-0/fill`,
      cookie,
      { answer: "Nan, il n'y a pas de stockage : ça dépend de la connaissance et de l'endurance du lanceur. Sauf parchemins et fioles." },
    );
    expect(fill.status).toBe(200);
    const proposal = (await fill.json()) as {
      summary: string;
      edits: Array<{ section_id: string; content_md: string; previous_md: string; mode: string }>;
    };
    expect(proposal.edits).toHaveLength(1);
    expect(proposal.edits[0].mode).toBe("rewrite");
    // Le corps intégral de la section part au modèle : il réécrit, il ne devine pas.
    expect(lastAnthropicPrompt()).toContain("La sorcellerie se lance à la voix");
    // Rien n'est écrit tant que l'auteur n'a pas tranché.
    const untouched = (await sectionsOf(cookie, bibleId)).find((s) => s.id === cosmo.id)!;
    expect(untouched.content_md).toBe(cosmo.content_md);

    // L'auteur corrige avant d'appliquer : c'est SON texte qui est écrit.
    const edited = rewritten + " Le prix se paie en fatigue.";
    const applied = await post(`/api/bibles/${bibleId}/gaps/cosmology-0/apply`, cookie, {
      edits: [{ section_id: cosmo.id, content_md: edited }],
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ ok: true, applied: 1 });

    const after = (await sectionsOf(cookie, bibleId)).find((s) => s.id === cosmo.id)!;
    expect(after.content_md).toBe(edited);
    // Remplacement, pas empilement : la réponse brute n'apparaît nulle part.
    expect(after.content_md).not.toContain("Nan, il n'y a pas de stockage");

    // Le canon dérivé porte la réécriture, et la lacune est comblée.
    const detail = await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, { headers: { cookie } });
    expect(((await detail.json()) as { canon_md: string }).canon_md).toContain(
      "Le prix se paie en fatigue.",
    );
    const richness = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/richness`, {
      headers: { cookie },
    });
    const { gaps } = (await richness.json()) as { gaps: Array<{ id: string; resolved: boolean }> };
    expect(gaps.find((g) => g.id === "cosmology-0")?.resolved).toBe(true);
  });

  it("modèle en panne : la réponse est proposée en ajout de fin, jamais perdue", async () => {
    const cookie = await login("gapfill2@example.com");
    const bibleId = await analyzedBible(cookie);

    mockAnthropicError(401, "clé invalide");
    const fill = await post(`/api/bibles/${bibleId}/gaps/cosmology-0/fill`, cookie, {
      answer: "L'énergie ne se stocke pas.",
    });
    expect(fill.status).toBe(200);
    const body = (await fill.json()) as {
      degraded: boolean;
      edits: Array<{ mode: string; content_md: string }>;
    };
    expect(body.degraded).toBe(true);
    expect(body.edits[0].mode).toBe("append");
    expect(body.edits[0].content_md).toContain("L'énergie ne se stocke pas.");
  });

  it("refuse une réponse vide, une lacune inconnue et la bible d'un autre", async () => {
    const cookie = await login("gapfill3@example.com");
    const other = await login("gapfill4@example.com");
    const bibleId = await analyzedBible(cookie);

    expect(
      (await post(`/api/bibles/${bibleId}/gaps/cosmology-0/fill`, cookie, { answer: "  " }))
        .status,
    ).toBe(400);
    expect(
      (await post(`/api/bibles/${bibleId}/gaps/inconnue/fill`, cookie, { answer: "x" })).status,
    ).toBe(404);
    expect(
      (await post(`/api/bibles/${bibleId}/gaps/cosmology-0/fill`, other, { answer: "x" })).status,
    ).toBe(404);
  });

  it("apply refuse une section qui n'est pas de la bible", async () => {
    const cookie = await login("gapfill5@example.com");
    const bibleId = await analyzedBible(cookie);

    const bad = await post(`/api/bibles/${bibleId}/gaps/cosmology-0/apply`, cookie, {
      edits: [{ section_id: "sec-etrangere", content_md: "Texte." }],
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unknown_section" });

    const empty = await post(`/api/bibles/${bibleId}/gaps/cosmology-0/apply`, cookie, {
      edits: [],
    });
    expect(empty.status).toBe(400);
  });
});
