// Gestion des bibles : renommage, suppression en cascade, imports
// multi-formats (ZIP export Notion, DOCX, PDF) et sections du canon.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
// @ts-expect-error — module JS servi tel quel au front, sans types.
import { buildCanonFromSections, parseCanonSections } from "../public/core.js";

const BASE = "http://loreforge.test";

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

interface BibleJson {
  id: string;
  title: string;
  source_type: string;
  canon_md: string;
}

async function createBible(cookie: string, markdown: string): Promise<BibleJson> {
  const res = await SELF.fetch(`${BASE}/api/bibles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ markdown }),
  });
  return (await res.json()) as BibleJson;
}

async function uploadFile(
  cookie: string,
  name: string,
  data: Uint8Array | string,
  type = "application/octet-stream",
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([data], name, { type }));
  return SELF.fetch(`${BASE}/api/bibles`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

describe("PATCH /api/bibles/:id (titre)", () => {
  it("renomme la bible", async () => {
    const cookie = await login("author@example.com");
    const bible = await createBible(cookie, "# Ancien Nom\n\nLore.");

    const res = await SELF.fetch(`${BASE}/api/bibles/${bible.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "  Nouveau Nom  " }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as BibleJson).title).toBe("Nouveau Nom");
  });

  it("rejette un titre vide", async () => {
    const cookie = await login("author@example.com");
    const bible = await createBible(cookie, "# Ma Bible");

    const res = await SELF.fetch(`${BASE}/api/bibles/${bible.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_title" });
  });
});

describe("DELETE /api/bibles/:id", () => {
  it("supprime la bible, ses lignes liées et le fichier R2", async () => {
    const cookie = await login("author@example.com");
    const bible = await createBible(cookie, "# À Détruire\n\nLore.");

    // Une ligne liée pour vérifier la cascade.
    await env.DB.prepare(
      `INSERT INTO richness_scores
         (bible_id, cosmology, characters, plots, tone, geography, global, gaps_json, computed_at)
       VALUES (?, 5, 5, 5, 5, 5, 5, '[]', 0)`,
    )
      .bind(bible.id)
      .run();

    const res = await SELF.fetch(`${BASE}/api/bibles/${bible.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/api/bibles/${bible.id}`, {
      headers: { cookie },
    });
    expect(after.status).toBe(404);

    const scores = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM richness_scores WHERE bible_id = ?`,
    )
      .bind(bible.id)
      .first<{ n: number }>();
    expect(scores?.n).toBe(0);

    expect(await env.BUCKET.get(`bibles/${bible.id}/source.md`)).toBeNull();
  });

  it("404 pour la bible d'un autre utilisateur (rien n'est supprimé)", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    const bible = await createBible(alice, "# Secret");

    const res = await SELF.fetch(`${BASE}/api/bibles/${bible.id}`, {
      method: "DELETE",
      headers: { cookie: bob },
    });
    expect(res.status).toBe(404);

    const still = await SELF.fetch(`${BASE}/api/bibles/${bible.id}`, {
      headers: { cookie: alice },
    });
    expect(still.status).toBe(200);
  });
});

describe("import ZIP (export Notion)", () => {
  it("concatène les .md du zip dans l'ordre des chemins", async () => {
    const cookie = await login("author@example.com");
    const zip = zipSync({
      "Mon Univers/01 Cosmologie.md": strToU8("# Cosmologie\n\nTrois lunes."),
      "Mon Univers/02 Peuples.md": strToU8("# Peuples\n\nLes Sylvains."),
      "Mon Univers/notes.bin": strToU8("binaire ignoré"),
      "__MACOSX/._junk.md": strToU8("poubelle"),
    });
    const res = await uploadFile(cookie, "export-notion.zip", zip, "application/zip");
    expect(res.status).toBe(201);
    const bible = (await res.json()) as BibleJson;
    expect(bible.source_type).toBe("notion_export");
    // Premier H1 = titre ; le second est démoté en H2 par la normalisation.
    expect(bible.title).toBe("Cosmologie");
    expect(bible.canon_md).toContain("Trois lunes.");
    expect(bible.canon_md).toContain("## Peuples");
    expect(bible.canon_md).not.toContain("binaire");
    // Le zip brut est conservé dans R2.
    const stored = await env.BUCKET.get(`bibles/${bible.id}/source.zip`);
    expect(stored).not.toBeNull();
  });

  it("rejette un zip sans markdown", async () => {
    const cookie = await login("author@example.com");
    const zip = zipSync({ "image.png": strToU8("pas du texte") });
    const res = await uploadFile(cookie, "vide.zip", zip, "application/zip");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "zip_without_markdown" });
  });

  it("rejette un zip corrompu", async () => {
    const cookie = await login("author@example.com");
    const res = await uploadFile(cookie, "casse.zip", strToU8("PK garbage"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_zip" });
  });
});

describe("import DOCX", () => {
  function makeDocx(bodyXml: string): Uint8Array {
    const xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${bodyXml}</w:body></w:document>`;
    return zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(xml),
    });
  }

  it("extrait paragraphes et titres (Heading -> #)", async () => {
    const cookie = await login("author@example.com");
    const docx = makeDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Les Terres Brisées</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t xml:space="preserve">Un monde né d&apos;une chute — </w:t></w:r><w:r><w:t>fragments épars.</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Peuples</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Les Sylvains.</w:t></w:r></w:p>`,
    );
    const res = await uploadFile(
      cookie,
      "terres-brisees.docx",
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.status).toBe(201);
    const bible = (await res.json()) as BibleJson;
    expect(bible.source_type).toBe("docx");
    expect(bible.title).toBe("Les Terres Brisées");
    expect(bible.canon_md).toContain("## Peuples");
    expect(bible.canon_md).toContain("Les Sylvains.");
    expect(bible.canon_md).toContain("fragments épars.");
  });

  it("rejette un docx sans texte", async () => {
    const cookie = await login("author@example.com");
    const res = await uploadFile(cookie, "vide.docx", makeDocx("<w:p></w:p>"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "docx_without_text" });
  });
});

describe("import PDF", () => {
  // PDF minimal, une page, flux de texte non compressé.
  function makePdf(text: string): Uint8Array {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
      `<< /Type /Catalog /Pages 2 0 R >>`,
      `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((obj, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return strToU8(pdf);
  }

  it("extrait le texte d'un PDF simple", async () => {
    const cookie = await login("author@example.com");
    const res = await uploadFile(
      cookie,
      "les-havres.pdf",
      makePdf("Les Havres Suspendus"),
      "application/pdf",
    );
    expect(res.status).toBe(201);
    const bible = (await res.json()) as BibleJson;
    expect(bible.source_type).toBe("pdf");
    expect(bible.title).toBe("les-havres");
    expect(bible.canon_md).toContain("Les Havres Suspendus");
  });

  it("rejette un PDF illisible", async () => {
    const cookie = await login("author@example.com");
    const res = await uploadFile(cookie, "casse.pdf", strToU8("pas un pdf"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_pdf" });
  });
});

describe("sections du canon (@app/core)", () => {
  it("découpe puis recompose à l'identique un canon normalisé", () => {
    const md =
      "# Monde\n\nIntro libre.\n\n## Cosmologie\n\nTrois lunes.\n\n## Peuples\n\nLes Sylvains.\n";
    const doc = parseCanonSections(md);
    expect(doc.h1).toBe("Monde");
    expect(doc.preamble).toBe("Intro libre.");
    expect(doc.sections.map((s: { title: string }) => s.title)).toEqual([
      "Cosmologie",
      "Peuples",
    ]);
    expect(buildCanonFromSections(doc)).toBe(md);
  });

  it("ignore les ## dans les blocs de code", () => {
    const md = "# T\n\n```\n## pas un titre\n```\n\n## Vrai titre\n\nCorps.\n";
    const doc = parseCanonSections(md);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].title).toBe("Vrai titre");
    expect(doc.preamble).toContain("## pas un titre");
  });

  it("réordonne les sections", () => {
    const doc = parseCanonSections("# T\n\n## A\n\na\n\n## B\n\nb\n");
    doc.sections.reverse();
    expect(buildCanonFromSections(doc)).toBe("# T\n\n## B\n\nb\n\n## A\n\na\n");
  });
});
