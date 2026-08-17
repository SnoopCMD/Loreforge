// Import d'un tableau de références depuis un .zip (§8) : sélection des
// images sur les octets d'en-tête, pas sur l'extension.

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  pickZipImages,
  sniffImageType,
  ZipError,
} from "../src/bibles/moodboard-zip";

/** Fabrique un contenu d'image minimal mais authentiquement signé. */
function fakeImage(kind: "jpeg" | "png" | "gif" | "webp", size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  const heads: Record<string, number[]> = {
    jpeg: [0xff, 0xd8, 0xff, 0xe0],
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  };
  bytes.set(heads[kind], 0);
  return bytes;
}

describe("sniffImageType", () => {
  it("reconnaît les quatre formats acceptés par la vision", () => {
    expect(sniffImageType(fakeImage("jpeg"))).toBe("image/jpeg");
    expect(sniffImageType(fakeImage("png"))).toBe("image/png");
    expect(sniffImageType(fakeImage("gif"))).toBe("image/gif");
    expect(sniffImageType(fakeImage("webp"))).toBe("image/webp");
  });

  it("refuse ce qui n'est pas une image, même bien nommé", () => {
    expect(sniffImageType(new TextEncoder().encode("PAS UNE IMAGE DU TOUT"))).toBe(
      null,
    );
    expect(sniffImageType(new Uint8Array(4))).toBe(null); // trop court
  });
});

describe("pickZipImages", () => {
  it("garde les images, ignore le reste, et suit l'ordre des chemins", () => {
    const zip = zipSync({
      "02.png": fakeImage("png"),
      "01.jpg": fakeImage("jpeg"),
      "notes.txt": new TextEncoder().encode("mes intentions"),
      "__MACOSX/._01.jpg": fakeImage("jpeg"),
      ".DS_Store": new Uint8Array([1, 2, 3]),
    });
    const { images, skipped } = pickZipImages(zip, 24, 5_000_000);
    expect(images.map((i) => i.name)).toEqual(["01.jpg", "02.png"]);
    expect(images[0].contentType).toBe("image/jpeg");
    expect(skipped).toBe(1); // notes.txt ; les entrées de service ne comptent pas
  });

  it("respecte le quota restant du tableau", () => {
    const zip = zipSync({
      "a.png": fakeImage("png"),
      "b.png": fakeImage("png"),
      "c.png": fakeImage("png"),
    });
    const { images, skipped } = pickZipImages(zip, 2, 5_000_000);
    expect(images).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it("écarte une image trop lourde sans faire échouer l'import", () => {
    const zip = zipSync({
      "petite.png": fakeImage("png"),
      "enorme.png": fakeImage("png", 4000),
    });
    const { images, skipped } = pickZipImages(zip, 24, 1000);
    expect(images.map((i) => i.name)).toEqual(["petite.png"]);
    expect(skipped).toBe(1);
  });

  it("refuse une archive illisible", () => {
    expect(() =>
      pickZipImages(new TextEncoder().encode("ceci n'est pas un zip"), 24, 5000),
    ).toThrow(ZipError);
  });
});
