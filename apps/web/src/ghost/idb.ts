/**
 * The IndexedDB-backed {@link VaultStore}. One database, three object stores:
 *
 * - `vault`     — vault metadata (namespace ID, generation, schema version)
 * - `keys`      — the non-extractable AES-GCM CryptoKey, persisted by structured cloning
 * - `artifacts` — encrypted memory envelopes, keyed by artifact ID
 *
 * Nothing but ciphertext and the opaque CryptoKey is ever written here. Web Crypto calls are
 * deliberately kept outside transactions (a transaction commits once the event loop turns with
 * no pending IDB request), so the vault logic reads and writes in short transactions and does
 * its encrypt/decrypt between them.
 */

import { STORE_NAMES } from "./store";
import type { StoreName, VaultStore, VaultTx } from "./store";

const DB_NAME = "ghost-vault";
const DB_VERSION = 1;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
  });
}

/** Open the vault database and wrap it in the {@link VaultStore} interface. */
export async function openVaultStore(): Promise<VaultStore> {
  const db = await openDatabase();
  return {
    transact(stores, mode, fn) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores as string[], mode);
        const api: VaultTx = {
          get: (store: StoreName, key: string) => requestToPromise(tx.objectStore(store).get(key)),
          put: async (store: StoreName, key: string, value: unknown) => {
            await requestToPromise(tx.objectStore(store).put(value, key));
          },
          delete: async (store: StoreName, key: string) => {
            await requestToPromise(tx.objectStore(store).delete(key));
          },
          count: (store: StoreName) => requestToPromise(tx.objectStore(store).count()),
          getAll: (store: StoreName) => requestToPromise(tx.objectStore(store).getAll()),
        };
        let settled = false;
        const settle = (callback: () => void) => {
          if (!settled) {
            settled = true;
            callback();
          }
        };
        // If the transaction commits before `fn` has finished (it must only await IDB
        // requests), that is a bug in the caller, not a silent success.
        tx.oncomplete = () =>
          settle(() => reject(new Error("IndexedDB transaction committed before the callback finished")));
        tx.onerror = () => settle(() => reject(tx.error ?? new Error("IndexedDB transaction failed")));
        tx.onabort = () => settle(() => reject(tx.error ?? new Error("IndexedDB transaction aborted")));
        Promise.resolve()
          .then(() => fn(api))
          .then(
            (value) => {
              // `fn` finished while the transaction was still alive: resolve with its value
              // once the transaction commits.
              tx.oncomplete = () => settle(() => resolve(value));
            },
            (error) => {
              try {
                tx.abort();
              } catch {
                // Already finished; report the original error either way.
              }
              settle(() => reject(error));
            }
          );
      });
    },
  };
}
