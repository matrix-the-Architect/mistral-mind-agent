/**
 * Milestone 3 tests: the Memory trail's pure logic, backward-compatible provenance, and the
 * guarantee that no plaintext provenance ever leaves the browser (the upload body is exactly the
 * six envelope fields; provenance lives only inside the ciphertext).
 */

import { describe, expect, test } from "bun:test";

import { createRemoteApi } from "./api";
import { createFakeRelay } from "../test/fakeRelay";
import { STORE_NAMES } from "./store";
import type { ControlStore } from "./control";
import { assertPairActive, bootstrapGhost, forgetVault } from "./forget";
import { countArtifacts, decryptEnvelope, recallMemories, saveMemory } from "./vault";
import type { StoreName, VaultStore, VaultTx } from "./store";
import type { ArtifactEnvelope, MemoryProvenance } from "./types";
import { creationProvenance, originDisplay, receiptsForMemory, snapshotMatches } from "./trail";
import type { UsageReceipt } from "./trail";

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

const legacyProvenance = (): MemoryProvenance => ({
  source: "mistral-answer (test-model)",
  createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  purpose: "user-saved decision from a Ghost conversation",
});

const newProvenance = (): MemoryProvenance => ({
  ...legacyProvenance(),
  sourceKind: "saved-from-analysis",
  sourceAnalysisId: crypto.randomUUID(),
  editedBeforeSave: true,
});

describe("origin display", () => {
  test("records saved before milestone 3 show 'Origin not recorded.' and still decrypt", async () => {
    const store = createMemoryStore();
    const relay = createFakeRelay();
    const api = createRemoteApi(relay.fetchFn);
    const control = createMemoryControl();
    const boot = await bootstrapGhost({ vaultStore: store, control, api });
    if (boot.kind !== "ready") throw new Error("expected ready");
    // A legacy record: provenance without the new fields, encrypted as before.
    const envelope = await saveMemory(store, boot.vault, "legacy memory text", legacyProvenance());
    const decrypted = await decryptEnvelope(boot.vault, envelope);
    expect(decrypted.payload.text).toBe("legacy memory text");
    const origin = originDisplay(decrypted);
    expect(origin.text).toBe("Origin not recorded.");
    expect(origin.sourceKind).toBeUndefined();
  });

  test("new records show kind, Ghost analysis ID (labeled), createdAt and edit status", async () => {
    const store = createMemoryStore();
    const relay = createFakeRelay();
    const api = createRemoteApi(relay.fetchFn);
    const control = createMemoryControl();
    const boot = await bootstrapGhost({ vaultStore: store, control, api });
    if (boot.kind !== "ready") throw new Error("expected ready");
    const provenance = newProvenance();
    const envelope = await saveMemory(store, boot.vault, "new memory", provenance);
    const decrypted = await decryptEnvelope(boot.vault, envelope);
    const origin = originDisplay(decrypted);
    expect(origin.sourceKind).toBe("saved-from-analysis");
    expect(origin.sourceAnalysisId).toBe(provenance.sourceAnalysisId);
    expect(origin.editedBeforeSave).toBe(true);
    expect(origin.text).toContain("saved from analysis");
    expect(origin.text).toContain("Ghost analysis ID");
    expect(origin.text).toContain("edited before save");
  });
});

describe("creation provenance computation", () => {
  test("seeded and unedited -> saved-from-analysis, not edited", () => {
    const seeded = { analysisId: "aaaa-bbbb", text: "proposed" };
    expect(creationProvenance({ seeded, memoryText: "proposed" })).toEqual({
      sourceKind: "saved-from-analysis",
      sourceAnalysisId: "aaaa-bbbb",
      editedBeforeSave: false,
    });
  });

  test("seeded and changed -> editedBeforeSave true", () => {
    const seeded = { analysisId: "aaaa-bbbb", text: "proposed" };
    const result = creationProvenance({ seeded, memoryText: "proposed, plus my codename" });
    expect(result.sourceKind).toBe("saved-from-analysis");
    expect(result.editedBeforeSave).toBe(true);
  });

  test("no proposal -> user-entered, editedBeforeSave false (not fabricated)", () => {
    expect(creationProvenance({ seeded: null, memoryText: "typed by hand" })).toEqual({
      sourceKind: "user-entered",
      editedBeforeSave: false,
    });
  });
});

describe("usage receipts", () => {
  const snapshot = [{ role: "user" as const, content: "q" }];
  const receipts: UsageReceipt[] = [
    { requestId: "r1", status: "answered", memoryIds: ["m1", "m2"], snapshot, at: "t" },
    { requestId: "r2", status: "pending", memoryIds: [], snapshot, at: "t" },
    { requestId: "r3", status: "failed", memoryIds: ["m2"], snapshot, at: "t", error: "boom" },
  ];

  test("receiptsForMemory returns exactly the requests that included the artifact", () => {
    expect(receiptsForMemory(receipts, "m2").map((r) => r.requestId)).toEqual(["r1", "r3"]);
    expect(receiptsForMemory(receipts, "m1").map((r) => r.requestId)).toEqual(["r1"]);
    expect(receiptsForMemory(receipts, "nope")).toEqual([]);
  });

  test("snapshotMatches compares the exact approved messages array", () => {
    const first = receipts[0] as UsageReceipt;
    expect(snapshotMatches(first, snapshot)).toBe(true);
    expect(snapshotMatches(first, [{ role: "user", content: "changed" }])).toBe(false);
    expect(snapshotMatches(first, [])).toBe(false);
  });
});

describe("provenance stays inside the ciphertext", () => {
  test("upload body is exactly the six envelope fields; provenance survives a remote round trip encrypted", async () => {
    const relay = createFakeRelay();
    const api = createRemoteApi(relay.fetchFn);
    const store = createMemoryStore();
    const control = createMemoryControl();
    const boot = await bootstrapGhost({ vaultStore: store, control, api });
    if (boot.kind !== "ready") throw new Error("expected ready");

    const provenance = newProvenance();
    const envelope = await saveMemory(store, boot.vault, "Cedar codename: Juniper", provenance);
    await api.uploadArtifact(boot.session.token, envelope);

    // What went on the wire: exactly the envelope fields, nothing else (no plaintext provenance).
    const uploadCall = relay.requests.find((r) => r.method === "POST" && r.path.endsWith("/artifacts"));
    expect(uploadCall).toBeDefined();
    expect(Object.keys(uploadCall!.body as object).sort()).toEqual(
      ["artifact_id", "ciphertext", "generation", "iv", "namespace_id", "schema_version"].sort()
    );
    const wireBody = JSON.stringify(uploadCall!.body);
    expect(wireBody).not.toContain("sourceKind");
    expect(wireBody).not.toContain("Juniper");
    // The envelope itself keeps its original six-field shape.
    expect(Object.keys(envelope).sort()).toEqual(
      ["artifactId", "ciphertext", "generation", "iv", "namespaceId", "schemaVersion"].sort()
    );

    // Remote round trip: drop only the local artifact cache, fetch, decrypt — provenance intact.
    await store.transact(["artifacts"], "readwrite", async (tx) => {
      const all = (await tx.getAll("artifacts")) as ArtifactEnvelope[];
      for (const item of all) await tx.delete("artifacts", item.artifactId);
    });
    expect(await countArtifacts(store)).toBe(0);
    const fetched = await api.fetchArtifact(boot.session.token, boot.vault.namespaceId, envelope.artifactId);
    expect(fetched).toEqual(envelope);
    await store.transact(["artifacts"], "readwrite", (tx) => tx.put("artifacts", fetched.artifactId, fetched));
    const memories = await recallMemories(store, boot.vault);
    const memory = memories[0] as (typeof memories)[number];
    expect(memory.payload.text).toBe("Cedar codename: Juniper");
    expect(memory.payload.provenance.sourceKind).toBe("saved-from-analysis");
    expect(memory.payload.provenance.sourceAnalysisId).toBe(provenance.sourceAnalysisId);
    expect(memory.payload.provenance.editedBeforeSave).toBe(true);
  });
});

describe("forgetting clears the trail's transient state and late callbacks cannot repopulate it", () => {
  test("after Forget Me the pair guard rejects late updates and no memory content is persisted anywhere", async () => {
    const relay = createFakeRelay();
    const api = createRemoteApi(relay.fetchFn);
    const store = createMemoryStore();
    const control = createMemoryControl();
    const boot = await bootstrapGhost({ vaultStore: store, control, api });
    if (boot.kind !== "ready") throw new Error("expected ready");
    const pair = { namespaceId: boot.vault.namespaceId, generation: boot.vault.generation };
    const envelope = await saveMemory(store, boot.vault, "to be forgotten", newProvenance());
    await api.uploadArtifact(boot.session.token, envelope);

    const outcome = await forgetVault({ vaultStore: store, control, api }, pair);
    await outcome.remote;

    // A late callback (usage receipt update, memory card render) carrying the old pair is discarded.
    expect(() => assertPairActive(null, pair)).toThrow();
    // The vault is empty; the control store holds only credentials/retry metadata, never memory text.
    expect(await countArtifacts(store)).toBe(0);
    const controlKeys = await control.keys();
    for (const key of controlKeys) {
      expect(key.startsWith("capability:") || key === "relay-session" || key === "forgetting" || key.startsWith("forgotten:")).toBe(true);
    }
    expect(JSON.stringify([...control.raw.values()])).not.toContain("to be forgotten");
  });
});
