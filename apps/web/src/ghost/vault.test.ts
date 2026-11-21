import { describe, expect, test } from "bun:test";

import { STORE_NAMES } from "./store";
import type { StoreName, VaultStore, VaultTx } from "./store";
import {
  GENERATION,
  RECALL_LIMIT,
  countArtifacts,
  decryptEnvelope,
  initVault,
  listEnvelopes,
  loadAllMemories,
  recallMemories,
  saveMemory,
} from "./vault";
import type { ArtifactEnvelope, VaultMeta } from "./types";
import { VAULT_KEY_KEY, VAULT_META_KEY } from "./store";
import { aadFor, base64Decode, decryptText } from "./crypto";
import { SCHEMA_VERSION } from "./types";

/**
 * An in-memory VaultStore with IndexedDB's semantics that matter here: transactions are
 * serialized, and values are structured-cloned on write and read, so a CryptoKey crosses a
 * "reload" the way it crosses real IndexedDB. A second store over the same maps emulates a hard
 * reload of the page.
 */
function createMemoryStore(shared?: Map<StoreName, Map<string, unknown>>): VaultStore & {
  raw: Map<StoreName, Map<string, unknown>>;
} {
  const raw = shared ?? new Map(STORE_NAMES.map((name) => [name, new Map<string, unknown>()] as const));
  let chain: Promise<unknown> = Promise.resolve();
  const store: VaultStore & { raw: Map<StoreName, Map<string, unknown>> } = {
    raw,
    transact(_stores, _mode, fn) {
      const run = chain.then(async () => {
        const tx: VaultTx = {
          get: async (name, key) => {
            const value = raw.get(name)?.get(key);
            return value === undefined ? undefined : structuredClone(value);
          },
          put: async (name, key, value) => {
            raw.get(name)?.set(key, structuredClone(value));
          },
          delete: async (name, key) => {
            raw.get(name)?.delete(key);
          },
          count: async (name) => raw.get(name)?.size ?? 0,
          getAll: async (name) => [...(raw.get(name)?.values() ?? [])].map((value) => structuredClone(value)),
        };
        return fn(tx);
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}

const provenance = (n: number) => ({
  source: `mistral-answer (test-model) #${n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  purpose: "user-saved decision from a Ghost conversation",
});

describe("vault initialization", () => {
  test("creates a random namespace at generation 1 and persists meta plus a non-extractable key", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    expect(init.status).toBe("ready");
    if (init.status !== "ready") return;
    expect(init.vault.generation).toBe(GENERATION);
    expect(init.vault.namespaceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(init.vault.key.extractable).toBe(false);

    const meta = (await store.transact(["vault"], "readonly", (tx) => tx.get("vault", VAULT_META_KEY))) as VaultMeta;
    const key = (await store.transact(["keys"], "readonly", (tx) => tx.get("keys", VAULT_KEY_KEY))) as CryptoKey;
    expect(meta.namespaceId).toBe(init.vault.namespaceId);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.extractable).toBe(false);
  });

  test("concurrent initialization (StrictMode double effect) converges on one vault", async () => {
    const store = createMemoryStore();
    const [a, b] = await Promise.all([initVault(store), initVault(store)]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status !== "ready" || b.status !== "ready") return;
    expect(a.vault.namespaceId).toBe(b.vault.namespaceId);
    // One key record only, and both callers can use the persisted one.
    const keys = await store.transact(["keys"], "readonly", (tx) => tx.getAll("keys"));
    expect(keys.length).toBe(1);
  });

  test("a hard reload (fresh store over the same data) reuses the namespace and key", async () => {
    const first = createMemoryStore();
    const init1 = await initVault(first);
    if (init1.status !== "ready") throw new Error("expected ready");
    await saveMemory(first, init1.vault, "cedar decision", provenance(1));

    // "Reload": a brand-new store object over the same underlying maps.
    const second = createMemoryStore(first.raw);
    const init2 = await initVault(second);
    expect(init2.status).toBe("ready");
    if (init2.status !== "ready") return;
    expect(init2.vault.namespaceId).toBe(init1.vault.namespaceId);
    expect(init2.vault.generation).toBe(GENERATION);

    // The reloaded key can decrypt what the first session encrypted.
    const envelopes = await listEnvelopes(second);
    const memory = await decryptEnvelope(init2.vault, envelopes[0]!);
    expect(memory.payload.text).toBe("cedar decision");
  });

  test("ciphertext plus a missing key yields the explicit key-unavailable state", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    await saveMemory(store, init.vault, "cedar decision", provenance(1));

    // Simulate key loss: delete the key record, keep the ciphertext.
    await store.transact(["keys"], "readwrite", (tx) => tx.delete("keys", VAULT_KEY_KEY));
    const reloaded = createMemoryStore(store.raw);
    const init2 = await initVault(reloaded);
    expect(init2.status).toBe("key-unavailable");

    // And it did not silently regenerate a key or overwrite anything.
    const keys = await reloaded.transact(["keys"], "readonly", (tx) => tx.getAll("keys"));
    expect(keys.length).toBe(0);
    expect(await countArtifacts(reloaded)).toBe(1);
  });
});

describe("saving and recalling memories", () => {
  test("the stored envelope contains only the six allowed fields", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    const envelope = await saveMemory(store, init.vault, "use offline QR check-in", provenance(1));
    expect(Object.keys(envelope).sort()).toEqual(
      ["artifactId", "ciphertext", "generation", "iv", "namespaceId", "schemaVersion"].sort()
    );
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.namespaceId).toBe(init.vault.namespaceId);
    expect(envelope.generation).toBe(GENERATION);
    expect(base64Decode(envelope.iv).length).toBe(12);
    expect(envelope.ciphertext).not.toContain("offline QR");
  });

  test("the plaintext payload (text + provenance) is what is encrypted, and decrypts back", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    await saveMemory(store, init.vault, "codename: Lantern", provenance(2));
    const [envelope] = await listEnvelopes(store);
    const memory = await decryptEnvelope(init.vault, envelope!);
    expect(memory.payload.text).toBe("codename: Lantern");
    expect(memory.payload.provenance.source).toBe("mistral-answer (test-model) #2");
    expect(memory.payload.provenance.purpose).toContain("user-saved");
  });

  test("recall returns at most the three most recent memories, newest first", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    for (let n = 1; n <= 5; n += 1) {
      await saveMemory(store, init.vault, `memory ${n}`, provenance(n));
    }
    const recalled = await recallMemories(store, init.vault);
    expect(recalled.length).toBe(RECALL_LIMIT);
    expect(recalled.map((m) => m.payload.text)).toEqual(["memory 5", "memory 4", "memory 3"]);
    expect(await countArtifacts(store)).toBe(5);
    expect((await loadAllMemories(store, init.vault)).length).toBe(5);
  });

  test("tampered ciphertext is reported as an unreadable record, never as stale plaintext", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    const envelope = await saveMemory(store, init.vault, "tamper target", provenance(1));
    const raw = base64Decode(envelope.ciphertext);
    raw[3] = raw[3]! ^ 0x01;
    const tampered: ArtifactEnvelope = { ...envelope, ciphertext: Buffer.from(raw).toString("base64") };
    await expect(decryptEnvelope(init.vault, tampered)).rejects.toThrow(/unreadable record/);
    // Write the tampered record into the store: a recall that hits it must fail, not fall back.
    await store.transact(["artifacts"], "readwrite", (tx) => tx.put("artifacts", tampered.artifactId, tampered));
    await expect(recallMemories(store, init.vault)).rejects.toThrow(/unreadable record/);
  });

  test("decryption uses exactly the AAD the envelope was written with", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    const envelope = await saveMemory(store, init.vault, "aad check", provenance(1));
    const aad = aadFor({
      schemaVersion: envelope.schemaVersion,
      namespaceId: envelope.namespaceId,
      generation: envelope.generation,
      artifactId: envelope.artifactId,
    });
    await expect(decryptText(init.vault.key, aad, envelope.iv, envelope.ciphertext)).resolves.toContain("aad check");
    // The AAD of a different artifact must not open it.
    const wrongAad = aadFor({ ...envelope, artifactId: "someone-else" });
    await expect(decryptText(init.vault.key, wrongAad, envelope.iv, envelope.ciphertext)).rejects.toThrow();
  });

  test("an envelope from another namespace/generation is rejected", async () => {
    const store = createMemoryStore();
    const init = await initVault(store);
    if (init.status !== "ready") throw new Error("expected ready");
    const envelope = await saveMemory(store, init.vault, "ns check", provenance(1));
    await expect(decryptEnvelope(init.vault, { ...envelope, generation: 99 })).rejects.toThrow(/unreadable record/);
    await expect(decryptEnvelope(init.vault, { ...envelope, namespaceId: "other-ns" })).rejects.toThrow(/unreadable record/);
  });
});
