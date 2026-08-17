// Import d'un tableau complet depuis un .zip (§8) : logique pure, testable.
//
// Le type est décidé sur les octets d'en-tête, jamais sur l'extension : une
// archive vient d'ailleurs (export Pinterest, dossier zippé, envoi d'un tiers)
// et un ".jpg" y est parfois tout autre chose. Ce qui n'est pas une image
// reconnue est compté et ignoré, sans faire échouer l'import entier.

import { unzipSync } from "fflate";

export interface ZipImage {
  /** Chemin dans l'archive : sert de légende par défaut. */
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ZipPick {
  images: ZipImage[];
  /** Entrées inexploitables : type non reconnu ou image trop lourde. */
  skipped: number;
  /** Images valides laissées de côté faute de place dans le tableau. */
  overQuota: number;
}

/** Au-delà, l'archive n'est plus une planche de références. */
export const MAX_ZIP_BYTES = 60 * 1024 * 1024;

/** Type MIME d'après les octets d'en-tête ; null si ce n'est pas une image. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  // RIFF....WEBP
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Entrées de service des archives macOS / Windows, jamais des références. */
function isJunkEntry(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return (
    path.startsWith("__MACOSX/") ||
    path.includes("/__MACOSX/") ||
    base.startsWith("._") ||
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base === ""
  );
}

export class ZipError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Images exploitables d'une archive, dans l'ordre des chemins (l'auteur qui a
 * numéroté ses fichiers retrouve son ordre), plafonnées par `limit`.
 */
export function pickZipImages(
  data: Uint8Array,
  limit: number,
  maxImageBytes: number,
): ZipPick {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    throw new ZipError("invalid_zip");
  }

  const images: ZipImage[] = [];
  let skipped = 0;
  let overQuota = 0;
  const paths = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    if (path.endsWith("/") || isJunkEntry(path)) continue;
    const bytes = entries[path];
    if (bytes.byteLength === 0) continue;
    if (bytes.byteLength > maxImageBytes) {
      skipped++;
      continue;
    }
    const contentType = sniffImageType(bytes);
    if (!contentType) {
      skipped++;
      continue;
    }
    if (images.length >= limit) {
      // Une image valide qu'on refuse faute de place n'est pas un déchet :
      // l'auteur doit pouvoir la distinguer d'un fichier non géré.
      overQuota++;
      continue;
    }
    images.push({ name: path, bytes, contentType });
  }
  return { images, skipped, overQuota };
}
