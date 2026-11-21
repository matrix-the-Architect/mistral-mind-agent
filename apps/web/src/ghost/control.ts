/**
 * Ghost's control plane: a SEPARATE IndexedDB database (`ghost-control`) holding the relay session
 * credential, the per-namespace deletion capability, and the Forget Me record. It is deliberately
 * outside the `ghost-vault` database, so wiping the vault (key + artifacts + metadata) can never
 * remove the minimum information needed to retry a remote erasure.
 *
 * Nothing here is memory content: no plaintext, no keys, no ciphertext. The deletion token is a
 * bearer credential — kept out of URLs and logs, stored only here, hashed server-side.
 */

export const CONTROL_DB_NAME = "ghost-control";
export const CONTROL_DB_VERSION = 1;
export const CONTROL_STORE = "control";

export const RELAY_SESSION_KEY = "relay-session";
export const FORGETTING_KEY = "forgetting";
export function capabilityKey(namespaceId: string): string {
  return `capability:${namespaceId}`;
}

/** The anonymous demo session credential for the relay. */
export interface RelaySessionRecord {
  sessionId: string;
  token: string;
  createdAt: string;
}

/** The deletion capability issued once at namespace registration, plus its stable idempotency key. */
export interface CapabilityRecord {
  namespaceId: string;
  generation: number;
  deletionToken: string;
  idempotencyKey: string;
  createdAt: string;
}

export type ForgetRemoteState = "pending" | "completed" | "failed";

/**
 * The persisted "forgetting" state: everything needed to retry remote erasure after reload, kept
 * outside the memory that is being deleted. Contains no memory content and no encryption key.
 */
export interface ForgetRecord {
  namespaceId: string;
  generation: number;
  deletionToken: string;
  idempotencyKey: string;
  state: "forgetting" | "forgotten";
  remote: ForgetRemoteState;
  localKeyRemoved: boolean;
  localRecordsRemoved: number;
  artifactsRemoved: number | null;
  revokedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The narrow control-plane storage interface (IndexedDB in the browser, in-memory in tests). */
export interface ControlStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(CONTROL_STORE, mode);
    const request = fn(tx.objectStore(CONTROL_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Open the control-plane store. */
export async function openControlStore(): Promise<ControlStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(CONTROL_DB_NAME, CONTROL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CONTROL_STORE)) {
        database.createObjectStore(CONTROL_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return {
    get: <T>(key: string) => run<T | undefined>(db, "readonly", (store) => store.get(key) as IDBRequest<T | undefined>),
    put: async (key, value) => {
      await run<IDBValidKey>(db, "readwrite", (store) => store.put(value, key));
    },
    delete: async (key) => {
      await run<undefined>(db, "readwrite", (store) => store.delete(key));
    },
    keys: () => run<string[]>(db, "readonly", (store) => store.getAllKeys() as IDBRequest<string[]>),
  };
}
