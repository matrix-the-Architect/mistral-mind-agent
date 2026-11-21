/** Web Crypto helpers for the local vault: AES-GCM 256, fresh 12-byte IVs, stable AAD. */

import { SCHEMA_VERSION } from "./types";

const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The stable additional-authenticated-data representation for one artifact. Encryption and
 * decryption must build exactly the same bytes: schema version, namespace ID, generation and
 * artifact ID, in this order, joined by `|`.
 */
export function aadFor(parts: {
  schemaVersion: number;
  namespaceId: string;
  generation: number;
  artifactId: string;
}): Uint8Array {
  return encoder.encode(
    `ghost-memory/v1|schema=${parts.schemaVersion}|namespace=${parts.namespaceId}|generation=${parts.generation}|artifact=${parts.artifactId}`
  );
}

/**
 * The vault key: AES-GCM 256-bit, non-extractable, so no raw key material can be exported to a
 * string or sent anywhere. The CryptoKey object itself is persisted in IndexedDB by structured
 * cloning.
 */
export function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** A fresh random 12-byte IV for every new encryption. */
export function randomIv(): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  return iv;
}

export async function encryptText(
  key: CryptoKey,
  aad: Uint8Array,
  plaintext: string
): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    encoder.encode(plaintext)
  );
  return { iv: base64Encode(iv), ciphertext: base64Encode(new Uint8Array(ciphertext)) };
}

/**
 * Decrypt one artifact. A tampered ciphertext, IV or AAD fails AES-GCM authentication and this
 * rejects — callers must treat that as "the record is unreadable", never as a fallback to any
 * cached plaintext.
 */
export async function decryptText(
  key: CryptoKey,
  aad: Uint8Array,
  iv: string,
  ciphertext: string
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64Decode(iv) as BufferSource,
      additionalData: aad as BufferSource,
    },
    key,
    base64Decode(ciphertext) as BufferSource
  );
  return decoder.decode(plaintext);
}

export { SCHEMA_VERSION };
