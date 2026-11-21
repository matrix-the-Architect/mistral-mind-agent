import { describe, expect, test } from "bun:test";

import { aadFor, base64Decode, decryptText, encryptText, generateVaultKey, randomIv } from "./crypto";
import { SCHEMA_VERSION } from "./types";

const PARTS = {
  schemaVersion: SCHEMA_VERSION,
  namespaceId: "ns-1",
  generation: 1,
  artifactId: "artifact-1",
};

describe("vault crypto", () => {
  test("the vault key is AES-GCM 256, non-extractable", async () => {
    const key = await generateVaultKey();
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["encrypt", "decrypt"]);
  });

  test("the AAD representation is stable and binds every envelope field", () => {
    const a = aadFor(PARTS);
    const b = aadFor({ ...PARTS });
    expect(Buffer.from(a).toString()).toBe(Buffer.from(b).toString());
    expect(new TextDecoder().decode(a)).toBe(
      "ghost-memory/v1|schema=1|namespace=ns-1|generation=1|artifact=artifact-1"
    );
    expect(Buffer.from(aadFor({ ...PARTS, artifactId: "other" })).toString()).not.toBe(Buffer.from(a).toString());
    expect(Buffer.from(aadFor({ ...PARTS, generation: 2 })).toString()).not.toBe(Buffer.from(a).toString());
    expect(Buffer.from(aadFor({ ...PARTS, schemaVersion: 2 })).toString()).not.toBe(Buffer.from(a).toString());
  });

  test("every encryption uses a fresh random 12-byte IV", () => {
    const ivs = new Set(Array.from({ length: 50 }, () => Buffer.from(randomIv()).toString()));
    expect(ivs.size).toBe(50);
    expect(base64Decode(Buffer.from(randomIv()).toString("base64")).length).toBe(12);
  });

  test("encrypt/decrypt round-trips with the same AAD", async () => {
    const key = await generateVaultKey();
    const aad = aadFor(PARTS);
    const { iv, ciphertext } = await encryptText(key, aad, "Project Cedar decision");
    expect(base64Decode(iv).length).toBe(12);
    expect(ciphertext).not.toContain("Project Cedar");
    await expect(decryptText(key, aad, iv, ciphertext)).resolves.toBe("Project Cedar decision");
  });

  test("tampered ciphertext fails authentication", async () => {
    const key = await generateVaultKey();
    const aad = aadFor(PARTS);
    const { iv, ciphertext } = await encryptText(key, aad, "secret decision");
    const raw = base64Decode(ciphertext);
    raw[0] = raw[0]! ^ 0xff;
    const tampered = Buffer.from(raw).toString("base64");
    await expect(decryptText(key, aad, iv, tampered)).rejects.toThrow();
  });

  test("a different AAD (different artifact id) fails authentication", async () => {
    const key = await generateVaultKey();
    const { iv, ciphertext } = await encryptText(key, aadFor(PARTS), "secret decision");
    await expect(decryptText(key, aadFor({ ...PARTS, artifactId: "artifact-2" }), iv, ciphertext)).rejects.toThrow();
  });

  test("a different key fails authentication", async () => {
    const key = await generateVaultKey();
    const other = await generateVaultKey();
    const aad = aadFor(PARTS);
    const { iv, ciphertext } = await encryptText(key, aad, "secret decision");
    await expect(decryptText(other, aad, iv, ciphertext)).rejects.toThrow();
  });
});
