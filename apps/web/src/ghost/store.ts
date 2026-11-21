/**
 * The narrow storage interface the vault logic runs against. The browser implementation is
 * IndexedDB (`idb.ts`); tests substitute an in-memory implementation with the same transaction
 * semantics, so the security-relevant logic is exercised without a browser.
 */

export type StoreName = "vault" | "keys" | "artifacts";

export const STORE_NAMES: readonly StoreName[] = ["vault", "keys", "artifacts"];

/** The fixed record keys inside the `vault` and `keys` stores. */
export const VAULT_META_KEY = "vault";
export const VAULT_KEY_KEY = "vault-key";

export interface VaultTx {
  get(store: StoreName, key: string): Promise<unknown>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  count(store: StoreName): Promise<number>;
  getAll(store: StoreName): Promise<unknown[]>;
}

export interface VaultStore {
  /**
   * Run `fn` inside one transaction over `stores`. Read-write transactions on overlapping
   * stores are serialized by the implementation, and the vault re-reads existing state inside
   * the transaction, so concurrent initialization cannot overwrite the winning key.
   */
  transact<T>(
    stores: readonly StoreName[],
    mode: "readonly" | "readwrite",
    fn: (tx: VaultTx) => Promise<T>
  ): Promise<T>;
}
