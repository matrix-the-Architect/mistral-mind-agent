/** Shared shapes for Ghost's browser-encrypted local memory. */

/** Envelope schema version. Bump on any change to what is encrypted or how the AAD is built. */
export const SCHEMA_VERSION = 1;

/** Vault metadata record, stored (in the clear) under one fixed key in the `vault` store. */
export interface VaultMeta {
  namespaceId: string;
  generation: number;
  schemaVersion: number;
  createdAt: string;
}

/**
 * A stored encrypted artifact. This envelope is the ONLY thing persisted per memory: no
 * plaintext, no provenance in the clear. `iv` and `ciphertext` are base64.
 */
export interface ArtifactEnvelope {
  namespaceId: string;
  generation: number;
  artifactId: string;
  schemaVersion: number;
  iv: string;
  ciphertext: string;
}

/** Provenance, encrypted together with the memory text. */
export interface MemoryProvenance {
  /** Where the memory came from, e.g. `mistral-answer (model)` or `manual`. */
  source: string;
  createdAt: string;
  purpose: string;
  /**
   * Milestone 3 structured creation provenance — optional so ciphertext saved before this
   * milestone still decrypts unchanged (no migration, no header rewrite). Absent there.
   */
  sourceKind?: "user-entered" | "saved-from-analysis";
  /**
   * Application-generated Ghost analysis ID of the Analyze run that proposed this memory —
   * NOT a Mistral-issued request ID. Only present for `saved-from-analysis`.
   */
  sourceAnalysisId?: string;
  /** Whether the user changed the proposed memory text before saving (no proposal ⇒ false). */
  editedBeforeSave?: boolean;
}

/** The plaintext that gets encrypted: the memory plus its detailed provenance. */
export interface MemoryPayload {
  text: string;
  provenance: MemoryProvenance;
}

/** An artifact after decryption, held only in transient application state. */
export interface DecryptedMemory {
  artifactId: string;
  namespaceId: string;
  generation: number;
  payload: MemoryPayload;
}

/** One message of the outbound snapshot sent to the relay for approval. */
export interface OutboundMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
