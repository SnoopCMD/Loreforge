// Sections de bible : rendu du canon dérivé, classification heuristique, et
// parcours d'édition (init paresseuse, autosave, ajout, réordonnancement,
// suppression) via /api/bibles/:id/sections.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicText,
} from "./anthropic-mock";
import { BASE_SECTIONS, renderCanon } from "../src/bibles/sections";
import { heuristicClassify } from "../src/bibles/classify";

const BASE = "http://loreforge.test";

beforeAll(() => installAnthropicMock());
afterEach(() => assertAnthropicMockConsumed());

// ── Unitaires (purs) ───────────────────────────────────────────────────────

describe("renderCanon", () => {
  it("un H1 puis un H2 par section, corps préservé", () => {
    const canon = renderCanon("Les Mondes Fêlés", [
      { title: "Cosmologie", content_md: "La magie vient des failles." },
      { title: "Vide", content_md: "" },
    ]);
    expect(canon).toBe(
      "# Les Mondes Fêlés\n\n## Cosmologie\n\nLa magie vient des failles.\n\n## Vide\n",
    );
  });
});

describe("heuristicClassify", () => {
  it("mappe les H2 aux sections de base par titre, garde toujours les 8 bases", () => {
    const canon = `# Univers

Un pitch d'intro.

## Le panthéon et la magie
Les dieux dorment.

## Les grandes cités
Karnos, cité-pont.

## Le Chœur Muet
Une secte à part.`;
    const out = heuristicClassify(canon);
    const base = out.filter((s) => s.is_base);
    expect(base).toHaveLength(BASE_SECTIONS.length);

    const byTitle = Object.fromEntries(out.map((s) => [s.title, s.content_md]));
    // préambule → intro
    expect(byTitle["Introduction / pitch"]).toContain("pitch d'intro");
    // « panthéon et la magie » → cosmology (mot-clé « magie »)
    expect(byTitle["Cosmologie & règles du monde"]).toContain("dieux dorment");
    // « grandes cités » → geography (mot-clé « cité »)
    expect(byTitle["Géographie & lieux"]).toContain("cité-pont");
    // titre non reconnu → section personnalisée
    const custom = out.find((s) => !s.is_base && s.title === "Le Chœur Muet");
    expect(custom?.content_md).toContain("secte");
  });

  it("bible vide → 8 sections de base vides", () => {
    const out = heuristicClassify("");
    expect(out).toHaveLength(BASE_SECTIONS.length);
    expect(out.every((s) => s.is_base && s.content_md === "")).toBe(true);
  });
});

// ── Intégration ─────────────────────────────────────────────────────────────

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

const req = (cookie: string, path: string, method = "GET", body?: unknown) =>
  SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function createBible(cookie: string): Promise<string> {
  const res = await req(cookie, "/api/bibles", "POST", {
    markdown:
      "# Les Mondes Fêlés\n\nUn pitch d'intro.\n\n## Cosmologie et magie\n\nLa magie vient des failles entre les Mondes.",
  });
  return ((await res.json()) as { id: string }).id;
}

interface Section {
  id: string;
  title: string;
  content_md: string;
  is_base: boolean;
  axis: string | null;
}

describe("édition par sections", () => {
  it("init paresseuse (heuristique) puis autosave, ajout, réordonnancement, suppression", async () => {
    const cookie = await login("sections@example.com");
    const bibleId = await createBible(cookie);

    // 1er GET : la bible n'a pas de sections → init heuristique synchrone
    // (aucun appel IA : le titre H2 « Cosmologie et magie » → axe cosmology).
    const first = (await (await req(cookie, `/api/bibles/${bibleId}/sections`)).json()) as {
      sections: Section[];
    };
    // 8 sections de base présentes, la cosmologie remplie par l'heuristique.
    expect(first.sections.filter((s) => s.is_base)).toHaveLength(BASE_SECTIONS.length);
    const cosmo = first.sections.find((s) => s.axis === "cosmology")!;
    expect(cosmo.content_md).toContain("failles");

    // 2e GET : pas de ré-init (aucun appel IA attendu).
    const again = (await (await req(cookie, `/api/bibles/${bibleId}/sections`)).json()) as {
      sections: Section[];
    };
    expect(again.sections).toHaveLength(first.sections.length);

    // Autosave d'une section → régénère canon_md.
    const upd = await req(cookie, `/api/bibles/${bibleId}/sections/${cosmo.id}`, "PUT", {
      content_md: "La magie SUINTE des failles. Le sel-de-lune la marque.",
    });
    expect(upd.status).toBe(200);
    const bible = (await (await req(cookie, `/api/bibles/${bibleId}`)).json()) as {
      canon_md: string;
    };
    expect(bible.canon_md).toContain("sel-de-lune");
    expect(bible.canon_md).toContain("## Cosmologie & règles du monde");

    // Ajout d'une section personnalisée.
    const added = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections`, "POST", { title: "Le Concile" })
    ).json()) as Section;
    expect(added.is_base).toBe(false);
    expect(added.title).toBe("Le Concile");

    // Réordonnancement : on remonte la nouvelle section en tête.
    const current = (await (await req(cookie, `/api/bibles/${bibleId}/sections`)).json()) as {
      sections: Section[];
    };
    const order = [added.id, ...current.sections.filter((s) => s.id !== added.id).map((s) => s.id)];
    const reordered = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections/reorder`, "PATCH", { order })
    ).json()) as { sections: Section[] };
    expect(reordered.sections[0].id).toBe(added.id);

    // Suppression d'une section de base (autorisée).
    const del = await req(cookie, `/api/bibles/${bibleId}/sections/${cosmo.id}`, "DELETE");
    expect(del.status).toBe(200);
    const afterDel = (await (await req(cookie, `/api/bibles/${bibleId}/sections`)).json()) as {
      sections: Section[];
    };
    expect(afterDel.sections.find((s) => s.id === cosmo.id)).toBeUndefined();
  });

  it("redistribue le canon via l'IA (à la demande, remplace le découpage)", async () => {
    const cookie = await login("redist@example.com");
    const bibleId = await createBible(cookie);
    // Init heuristique (aucun appel IA).
    await req(cookie, `/api/bibles/${bibleId}/sections`);

    // Redistribution IA mockée : reclasse tout le canon.
    mockAnthropicText(
      JSON.stringify({
        base: [{ key: "characters", content_md: "Zuma, le premier héros." }],
        custom: [{ title: "Annexe", content_md: "Notes libres." }],
      }),
    );
    const res = await req(cookie, `/api/bibles/${bibleId}/sections/redistribute`, "POST");
    expect(res.status).toBe(200);
    const { sections } = (await res.json()) as { sections: Section[] };

    // 8 sections de base toujours présentes, la classification IA appliquée.
    expect(sections.filter((s) => s.is_base)).toHaveLength(BASE_SECTIONS.length);
    const chars = sections.find((s) => s.axis === "characters");
    expect(chars?.content_md).toContain("Zuma, le premier héros");
    const annex = sections.find((s) => !s.is_base && s.title === "Annexe");
    expect(annex?.content_md).toContain("Notes libres");

    // Le canon dérivé reflète la nouvelle répartition.
    const bible = (await (await req(cookie, `/api/bibles/${bibleId}`)).json()) as {
      canon_md: string;
    };
    expect(bible.canon_md).toContain("Zuma, le premier héros");
  });

  it("cloisonne par utilisateur", async () => {
    const alice = await login("sec-alice@example.com");
    const bob = await login("sec-bob@example.com");
    const bibleId = await createBible(alice);
    expect((await req(bob, `/api/bibles/${bibleId}/sections`)).status).toBe(404);
  });
});
