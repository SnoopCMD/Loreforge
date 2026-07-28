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

  it("empile plusieurs H2 dans la même base (export Notion, sans éclatement)", () => {
    const canon = `# Univers

## 5. Panthéon — Les Dieux
Les dieux naissent et meurent.

## Personnages sans trame
Sera, Camille la Sainte.

## Trame 1 — La Course
La plus large.

## Croisements entre trames
Zaw croise tout.

## King of the Hill
Jeu de société.`;
    const out = heuristicClassify(canon);

    // Les deux blocs « personnages » s'empilent dans la même base, chacun
    // sous son titre d'origine — aucun ne repart en section custom.
    const chars = out.find((s) => s.axis === "characters")!;
    expect(chars.content_md).toContain("### 5. Panthéon — Les Dieux");
    expect(chars.content_md).toContain("### Personnages sans trame");
    expect(chars.content_md.indexOf("Panthéon")).toBeLessThan(
      chars.content_md.indexOf("Sera, Camille"),
    );

    const plots = out.find((s) => s.axis === "plots")!;
    expect(plots.content_md).toContain("La plus large.");
    expect(plots.content_md).toContain("Zaw croise tout.");

    // Le hors-catégorie reste custom — mais lui seul.
    const custom = out.filter((s) => !s.is_base);
    expect(custom.map((s) => s.title)).toEqual(["King of the Hill"]);
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

  it("redistribue via un PLAN IA : déplace la section, préserve le contenu", async () => {
    const cookie = await login("redist@example.com");
    const bibleId = await createBible(cookie);
    // Init heuristique. Seules 2 sections sont non vides → 2 blocs :
    // [0] Introduction / pitch, [1] Cosmologie (contenant « failles »).
    await req(cookie, `/api/bibles/${bibleId}/sections`);

    // L'IA ne renvoie qu'un plan section→cible. On déplace « failles » (index 1)
    // vers l'axe personnages ; l'intro garde sa place.
    mockAnthropicText(
      JSON.stringify({
        assignments: [
          { index: 0, target: "intro" },
          { index: 1, target: "characters" },
        ],
      }),
    );
    const res = await req(cookie, `/api/bibles/${bibleId}/sections/redistribute`, "POST");
    expect(res.status).toBe(200);
    const { sections } = (await res.json()) as { sections: Section[] };

    // 8 sections de base toujours présentes ; le contenu a migré vers personnages.
    expect(sections.filter((s) => s.is_base)).toHaveLength(BASE_SECTIONS.length);
    const chars = sections.find((s) => s.axis === "characters");
    expect(chars?.content_md).toContain("failles");
    // La cosmologie a été vidée de ce bloc.
    const cosmo = sections.find((s) => s.axis === "cosmology");
    expect(cosmo?.content_md).not.toContain("failles");

    // Le canon dérivé reflète la nouvelle répartition (contenu préservé).
    const bible = (await (await req(cookie, `/api/bibles/${bibleId}`)).json()) as {
      canon_md: string;
    };
    expect(bible.canon_md).toContain("failles");
  });

  it("cloisonne par utilisateur", async () => {
    const alice = await login("sec-alice@example.com");
    const bob = await login("sec-bob@example.com");
    const bibleId = await createBible(alice);
    expect((await req(bob, `/api/bibles/${bibleId}/sections`)).status).toBe(404);
  });
});

// ── Dossiers / sous-dossiers ────────────────────────────────────────────────

interface TreeSection extends Section {
  parent_id: string | null;
  kind: "section" | "folder";
}

describe("renderCanon (arbre)", () => {
  it("profondeur → niveau de titre ; dossier sans corps", () => {
    const canon = renderCanon("Monde", [
      { id: "f", parent_id: null, kind: "folder", title: "Peuples", content_md: "" },
      { id: "a", parent_id: "f", kind: "section", title: "Elfes", content_md: "Vieux." },
      { id: "g", parent_id: "f", kind: "folder", title: "Nains", content_md: "" },
      { id: "b", parent_id: "g", kind: "section", title: "Clans", content_md: "Douze." },
      { id: "c", parent_id: null, kind: "section", title: "Racine", content_md: "Plate." },
    ]);
    expect(canon).toBe(
      "# Monde\n\n## Peuples\n\n### Elfes\n\nVieux.\n\n### Nains\n\n#### Clans\n\nDouze.\n\n## Racine\n\nPlate.\n",
    );
  });

  it("parent inconnu → rattaché à la racine (rien n'est perdu)", () => {
    const canon = renderCanon("Monde", [
      { id: "a", parent_id: "fantome", kind: "section", title: "Orphelin", content_md: "Là." },
    ]);
    expect(canon).toContain("## Orphelin");
  });
});

describe("dossiers de sections", () => {
  it("crée, imbrique, limite la profondeur, refuse les cycles, supprime sans perdre", async () => {
    const cookie = await login("folders@example.com");
    const bibleId = await createBible(cookie);
    await req(cookie, `/api/bibles/${bibleId}/sections`); // init

    // Dossier racine puis sous-dossier.
    const folder = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections`, "POST", { kind: "folder", title: "Peuples" })
    ).json()) as TreeSection;
    expect(folder.kind).toBe("folder");
    expect(folder.parent_id).toBeNull();

    const sub = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections`, "POST", {
        kind: "folder", title: "Nains", parent_id: folder.id,
      })
    ).json()) as TreeSection;
    expect(sub.parent_id).toBe(folder.id);

    // Un dossier dans un sous-dossier dépasserait la profondeur max.
    const tooDeep = await req(cookie, `/api/bibles/${bibleId}/sections`, "POST", {
      kind: "folder", title: "Trop profond", parent_id: sub.id,
    });
    expect(tooDeep.status).toBe(400);
    expect(((await tooDeep.json()) as { error: string }).error).toBe("too_deep");

    // Une section, elle, entre dans le sous-dossier.
    const leaf = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections`, "POST", {
        title: "Clans", parent_id: sub.id,
      })
    ).json()) as TreeSection;
    expect(leaf.parent_id).toBe(sub.id);

    // Le parent doit être un dossier, pas une section.
    const notFolder = await req(cookie, `/api/bibles/${bibleId}/sections`, "POST", {
      title: "X", parent_id: leaf.id,
    });
    expect(notFolder.status).toBe(400);

    // Déplacement : une section de base rejoint le dossier racine.
    const { sections } = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections`)
    ).json()) as { sections: TreeSection[] };
    const chars = sections.find((s) => s.axis === "characters")!;
    const moved = await req(cookie, `/api/bibles/${bibleId}/sections/${chars.id}`, "PUT", {
      parent_id: folder.id,
    });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as TreeSection).parent_id).toBe(folder.id);

    // Cycle refusé : le dossier ne peut pas entrer dans sa descendance.
    const cycle = await req(cookie, `/api/bibles/${bibleId}/sections/${folder.id}`, "PUT", {
      parent_id: sub.id,
    });
    expect(cycle.status).toBe(400);

    // Pas de contenu sur un dossier.
    const content = await req(cookie, `/api/bibles/${bibleId}/sections/${folder.id}`, "PUT", {
      content_md: "interdit",
    });
    expect(content.status).toBe(400);

    // Le canon dérivé reflète la hiérarchie (### sous le dossier).
    await req(cookie, `/api/bibles/${bibleId}/sections/${leaf.id}`, "PUT", {
      content_md: "Douze clans sous la montagne.",
    });
    const bible = (await (await req(cookie, `/api/bibles/${bibleId}`)).json()) as {
      canon_md: string;
    };
    expect(bible.canon_md).toContain("## Peuples");
    expect(bible.canon_md).toContain("### Nains");
    expect(bible.canon_md).toContain("#### Clans");

    // Suppression du sous-dossier : ses enfants remontent d'un cran.
    const del = await req(cookie, `/api/bibles/${bibleId}/sections/${sub.id}`, "DELETE");
    expect(del.status).toBe(200);
    const after = (await (
      await req(cookie, `/api/bibles/${bibleId}/sections`)
    ).json()) as { sections: TreeSection[] };
    expect(after.sections.find((s) => s.id === sub.id)).toBeUndefined();
    expect(after.sections.find((s) => s.id === leaf.id)?.parent_id).toBe(folder.id);
  });
});
