// Session d'écriture assistée : logique pure d'intégration (routage des blocs,
// titre du fil) et parcours complet — ouvrir un fil, discuter en SSE, relire le
// fil pour en tirer des blocs, puis les intégrer dans les sections.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
  mockAnthropicText,
} from "./anthropic-mock";
import {
  deriveTitle,
  describeSections,
  parseIntegrationPayload,
  MAX_ENTRIES,
} from "../src/bibles/writing";
import type { SectionRow } from "../src/bibles/sections";

const BASE = "http://loreforge.test";

beforeAll(() => installAnthropicMock());
afterEach(() => assertAnthropicMockConsumed());

function section(over: Partial<SectionRow> = {}): SectionRow {
  return {
    id: "sec-1",
    bible_id: "b1",
    title: "Personnages",
    content_md: "Kass, la cartographe.",
    is_base: 1,
    axis: "characters",
    sort_order: 0,
    updated_at: 0,
    parent_id: null,
    kind: "section",
    ...over,
  };
}

// ── Unitaires (purs) ───────────────────────────────────────────────────────

describe("describeSections", () => {
  it("expose l'identifiant, le titre et un extrait — les dossiers sont marqués", () => {
    const out = describeSections([
      section(),
      section({ id: "sec-2", title: "Trames", content_md: "", kind: "folder" }),
    ]);
    expect(out).toContain("[sec-1] « Personnages »");
    expect(out).toContain("Kass, la cartographe.");
    expect(out).toContain("[sec-2] « Trames » [dossier] : (vide)");
  });

  it("le vide se dit, il ne se devine pas", () => {
    expect(describeSections([])).toContain("aucune section");
  });
});

describe("parseIntegrationPayload", () => {
  const sections = [
    section(),
    section({ id: "sec-folder", title: "Dossier", kind: "folder" }),
  ];

  it("garde le section_id connu", () => {
    const out = parseIntegrationPayload(
      {
        summary: "Une guilde.",
        entries: [{ section_id: "sec-1", title: "peu importe", content_md: "La guilde des routes." }],
      },
      sections,
    );
    expect(out?.summary).toBe("Une guilde.");
    expect(out?.entries).toEqual([
      { section_id: "sec-1", title: "Personnages", content_md: "La guilde des routes." },
    ]);
  });

  it("un id inconnu ou un dossier retombe sur une nouvelle section, jamais au hasard", () => {
    const out = parseIntegrationPayload(
      {
        summary: "",
        entries: [
          { section_id: "inconnue", title: "Guildes", content_md: "Texte A." },
          { section_id: "sec-folder", title: "", content_md: "Texte B." },
        ],
      },
      sections,
    );
    expect(out?.entries).toEqual([
      { section_id: "", title: "Guildes", content_md: "Texte A." },
      { section_id: "", title: "Notes d'atelier", content_md: "Texte B." },
    ]);
  });

  it("ignore les entrées sans contenu et plafonne la liste", () => {
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({
      section_id: "sec-1",
      title: "T",
      content_md: "bloc " + i,
    }));
    const out = parseIntegrationPayload(
      { summary: "", entries: [{ section_id: "sec-1", title: "T", content_md: "   " }, ...many] },
      sections,
    );
    expect(out?.entries).toHaveLength(MAX_ENTRIES);
    expect(out?.entries[0].content_md).toBe("bloc 0");
  });

  it("rejette une sortie sans tableau d'entrées", () => {
    expect(parseIntegrationPayload({ summary: "x" }, sections)).toBeNull();
    expect(parseIntegrationPayload(null, sections)).toBeNull();
  });
});

describe("deriveTitle", () => {
  it("reprend la première phrase, coupée sur un mot entier", () => {
    expect(deriveTitle("  une guilde\n de cartographes  ")).toBe("une guilde de cartographes");
    const long = deriveTitle("a".repeat(20) + " " + "b".repeat(80));
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
  });

  it("un message vide garde un titre lisible", () => {
    expect(deriveTitle("   ")).toBe("Session d'écriture");
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

async function createBible(cookie: string, markdown: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/bibles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ markdown }),
  });
  return ((await res.json()) as { id: string }).id;
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

const CANON = "# Les Mondes Fêlés\n\n## Personnages\n\nKass, cartographe.";

describe("/api/bibles/:id/writing", () => {
  it("ouvre un fil, discute en SSE et conserve le tour", async () => {
    const cookie = await login("write1@example.com");
    const bibleId = await createBible(cookie, CANON);

    const created = await post(`/api/bibles/${bibleId}/writing`, cookie, {});
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string; title: string } };

    mockAnthropicStream(["Une guilde ", "de cartographes, donc."]);
    const stream = await post(
      `/api/bibles/${bibleId}/writing/${session.id}/message`,
      cookie,
      { text: "J'ai une idée de guilde de cartographes." },
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const body = await stream.text();
    expect(body).toContain("event: delta");
    expect(body).toContain("Une guilde ");
    expect(body).toContain("event: done");

    // Le tour est persisté : le fil se rouvre là où il s'est arrêté.
    const reload = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/writing/${session.id}`,
      { headers: { cookie } },
    );
    const fil = (await reload.json()) as {
      session: { title: string; message_count: number };
      messages: Array<{ role: string; content: string }>;
    };
    expect(fil.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(fil.messages[1].content).toBe("Une guilde de cartographes, donc.");
    // Le titre du fil vient du premier message de l'auteur.
    expect(fil.session.title).toContain("guilde de cartographes");

    // …et le fil apparaît dans la liste de la bible.
    const list = await SELF.fetch(`${BASE}/api/bibles/${bibleId}/writing`, {
      headers: { cookie },
    });
    const { sessions } = (await list.json()) as {
      sessions: Array<{ id: string; message_count: number }>;
    };
    expect(sessions).toHaveLength(1);
    expect(sessions[0].message_count).toBe(2);
  });

  it("refuse un message vide et un fil qui n'est pas de la bible", async () => {
    const cookie = await login("write2@example.com");
    const bibleId = await createBible(cookie, CANON);
    const { session } = (await (
      await post(`/api/bibles/${bibleId}/writing`, cookie, {})
    ).json()) as { session: { id: string } };

    const empty = await post(
      `/api/bibles/${bibleId}/writing/${session.id}/message`,
      cookie,
      { text: "   " },
    );
    expect(empty.status).toBe(400);

    const other = await createBible(cookie, CANON);
    const crossed = await post(
      `/api/bibles/${other}/writing/${session.id}/message`,
      cookie,
      { text: "coucou" },
    );
    expect(crossed.status).toBe(404);
  });

  it("intègre les blocs validés dans les sections et régénère le canon", async () => {
    const cookie = await login("write3@example.com");
    const bibleId = await createBible(cookie, CANON);
    const { session } = (await (
      await post(`/api/bibles/${bibleId}/writing`, cookie, {})
    ).json()) as { session: { id: string } };

    mockAnthropicStream(["D'accord."]);
    await (
      await post(`/api/bibles/${bibleId}/writing/${session.id}/message`, cookie, {
        text: "La guilde des cartographes vend des routes qui n'existent pas encore.",
      })
    ).text();

    const before = await sectionsOf(cookie, bibleId);
    const perso = before.find((s) => s.axis === "characters")!;

    mockAnthropicText(
      JSON.stringify({
        summary: "La guilde des cartographes entre au canon.",
        entries: [
          { section_id: perso.id, title: "Personnages", content_md: "La Guilde des Voies Promises." },
          { section_id: "", title: "Guildes", content_md: "Les guildes marchandes." },
        ],
      }),
    );
    const integrate = await post(
      `/api/bibles/${bibleId}/writing/${session.id}/integrate`,
      cookie,
      {},
    );
    expect(integrate.status).toBe(200);
    const proposal = (await integrate.json()) as {
      summary: string;
      entries: Array<{ section_id: string; title: string; content_md: string }>;
    };
    expect(proposal.entries).toHaveLength(2);
    expect(proposal.summary).toContain("guilde");

    // L'auteur édite un bloc avant de trancher : c'est son texte qui est écrit.
    proposal.entries[0].content_md = "La Guilde des Voies Promises, éditée.";
    const applied = await post(
      `/api/bibles/${bibleId}/writing/${session.id}/apply`,
      cookie,
      { entries: proposal.entries },
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ ok: true, applied: 2, created: 1 });

    const after = await sectionsOf(cookie, bibleId);
    const persoAfter = after.find((s) => s.id === perso.id)!;
    // Ajout, jamais écrasement.
    expect(persoAfter.content_md).toContain("Kass");
    expect(persoAfter.content_md).toContain("Voies Promises, éditée.");
    const fresh = after.find((s) => s.title === "Guildes")!;
    expect(fresh.content_md).toBe("Les guildes marchandes.");

    // canon_md est dérivé : il porte les deux ajouts.
    const detail = await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, {
      headers: { cookie },
    });
    const { canon_md } = (await detail.json()) as { canon_md: string };
    expect(canon_md).toContain("Voies Promises, éditée.");
    expect(canon_md).toContain("## Guildes");
  });

  it("plusieurs blocs visant la même section s'empilent au lieu de s'écraser", async () => {
    const cookie = await login("write4@example.com");
    const bibleId = await createBible(cookie, CANON);
    const { session } = (await (
      await post(`/api/bibles/${bibleId}/writing`, cookie, {})
    ).json()) as { session: { id: string } };
    const perso = (await sectionsOf(cookie, bibleId)).find((s) => s.axis === "characters")!;

    const applied = await post(
      `/api/bibles/${bibleId}/writing/${session.id}/apply`,
      cookie,
      {
        entries: [
          { section_id: perso.id, title: "Personnages", content_md: "Premier bloc." },
          { section_id: perso.id, title: "Personnages", content_md: "Second bloc." },
        ],
      },
    );
    expect(applied.status).toBe(200);
    const after = (await sectionsOf(cookie, bibleId)).find((s) => s.id === perso.id)!;
    expect(after.content_md).toContain("Premier bloc.");
    expect(after.content_md).toContain("Second bloc.");
  });

  it("refuse une intégration sans entrée exploitable", async () => {
    const cookie = await login("write5@example.com");
    const bibleId = await createBible(cookie, CANON);
    const { session } = (await (
      await post(`/api/bibles/${bibleId}/writing`, cookie, {})
    ).json()) as { session: { id: string } };

    // Fil vide : rien à relire.
    const empty = await post(
      `/api/bibles/${bibleId}/writing/${session.id}/integrate`,
      cookie,
      {},
    );
    expect(empty.status).toBe(400);

    const bad = await post(`/api/bibles/${bibleId}/writing/${session.id}/apply`, cookie, {
      entries: [{ section_id: "", title: "T", content_md: "  " }],
    });
    expect(bad.status).toBe(400);
  });

  it("supprime un fil, et la suppression de la bible emporte les fils restants", async () => {
    const cookie = await login("write6@example.com");
    const bibleId = await createBible(cookie, CANON);
    const first = (await (
      await post(`/api/bibles/${bibleId}/writing`, cookie, {})
    ).json()) as { session: { id: string } };
    const second = (await (
      await post(`/api/bibles/${bibleId}/writing`, cookie, {})
    ).json()) as { session: { id: string } };

    const del = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/writing/${first.session.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(200);
    const gone = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/writing/${first.session.id}`,
      { headers: { cookie } },
    );
    expect(gone.status).toBe(404);

    const dropped = await SELF.fetch(`${BASE}/api/bibles/${bibleId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(dropped.status).toBe(200);
    const orphan = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/writing/${second.session.id}`,
      { headers: { cookie } },
    );
    expect(orphan.status).toBe(404);
  });

  it("un fil n'est pas visible par un autre auteur", async () => {
    const owner = await login("write7@example.com");
    const bibleId = await createBible(owner, CANON);
    const { session } = (await (
      await post(`/api/bibles/${bibleId}/writing`, owner, {})
    ).json()) as { session: { id: string } };

    const intruder = await login("intrus@example.com");
    const res = await SELF.fetch(
      `${BASE}/api/bibles/${bibleId}/writing/${session.id}`,
      { headers: { cookie: intruder } },
    );
    expect(res.status).toBe(404);
  });
});
