// Extraction de texte des imports non-Markdown : ZIP (export Notion),
// PDF (unpdf) et DOCX (fflate + word/document.xml). Le résultat est du
// Markdown brut qui repasse ensuite par normalizeMarkdown.

import { unzipSync, strFromU8 } from "fflate";
import { MAX_IMPORT_BYTES } from "./normalize";

// Les binaires peuvent être plus lourds que le Markdown final : un PDF de
// 25 Mo tient largement dans un Worker, et le texte extrait reste plafonné
// à MAX_IMPORT_BYTES en aval.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type ImportFormat = "markdown" | "notion_export" | "pdf" | "docx";

export interface Extracted {
  markdown: string;
  sourceType: ImportFormat;
}

export class ExtractError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** Format déduit du nom de fichier ; texte/Markdown par défaut. */
export function detectFormat(filename: string): ImportFormat {
  if (/\.zip$/i.test(filename)) return "notion_export";
  if (/\.pdf$/i.test(filename)) return "pdf";
  if (/\.docx$/i.test(filename)) return "docx";
  return "markdown";
}

export function stripImportExtension(filename: string): string {
  return filename.replace(/\.(md|markdown|txt|zip|pdf|docx)$/i, "");
}

export async function extractMarkdown(
  format: ImportFormat,
  data: Uint8Array,
): Promise<string> {
  switch (format) {
    case "notion_export":
      return extractZip(data);
    case "pdf":
      return extractPdf(data);
    case "docx":
      return extractDocx(data);
    case "markdown":
      return strFromU8(data);
  }
}

// ── ZIP : concatène les fichiers .md/.txt dans l'ordre des chemins ───────

function extractZip(data: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    throw new ExtractError("invalid_zip");
  }

  const parts: string[] = [];
  for (const path of Object.keys(entries).sort()) {
    if (path.startsWith("__MACOSX/") || /(^|\/)\./.test(path)) continue;
    if (!/\.(md|markdown|txt)$/i.test(path)) continue;
    const text = strFromU8(entries[path]).trim();
    if (text !== "") parts.push(text);
  }
  if (parts.length === 0) throw new ExtractError("zip_without_markdown");
  return parts.join("\n\n");
}

// ── PDF : texte par page via unpdf (build serverless de pdf.js) ──────────

async function extractPdf(data: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(data);
    const { text } = await extractText(doc, { mergePages: false });
    // Une page = un bloc ; les sauts de ligne internes sont préservés.
    const merged = (text as string[]).map((p) => p.trim()).filter(Boolean);
    if (merged.length === 0) throw new ExtractError("pdf_without_text");
    return merged.join("\n\n");
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    console.error("[import] extraction PDF échouée:", err);
    throw new ExtractError("invalid_pdf");
  }
}

// ── DOCX : paragraphes de word/document.xml, styles Heading -> titres ────

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function extractDocx(data: Uint8Array): string {
  let xml: string;
  try {
    const entries = unzipSync(data);
    const doc = entries["word/document.xml"];
    if (!doc) throw new ExtractError("invalid_docx");
    xml = strFromU8(doc);
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError("invalid_docx");
  }

  const paragraphs: string[] = [];
  for (const para of xml.split(/<w:p[ >]/).slice(1)) {
    const style = para.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] ?? "";
    const level = style.match(/^(?:Heading|Titre)(\d)$/i)?.[1];

    let text = "";
    // Runs dans l'ordre : textes, tabulations et sauts de ligne.
    for (const token of para.matchAll(
      /<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g,
    )) {
      if (token[0] === "<w:tab/>") text += "\t";
      else if (token[0] === "<w:br/>") text += "\n";
      else text += decodeXmlEntities(token[1] ?? "");
    }
    text = text.trim();
    if (text === "") continue;
    paragraphs.push(level ? `${"#".repeat(Number(level))} ${text}` : text);
  }
  if (paragraphs.length === 0) throw new ExtractError("docx_without_text");
  return paragraphs.join("\n\n");
}

/** Garde-fou : le texte extrait doit tenir dans les limites du canon. */
export function ensureExtractedSize(markdown: string): void {
  if (markdown.length > MAX_IMPORT_BYTES) {
    throw new ExtractError("file_too_large");
  }
}
