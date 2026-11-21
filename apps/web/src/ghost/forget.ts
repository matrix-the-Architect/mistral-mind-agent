/**
 * Forget Me orchestration and the vault lifecycle around it.
 *
 * Ordering guarantees:
 *
 * 1. The "forgetting" record (namespace reference, deletion capability, stable idempotency key) is
 *    persisted in the CONTROL database — outside the memory that will be deleted — BEFORE anything
 *    is removed, so a crash mid-forget still leaves retry information.
 * 2. The vault (CryptoKey record, all artifact envelopes, vault metadata) is wiped in ONE IndexedDB
 *    transaction whose completion is awaited before local removal is reported.
 * 3. Remote erasure is requested with the deletion capability but local forgetting does NOT wait
 *    for the network: offline forgetting still removes local access and leaves "pending" for retry.
 *
 * Guards: every async operation captures the immutable (namespaceId, generation) pair when it
 * starts and {@link assertPairActive} compares BOTH fields (a new namespace may also start at
 * generation 1) before any result is displayed, saved, or uploaded.
 */

import type { RemoteApi } from "./api";
import type { CapabilityRecord, ControlStore, ForgetRecord, RelaySessionRecord } from "./control";
import { FORGETTING_KEY, RELAY_SESSION_KEY, capabilityKey } from "./control";
import { VAULT_KEY_KEY, VAULT_META_KEY } from "./store";
import type { VaultStore } from "./store";
import { initVault, resetVaultSingleton } from "./vault";
import type { Vault, VaultInit } from "./vault";

/** The immutable pair captured when an operation starts. */
export interface VaultPair {
  namespaceId: string;
  generation: number;
}

/** Both fields must match: a brand-new namespace can also start at generation 1. */
export function samePair(a: VaultPair, b: VaultPair): boolean {
  return a.namespaceId === b.namespaceId && a.generation === b.generation;
}

/** Throws when the pair captured at dispatch is no longer the active one (e.g. after Forget Me). */
export function assertPairActive(active: VaultPair | null, captured: VaultPair): void {
  if (!active || !samePair(active, captured)) {
    throw new Error("The vault changed while this operation was running; its result was discarded.");
  }
}

export const FORGET_CHANNEL = "ghost-forget";
export interface ForgetBroadcast {
  type: "forgetting";
  namespaceId: string;
  generation: number;
  at: string;
}

export function broadcastForgetting(message: ForgetBroadcast): void {
  if (typeof BroadcastChannel === "undefined") return;
  new BroadcastChannel(FORGET_CHANNEL).postMessage(message);
}

// --- control-plane records ------------------------------------------------------

export async function loadRelaySession(control: ControlStore): Promise<RelaySessionRecord | undefined> {
  return control.get<RelaySessionRecord>(RELAY_SESSION_KEY);
}

/** Load the stored session or create (and persist) a new anonymous demo session. */
export async function getOrCreateRelaySession(control: ControlStore, api: RemoteApi): Promise<RelaySessionRecord> {
  const existing = await loadRelaySession(control);
  if (existing) return existing;
  const session = await api.createSession();
  const record: RelaySessionRecord = { sessionId: session.sessionId, token: session.token, createdAt: new Date().toISOString() };
  await control.put(RELAY_SESSION_KEY, record);
  return record;
}

export async function loadCapability(control: ControlStore, namespaceId: string): Promise<CapabilityRecord | undefined> {
  return control.get<CapabilityRecord>(capabilityKey(namespaceId));
}

export async function saveCapability(control: ControlStore, capability: CapabilityRecord): Promise<void> {
  await control.put(capabilityKey(capability.namespaceId), capability);
}

export async function loadForgetting(control: ControlStore): Promise<ForgetRecord | null> {
  return (await control.get<ForgetRecord>(FORGETTING_KEY)) ?? null;
}

export async function saveForgetting(control: ControlStore, record: ForgetRecord): Promise<void> {
  await control.put(FORGETTING_KEY, record);
}

/** Every retained forget record whose remote cleanup is not completed yet (active or archived). */
export async function pendingForgetRecords(control: ControlStore): Promise<ForgetRecord[]> {
  const keys = await control.keys();
  const records: ForgetRecord[] = [];
  for (const key of keys) {
    if (key === FORGETTING_KEY || key.startsWith("forgotten:")) {
      const record = await control.get<ForgetRecord>(key);
      if (record && record.remote !== "completed") records.push(record);
    }
  }
  return records;
}

// --- local wipe -------------------------------------------------------------------

export interface WipeResult {
  keyRemoved: boolean;
  metaRemoved: boolean;
  artifactsRemoved: number;
}

/**
 * Remove the persisted CryptoKey, every encrypted artifact and the vault metadata in ONE readwrite
 * transaction. Resolves only when the transaction has committed successfully.
 */
export async function wipeVaultStore(store: VaultStore): Promise<WipeResult> {
  return store.transact(["vault", "keys", "artifacts"], "readwrite", async (tx) => {
    // The narrow VaultTx has no key listing, so read the envelopes and delete by their own IDs.
    const envelopes = (await tx.getAll("artifacts")) as { artifactId?: string }[];
    for (const envelope of envelopes) {
      if (envelope.artifactId) await tx.delete("artifacts", envelope.artifactId);
    }
    const key = await tx.get("keys", VAULT_KEY_KEY);
    const meta = await tx.get("vault", VAULT_META_KEY);
    await tx.delete("keys", VAULT_KEY_KEY);
    await tx.delete("vault", VAULT_META_KEY);
    return {
      keyRemoved: key !== undefined,
      metaRemoved: meta !== undefined,
      artifactsRemoved: envelopes.length,
    };
  });
}

// --- remote erasure ---------------------------------------------------------------

export interface ForgetDeps {
  vaultStore: VaultStore;
  control: ControlStore;
  api: RemoteApi;
}

function touch(record: ForgetRecord): ForgetRecord {
  return { ...record, updatedAt: new Date().toISOString() };
}

/** One erasure attempt; updates and persists the record. Never throws — failures become "failed"/"pending". */
export async function attemptRemoteForgetting(deps: ForgetDeps, record: ForgetRecord): Promise<ForgetRecord> {
  const next: ForgetRecord = { ...touch(record), attempts: record.attempts + 1 };
  try {
    // Idempotent: a replay after a lost response returns the same completed result.
    const result = await deps.api.eraseNamespace(next.deletionToken, next.namespaceId, next.idempotencyKey);
    const done: ForgetRecord = {
      ...next,
      remote: "completed",
      state: "forgotten",
      artifactsRemoved: result.artifacts_removed,
      revokedAt: result.revoked_at,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    await saveForgetting(deps.control, done);
    return done;
  } catch (error) {
    const failed: ForgetRecord = {
      ...next,
      remote: "failed",
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    await saveForgetting(deps.control, failed);
    return failed;
  }
}

/** Retry remote cleanup for the active forgetting record (survives reload). */
export async function retryRemoteForgetting(deps: ForgetDeps): Promise<ForgetRecord | null> {
  const record = await loadForgetting(deps.control);
  if (!record || record.remote === "completed") return record;
  return attemptRemoteForgetting(deps, record);
}

/** Retry every retained forget record whose remote cleanup is unfinished (active or archived). */
export async function retryAllPendingForgetting(deps: ForgetDeps): Promise<ForgetRecord[]> {
  const pending = await pendingForgetRecords(deps.control);
  const results: ForgetRecord[] = [];
  for (const record of pending) {
    results.push(await attemptRemoteForgetting(deps, record));
  }
  return results;
}

// --- the Forget Me flow -------------------------------------------------------------

export interface ForgetOutcome {
  record: ForgetRecord;
  /** Resolves when the remote erasure attempt has been acknowledged (or failed); not awaited locally. */
  remote: Promise<ForgetRecord>;
}

/**
 * Forget the vault identified by `pair`: persist the forgetting record, wipe the local vault in one
 * awaited transaction, then request server erasure in the background. Local forgetting never waits
 * for the network response.
 */
export async function forgetVault(deps: ForgetDeps, pair: VaultPair): Promise<ForgetOutcome> {
  const capability = await loadCapability(deps.control, pair.namespaceId);
  if (!capability || !capability.deletionToken) {
    throw new Error("No deletion capability is recorded for this namespace; remote erasure cannot be requested.");
  }
  const now = new Date().toISOString();
  const record: ForgetRecord = {
    namespaceId: pair.namespaceId,
    generation: pair.generation,
    deletionToken: capability.deletionToken,
    idempotencyKey: capability.idempotencyKey,
    state: "forgetting",
    remote: "pending",
    localKeyRemoved: false,
    localRecordsRemoved: 0,
    artifactsRemoved: null,
    revokedAt: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  // 1. Persist the retry information BEFORE deleting anything.
  await saveForgetting(deps.control, record);
  // 2. Wipe the vault in one transaction; await its successful completion.
  const wipe = await wipeVaultStore(deps.vaultStore);
  const wiped: ForgetRecord = {
    ...touch(record),
    localKeyRemoved: wipe.keyRemoved,
    localRecordsRemoved: wipe.artifactsRemoved + (wipe.metaRemoved ? 1 : 0),
  };
  await saveForgetting(deps.control, wiped);
  // 3. Request remote erasure; local forgetting does not wait for it.
  const remote = attemptRemoteForgetting(deps, wiped);
  return { record: wiped, remote };
}

// --- startup bootstrap ----------------------------------------------------------------

export type BootstrapResult =
  | { kind: "ready"; vault: Vault; session: RelaySessionRecord; capability: CapabilityRecord; pair: VaultPair }
  | { kind: "forgotten"; record: ForgetRecord }
  | { kind: "key-unavailable" }
  | { kind: "error"; message: string };

/**
 * Startup: respect a persisted forgetting/forgotten state BEFORE initializing the vault — the old
 * vault is never silently reconstructed. Otherwise ensure a relay session, open (or create) the
 * vault, and register its namespace with the server, persisting the deletion capability.
 */
export async function bootstrapGhost(deps: ForgetDeps): Promise<BootstrapResult> {
  const forgetting = await loadForgetting(deps.control);
  if (forgetting) {
    return { kind: "forgotten", record: forgetting };
  }
  let session: RelaySessionRecord;
  try {
    session = await getOrCreateRelaySession(deps.control, deps.api);
  } catch (error) {
    return { kind: "error", message: `Could not create a relay session: ${error instanceof Error ? error.message : String(error)}` };
  }
  const init: VaultInit = await initVault(deps.vaultStore);
  if (init.status === "key-unavailable") return { kind: "key-unavailable" };
  if (init.status !== "ready") return { kind: "error", message: init.message };
  const vault = init.vault;
  const pair: VaultPair = { namespaceId: vault.namespaceId, generation: vault.generation };
  let capability = await loadCapability(deps.control, vault.namespaceId);
  if (!capability) {
    try {
      const registration = await deps.api.registerNamespace(session.token, pair.namespaceId, pair.generation);
      capability = {
        namespaceId: pair.namespaceId,
        generation: pair.generation,
        deletionToken: registration.deletionToken ?? "",
        idempotencyKey: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        kind: "error",
        message: `Namespace registration failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    await saveCapability(deps.control, capability);
  }
  return { kind: "ready", vault, session, capability, pair };
}

export interface NewSessionResult {
  bootstrap: BootstrapResult;
}

/**
 * "Start new session" after forgetting: archive the forget record (retained as disclosed control
 * metadata; pending remote cleanup stays retryable), clear the active marker, drop the vault
 * singleton, and bootstrap a brand-new namespace and key. Forgotten content is never re-encrypted
 * or migrated into the new session — the old vault records are already gone.
 */
export async function startNewSession(deps: ForgetDeps): Promise<NewSessionResult> {
  const record = await loadForgetting(deps.control);
  if (record) {
    await deps.control.put(`forgotten:${record.namespaceId}`, { ...record, state: "forgotten" });
    await deps.control.delete(FORGETTING_KEY);
  }
  resetVaultSingleton();
  const bootstrap = await bootstrapGhost(deps);
  return { bootstrap };
}
