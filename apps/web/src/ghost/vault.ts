/**
 * Ghost's local vault: a persistent random namespace ID at generation 1, a non-extractable
 * AES-GCM 256-bit CryptoKey persisted directly in IndexedDB, and encrypted memory artifacts.
 *
 * Initialization is serialized at the module level AND re-checks existing state inside the
 * initialization transaction, so React StrictMode or concurrent effects cannot create
 * competing keys and overwrite the winning one: the first transaction to commit wins, later
 * ones see its records and reuse them.
 */

import { aadFor, decryptText, encryptText, generateVaultKey } from "./crypto";
import { SCHEMA_VERSION } from "./types";
import type {
  ArtifactEnvelope,
  DecryptedMemory,
  MemoryPayload,
  MemoryProvenance,
  VaultMeta,
} from "./types";
import { VAULT_KEY_KEY, VAULT_META_KEY } from "./store";
import type { VaultStore } from "./store";

export const GENERATION = 1;

/** How many of the most recent memories a recall supplies. No vector search in this milestone. */
export const RECALL_LIMIT = 3;

export interface Vault {
  namespaceId: string;
  generation: number;
  key: CryptoKey;
  meta: VaultMeta;
}

export type VaultInit =
  | { status: "ready"; vault: Vault }
  | { status: "key-unavailable" }
  | { status: "error"; message: string };

/**
 * Open (or create) the vault. Safe to call concurrently: the key and namespace are generated
 * before the transaction, but the transaction re-reads the stores, so only the first
 * committing transaction's records are kept and every caller ends up with the same vault.
 */
export async function initVault(store: VaultStore): Promise<VaultInit> {
  // Candidates, generated before the transaction so no Web Crypto call happens inside it.
  const candidateKey = await generateVaultKey();
  const candidateNamespaceId = crypto.randomUUID();
  const candidateMeta: VaultMeta = {
    namespaceId: candidateNamespaceId,
    generation: GENERATION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
  };

  try {
    return await store.transact(["vault", "keys", "artifacts"], "readwrite", async (tx) => {
      // Re-check inside the transaction: a concurrent initializer may have committed already.
      const meta = (await tx.get("vault", VAULT_META_KEY)) as VaultMeta | undefined;
      const key = (await tx.get("keys", VAULT_KEY_KEY)) as CryptoKey | undefined;
      const artifactCount = await tx.count("artifacts");

      if (meta && key) {
        // A normal reload: reuse the existing namespace and key.
        return { status: "ready", vault: { namespaceId: meta.namespaceId, generation: meta.generation, key, meta } };
      }
      if (!key && (meta || artifactCount > 0)) {
        // Vault data or ciphertext exists but the key is gone: never generate a replacement,
        // never overwrite, never fall back to plaintext.
        return { status: "key-unavailable" };
      }
      // Nothing exists: persist the selected key and the vault metadata before any ciphertext
      // can be saved, in the same transaction.
      await tx.put("vault", VAULT_META_KEY, candidateMeta);
      await tx.put("keys", VAULT_KEY_KEY, candidateKey);
      return {
        status: "ready",
        vault: { namespaceId: candidateMeta.namespaceId, generation: GENERATION, key: candidateKey, meta: candidateMeta },
      };
    });
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

let initPromise: Promise<VaultInit> | null = null;

/**
 * The app-wide singleton initialization, so StrictMode's double effect cannot start two
 * competing initializations. Tests call {@link initVault} directly instead.
 */
export function getVault(store: VaultStore): Promise<VaultInit> {
  initPromise ??= initVault(store);
  return initPromise;
}

/**
 * Drop the cached singleton so the next {@link getVault} re-reads the store. Used after Forget Me
 * wiped the vault, so "Start new session" initializes a brand-new namespace and key instead of
 * resurrecting the forgotten one.
 */
export function resetVaultSingleton(): void {
  initPromise = null;
}

/** Encrypt and persist one memory. Saving is always an explicit user action. */
export async function saveMemory(
  store: VaultStore,
  vault: Vault,
  text: string,
  provenance: MemoryProvenance
): Promise<ArtifactEnvelope> {
  const artifactId = crypto.randomUUID();
  const payload: MemoryPayload = { text, provenance };
  // Encrypt outside the transaction (Web Crypto is not an IDB request).
  const aad = aadFor({
    schemaVersion: SCHEMA_VERSION,
    namespaceId: vault.namespaceId,
    generation: vault.generation,
    artifactId,
  });
  const { iv, ciphertext } = await encryptText(vault.key, aad, JSON.stringify(payload));
  // The envelope carries only these six fields.
  const envelope: ArtifactEnvelope = {
    namespaceId: vault.namespaceId,
    generation: vault.generation,
    artifactId,
    schemaVersion: SCHEMA_VERSION,
    iv,
    ciphertext,
  };
  await store.transact(["artifacts"], "readwrite", async (tx) => {
    await tx.put("artifacts", artifactId, envelope);
  });
  return envelope;
}

/** All stored envelopes, oldest-created last; the creation time itself is inside the ciphertext. */
export async function listEnvelopes(store: VaultStore): Promise<ArtifactEnvelope[]> {
  const all = (await store.transact(["artifacts"], "readonly", (tx) => tx.getAll("artifacts"))) as ArtifactEnvelope[];
  return all;
}

export async function countArtifacts(store: VaultStore): Promise<number> {
  return store.transact(["artifacts"], "readonly", (tx) => tx.count("artifacts"));
}

export interface LocalInspection {
  vaultMetaPresent: boolean;
  keyRecordPresent: boolean;
  /** The stored CryptoKey's own `extractable` flag; null when no key record exists. */
  keyExtractable: boolean | null;
  artifactCount: number;
  observedAt: string;
}

/**
 * READ-ONLY local inspection for the evidence panel: one readonly transaction that only gets and
 * counts. It never puts, never deletes, and never calls the vault initializer — so it cannot create
 * a key or reconstruct a forgotten vault. Callers must only run it against an already-open store.
 */
export async function inspectVaultReadOnly(store: VaultStore): Promise<LocalInspection> {
  return store.transact(["vault", "keys", "artifacts"], "readonly", async (tx) => {
    const meta = await tx.get("vault", VAULT_META_KEY);
    const key = (await tx.get("keys", VAULT_KEY_KEY)) as CryptoKey | undefined;
    const artifactCount = await tx.count("artifacts");
    return {
      vaultMetaPresent: meta !== undefined && meta !== null,
      keyRecordPresent: key !== undefined && key !== null,
      keyExtractable: key ? key.extractable : null,
      artifactCount,
      observedAt: new Date().toISOString(),
    };
  });
}

/**
 * Decrypt one envelope with exactly the AAD it was encrypted with. Throws
 * `"unreadable record"` when AES-GCM authentication fails (tampered ciphertext/IV/AAD) or when
 * the envelope belongs to a different namespace/generation pair.
 */
export async function decryptEnvelope(vault: Vault, envelope: ArtifactEnvelope): Promise<DecryptedMemory> {
  if (
    envelope.namespaceId !== vault.namespaceId ||
    envelope.generation !== vault.generation ||
    envelope.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new Error("unreadable record: the envelope does not match the active vault");
  }
  const aad = aadFor({
    schemaVersion: envelope.schemaVersion,
    namespaceId: envelope.namespaceId,
    generation: envelope.generation,
    artifactId: envelope.artifactId,
  });
  let plaintext: string;
  try {
    plaintext = await decryptText(vault.key, aad, envelope.iv, envelope.ciphertext);
  } catch {
    throw new Error("unreadable record: authentication failed (the ciphertext was tampered with or the key is wrong)");
  }
  const payload = JSON.parse(plaintext) as MemoryPayload;
  return {
    artifactId: envelope.artifactId,
    namespaceId: envelope.namespaceId,
    generation: envelope.generation,
    payload,
  };
}

/**
 * Read every encrypted record, decrypt it in the browser, and return the `limit` most recent by
 * provenance creation time. Decrypted memory lives only in the returned transient values.
 */
export async function recallMemories(store: VaultStore, vault: Vault, limit = RECALL_LIMIT): Promise<DecryptedMemory[]> {
  const envelopes = await listEnvelopes(store);
  const decrypted: DecryptedMemory[] = [];
  for (const envelope of envelopes) {
    decrypted.push(await decryptEnvelope(vault, envelope));
  }
  decrypted.sort((a, b) => b.payload.provenance.createdAt.localeCompare(a.payload.provenance.createdAt));
  return decrypted.slice(0, limit);
}

/** Decrypt all saved memories (for the memory panel). Throws on any unreadable record. */
export async function loadAllMemories(store: VaultStore, vault: Vault): Promise<DecryptedMemory[]> {
  const envelopes = await listEnvelopes(store);
  const decrypted: DecryptedMemory[] = [];
  for (const envelope of envelopes) {
    decrypted.push(await decryptEnvelope(vault, envelope));
  }
  decrypted.sort((a, b) => b.payload.provenance.createdAt.localeCompare(a.payload.provenance.createdAt));
  return decrypted;
}
