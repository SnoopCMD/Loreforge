import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  isExpired,
  isValidEmail,
} from "../src/auth/tokens";

describe("generateToken", () => {
  it("produit un token base64url sans padding", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 octets -> 43 caractères base64url
    expect(token).toHaveLength(43);
  });

  it("produit des tokens distincts", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});

describe("hashToken", () => {
  it("est déterministe et renvoie 64 caractères hex", async () => {
    const a = await hashToken("abc");
    const b = await hashToken("abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Vecteur SHA-256 connu pour "abc"
    expect(a).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("diffère pour des entrées différentes", async () => {
    expect(await hashToken("abc")).not.toBe(await hashToken("abd"));
  });
});

describe("isExpired", () => {
  it("expiré si l'échéance est passée ou exactement maintenant", () => {
    expect(isExpired(1000, 1001)).toBe(true);
    expect(isExpired(1000, 1000)).toBe(true);
    expect(isExpired(1001, 1000)).toBe(false);
  });
});

describe("isValidEmail", () => {
  it.each(["a@b.co", "author@example.com", "x.y+z@sub.domain.io"])(
    "accepte %s",
    (email) => expect(isValidEmail(email)).toBe(true),
  );

  it.each(["", "no-at.com", "a@b", "a b@c.com", "a@b c.com", "@x.com"])(
    "rejette %s",
    (email) => expect(isValidEmail(email)).toBe(false),
  );

  it("rejette les emails de plus de 254 caractères", () => {
    expect(isValidEmail(`${"a".repeat(250)}@b.co`)).toBe(false);
  });
});
