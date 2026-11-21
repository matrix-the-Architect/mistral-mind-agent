/**
 * Milestone-2 web tests: the remote ciphertext round trip, session isolation, the Forget Me flow
 * (offline and online), erasure replay after a lost response, and the guards that keep forgotten
 * memory from returning. The relay is an in-memory fake implementing the same contract as the
 * FastAPI routes (bearer sessions, ownership, active-state checks, deletion capability, idempotent
 * erasure); the Python suite tests the real server against real PostgreSQL.
 */

import { describe, expect, test } from "bun:test";

import { createRemoteApi } from "./api";
import { createFakeRelay } from "../test/fakeRelay";
import { STORE_NAMES, VAULT_KEY_KEY, VAULT_META_KEY } from "./store";
import type { ControlStore } from "./control";
import {
  assertPairActive,
  bootstrapGhost,
  forgetVault,
  loadForgetting,
  retryAllPendingForgetting,
  startNewSession,
} from "./forget";
import { countArtifacts, decryptEnvelope, recallMemories, saveMemory } from "./vault";
import type { StoreName, VaultStore, VaultTx } from "./store";
import type { ArtifactEnvelope } from "./types";

// --- in-memory stores -------------------------------------------------------------

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

function createMemoryControl(shared?: Map<string, unknown>): ControlStore & { raw: Map<string, unknown> } {
  const raw = shared ?? new Map<string, unknown>();
  return {
    raw,
    get: async <T>(key: string) => raw.get(key) as T | undefined,
    put: async (key, value) => {
      raw.set(key, structuredClone(value));
    },
    delete: async (key) => {
      raw.delete(key);
    },
    keys: async () => [...raw.keys()],
  };
}

// --- fake relay implementing the server contract ------------------------------------

const provenance = () => ({
  source: "mistral-answer (test-model)",
  createdAt: new Date().toISOString(),
  purpose: "user-saved decision from a Ghost conversation",
});

async function bootVault(relay: ReturnType<typeof createFakeRelay>, store = createMemoryStore(), control = createMemoryControl()) {
  const api = createRemoteApi(relay.fetchFn);
  const boot = await bootstrapGhost({ vaultStore: store, control, api });
  if (boot.kind !== "ready") throw new Error(`bootstrap failed: ${boot.kind}`);
  return { api, store, control, ...boot };
}

// --- tests --------------------------------------------------------------------------

describe("inference wire format", () => {
  test("postInference maps to the relay's snake_case contract and returns the answer", async () => {
    const relay = createFakeRelay();
    const { api, vault, session } = await bootVault(relay);
    const result = await api.postInference(
      session.token,
      { messages: [{ role: "user", content: "hello" }], namespaceId: vault.namespaceId, generation: 1 }
    );
    expect(result.text).toBe("fake answer");
    expect(result.model).toBe("test-model");
    expect(result.namespace_id).toBe(vault.namespaceId);
    expect(result.generation).toBe(1);
  });
});

describe("remote ciphertext round trip", () => {
  test("save, upload, clear only the local artifact cache, fetch the server ciphertext, decrypt", async () => {
    const relay = createFakeRelay();
    const { api, store, vault, session } = await bootVault(relay);

    const envelope = await saveMemory(store, vault, "Cedar: offline QR/PIN check-in, no email.", provenance());
    const status = await api.uploadArtifact(session.token, envelope);
    expect(status).toBe("stored");
    // Idempotent replay.
    expect(await api.uploadArtifact(session.token, envelope)).toBe("exists");

    // Remove ONLY the local artifact cache; the key and namespace stay.
    await store.transact(["artifacts"], "readwrite", async (tx) => {
      const all = (await tx.getAll("artifacts")) as ArtifactEnvelope[];
      for (const item of all) await tx.delete("artifacts", item.artifactId);
    });
    expect(await countArtifacts(store)).toBe(0);
    expect(await store.transact(["keys"], "readonly", (tx) => tx.get("keys", VAULT_KEY_KEY))).toBeInstanceOf(CryptoKey);

    // Fetch the server ciphertext and decrypt it with the retained key.
    const remote = await api.listArtifacts(session.token, vault.namespaceId);
    expect(remote).toEqual([envelope]);
    const fetched = await api.fetchArtifact(session.token, vault.namespaceId, envelope.artifactId);
    expect(fetched).toEqual(envelope);

    await store.transact(["artifacts"], "readwrite", (tx) => tx.put("artifacts", fetched.artifactId, fetched));
    const memories = await recallMemories(store, vault);
    expect(memories).toHaveLength(1);
    const memory = memories[0] as (typeof memories)[number];
    expect(memory.payload.text).toBe("Cedar: offline QR/PIN check-in, no email.");
    expect(memory.artifactId).toBe(envelope.artifactId);
  });
});

describe("session isolation", () => {
  test("A cannot read, write or erase B's memory; forgetting A leaves B intact", async () => {
    const relay = createFakeRelay();
    const a = await bootVault(relay);
    const b = await bootVault(relay);
    expect(a.vault.namespaceId).not.toBe(b.vault.namespaceId);

    const envelopeA = await saveMemory(a.store, a.vault, "A secret codename", provenance());
    await a.api.uploadArtifact(a.session.token, envelopeA);
    const envelopeB = await saveMemory(b.store, b.vault, "B secret codename", provenance());
    await b.api.uploadArtifact(b.session.token, envelopeB);

    // B cannot read, write or erase A's namespace.
    await expect(b.api.listArtifacts(b.session.token, a.vault.namespaceId)).rejects.toThrow();
    await expect(b.api.uploadArtifact(b.session.token, envelopeA)).rejects.toThrow();
    await expect(b.api.eraseNamespace(b.session.token, a.vault.namespaceId, crypto.randomUUID())).rejects.toThrow();
    await expect(
      b.api.postInference(b.session.token, { messages: [{ role: "user", content: "hi" }], namespaceId: a.vault.namespaceId, generation: 1 })
    ).rejects.toThrow();

    // Forget A completely; B is untouched.
    const outcome = await forgetVault({ vaultStore: a.store, control: a.control, api: a.api }, {
      namespaceId: a.vault.namespaceId,
      generation: a.vault.generation,
    });
    const record = await outcome.remote;
    expect(record.remote).toBe("completed");
    const bList = await b.api.listArtifacts(b.session.token, b.vault.namespaceId);
    expect(bList).toEqual([envelopeB]);
    expect(relay.artifacts.get(a.vault.namespaceId)?.size ?? 0).toBe(0);
  });
});

describe("erasure replay and revoked access", () => {
  test("replaying erasure after a lost response returns the same result via the deletion capability", async () => {
    const relay = createFakeRelay();
    const { api, store, control, vault, session, capability } = await bootVault(relay);
    const pair = { namespaceId: vault.namespaceId, generation: vault.generation };
    const envelope = await saveMemory(store, vault, "to be forgotten", provenance());
    await api.uploadArtifact(session.token, envelope);

    const first = await api.eraseNamespace(capability.deletionToken, pair.namespaceId, capability.idempotencyKey);
    expect(first.status).toBe("completed");
    expect(first.artifacts_removed).toBe(1);

    // Ordinary access is revoked; the deletion capability still works.
    await expect(api.listArtifacts(session.token, pair.namespaceId)).rejects.toThrow();
    await expect(api.uploadArtifact(session.token, envelope)).rejects.toThrow();
    await expect(
      api.postInference(session.token, { messages: [{ role: "user", content: "late" }], namespaceId: pair.namespaceId, generation: 1 })
    ).rejects.toThrow();
    await expect(api.eraseNamespace(session.token, pair.namespaceId, capability.idempotencyKey)).rejects.toThrow();

    // Lost first response: replay returns the same completed result; the result route works too.
    const replay = await api.eraseNamespace(capability.deletionToken, pair.namespaceId, capability.idempotencyKey);
    expect(replay.status).toBe("completed");
    expect(replay.artifacts_removed).toBe(1);
    const fetched = await api.getErasure(capability.deletionToken, pair.namespaceId);
    expect(fetched.status).toBe("completed");
    await expect(api.getErasure(session.token, pair.namespaceId)).rejects.toThrow();

    // A revoked namespace cannot be re-registered.
    await expect(api.registerNamespace(session.token, pair.namespaceId, 1)).rejects.toThrow();
    void control;
  });
});

describe("forget flow", () => {
  test("offline forgetting wipes local access, survives reload, and completes remote cleanup on retry", async () => {
    const relay = createFakeRelay();
    const { api, store, control, vault } = await bootVault(relay);
    const pair = { namespaceId: vault.namespaceId, generation: vault.generation };
    await saveMemory(store, vault, "local only", provenance());
    expect(await countArtifacts(store)).toBe(1);

    relay.setFailErase(true); // offline for the erasure call
    const outcome = await forgetVault({ vaultStore: store, control, api }, pair);
    expect(outcome.record.localKeyRemoved).toBe(true);
    expect(outcome.record.localRecordsRemoved).toBeGreaterThanOrEqual(2); // artifacts + vault meta
    const record = await outcome.remote;
    expect(record.remote).toBe("failed"); // reported as pending/failed, never as success

    // The vault is really gone: key, metadata and artifacts.
    expect(await store.transact(["keys"], "readonly", (tx) => tx.get("keys", VAULT_KEY_KEY))).toBeUndefined();
    expect(await store.transact(["vault"], "readonly", (tx) => tx.get("vault", VAULT_META_KEY))).toBeUndefined();
    expect(await countArtifacts(store)).toBe(0);

    // Simulate a hard reload: fresh store objects over the same raw maps.
    const store2 = createMemoryStore(store.raw);
    const control2 = createMemoryControl(control.raw);
    const boot2 = await bootstrapGhost({ vaultStore: store2, control: control2, api });
    expect(boot2.kind).toBe("forgotten");
    if (boot2.kind === "forgotten") expect(boot2.record.remote).toBe("failed");
    // The old vault was NOT silently reconstructed.
    expect(store2.raw.get("vault")?.size ?? 0).toBe(0);
    expect(store2.raw.get("keys")?.size ?? 0).toBe(0);

    // Back online: the retry survives the reload and completes remote cleanup.
    relay.setFailErase(false);
    const results = await retryAllPendingForgetting({ vaultStore: store2, control: control2, api });
    expect(results).toHaveLength(1);
    const retried = results[0] as (typeof results)[number];
    expect(retried.remote).toBe("completed");
    expect(retried.artifactsRemoved).toBe(0); // nothing had been uploaded in this test
    expect(await loadForgetting(control2)).not.toBeNull();
  });

  test("delayed writes and inference results cannot restore or display forgotten memory", async () => {
    const relay = createFakeRelay();
    const { api, store, control, vault, session, capability } = await bootVault(relay);
    const pair = { namespaceId: vault.namespaceId, generation: vault.generation };
    const envelope = await saveMemory(store, vault, "old memory", provenance());
    await api.uploadArtifact(session.token, envelope);

    const outcome = await forgetVault({ vaultStore: store, control, api }, pair);
    await outcome.remote;

    // The pair guard rejects anything captured before the forget — including a new namespace at
    // the same generation 1 (both fields are compared).
    expect(() => assertPairActive(null, pair)).toThrow();
    expect(() => assertPairActive({ namespaceId: "another-namespace", generation: 1 }, pair)).toThrow();
    expect(() => assertPairActive(pair, pair)).not.toThrow();

    // A delayed write with the old session token is rejected by the server (namespace revoked).
    await expect(api.uploadArtifact(session.token, envelope)).rejects.toThrow();
    // A delayed inference response is refused server-side and discarded client-side.
    await expect(
      api.postInference(session.token, { messages: [{ role: "user", content: "late question" }], namespaceId: pair.namespaceId, generation: 1 })
    ).rejects.toThrow();
    expect(() => assertPairActive(null, pair)).toThrow("discarded");
    void capability;
  });

  test("start new session creates a different namespace/key and inherits no old context", async () => {
    const relay = createFakeRelay();
    const { api, store, control, vault, session } = await bootVault(relay);
    const pair = { namespaceId: vault.namespaceId, generation: vault.generation };
    const oldEnvelope = await saveMemory(store, vault, "forgotten content", provenance());
    await api.uploadArtifact(session.token, oldEnvelope);
    const outcome = await forgetVault({ vaultStore: store, control, api }, pair);
    await outcome.remote;

    const result = await startNewSession({ vaultStore: store, control, api });
    expect(result.bootstrap.kind).toBe("ready");
    if (result.bootstrap.kind !== "ready") return;
    const next = result.bootstrap;
    expect(next.vault.namespaceId).not.toBe(pair.namespaceId);
    expect(next.vault.generation).toBe(1); // fresh vault, also at generation 1 — which is why both fields are compared

    // The forgotten envelope cannot be decrypted under the new vault (AAD binds the old pair).
    await expect(decryptEnvelope(next.vault, oldEnvelope)).rejects.toThrow("unreadable record");
    // The old namespace stays revoked server-side.
    await expect(api.registerNamespace(next.session.token, pair.namespaceId, 1)).rejects.toThrow();
    // No old artifacts exist anywhere locally.
    expect(await countArtifacts(store)).toBe(0);
    // The active forgetting marker was archived, not silently dropped.
    expect(await loadForgetting(control)).toBeNull();
    expect((await control.keys()).some((key) => key.startsWith("forgotten:"))).toBe(true);
  });

  test("a vault with ciphertext but no key still reports key-unavailable (no silent replacement)", async () => {
    const relay = createFakeRelay();
    const store = createMemoryStore();
    const control = createMemoryControl();
    const api = createRemoteApi(relay.fetchFn);
    const boot = await bootstrapGhost({ vaultStore: store, control, api });
    if (boot.kind !== "ready") throw new Error("expected ready");
    await saveMemory(store, boot.vault, "x", provenance());
    // Remove only the key, keep ciphertext: reload must not regenerate a key.
    await store.transact(["keys"], "readwrite", (tx) => tx.delete("keys", VAULT_KEY_KEY));
    const store2 = createMemoryStore(store.raw);
    const control2 = createMemoryControl(control.raw);
    const boot2 = await bootstrapGhost({ vaultStore: store2, control: control2, api });
    expect(boot2.kind).toBe("key-unavailable");
  });
});
