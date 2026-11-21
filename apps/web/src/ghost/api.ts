/**
 * The browser's only talk to the server relay. The Mistral API key never exists here; the relay
 * session bearer token travels only in the `Authorization` header — never in a URL, body or log.
 */

import { env } from "../env";
import type { ArtifactEnvelope, OutboundMessage } from "./types";

const baseUrl = env.VITE_API_URL.replace(/\/+$/u, "");

export interface RelayConfig {
  configured: boolean;
  model: string;
  provider_origin: string;
  model_available: boolean | null;
}

export interface InferenceRequestBody {
  messages: OutboundMessage[];
  namespaceId: string;
  generation: number;
}

export interface InferenceResult {
  text: string;
  model: string;
  namespace_id: string;
  generation: number;
}

export interface RelaySession {
  sessionId: string;
  token: string;
}

export interface NamespaceRegistration {
  namespaceId: string;
  generation: number;
  state: string;
  created: boolean;
  /** Present only on first registration; the server stores just its hash. */
  deletionToken: string | null;
}

export type UploadStatus = "stored" | "exists";

export interface ErasureResult {
  namespace_id: string;
  status: string;
  artifacts_removed: number;
  /** Live remaining-artifact COUNT(*) for the namespace, queried at response time. */
  artifacts_remaining: number;
  idempotency_key: string;
  requested_at: string;
  completed_at: string;
  namespace_state: string;
  revoked_at: string | null;
}

/** Read-only owner-scoped namespace status: lifecycle metadata + real artifact count + observation time. */
export interface NamespaceStatus {
  namespaceId: string;
  generation: number;
  state: string;
  artifactCount: number;
  observedAt: string;
}

export interface RemoteApi {
  createSession(signal?: AbortSignal): Promise<RelaySession>;
  getConfig(token: string, signal?: AbortSignal): Promise<RelayConfig>;
  postInference(token: string, body: InferenceRequestBody, signal?: AbortSignal): Promise<InferenceResult>;
  registerNamespace(token: string, namespaceId: string, generation: number, signal?: AbortSignal): Promise<NamespaceRegistration>;
  uploadArtifact(token: string, envelope: ArtifactEnvelope, signal?: AbortSignal): Promise<UploadStatus>;
  listArtifacts(token: string, namespaceId: string, signal?: AbortSignal): Promise<ArtifactEnvelope[]>;
  fetchArtifact(token: string, namespaceId: string, artifactId: string, signal?: AbortSignal): Promise<ArtifactEnvelope>;
  eraseNamespace(deletionToken: string, namespaceId: string, idempotencyKey: string, signal?: AbortSignal): Promise<ErasureResult>;
  getErasure(deletionToken: string, namespaceId: string, signal?: AbortSignal): Promise<ErasureResult>;
  getNamespaceStatus(token: string, namespaceId: string, signal?: AbortSignal): Promise<NamespaceStatus>;
}

async function readError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { detail?: string };
    return new Error(body.detail ?? `Relay answered HTTP ${response.status}`);
  } catch {
    return new Error(`Relay answered HTTP ${response.status}`);
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Build the API client. `fetchFn` is injectable so tests can run the whole client against an
 * in-memory fake relay.
 */
export function createRemoteApi(fetchFn: typeof fetch = fetch): RemoteApi {
  async function call<T>(path: string, init: RequestInit, token: string | null): Promise<T> {
    const response = await fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(token === null ? {} : bearer(token)),
      },
    });
    if (!response.ok) {
      throw await readError(response);
    }
    return (await response.json()) as T;
  }

  return {
    /** POST /api/v1/sessions — the only anonymous endpoint; the token is returned exactly once. */
    createSession: (signal) =>
      call<RelaySession>("/api/v1/sessions", { method: "POST", signal }, null),

    /** GET /api/v1/config — relay configuration and model availability, without any credential. */
    getConfig: (token, signal) => call<RelayConfig>("/api/v1/config", { method: "GET", signal }, token),

    /** POST /api/v1/inference — send exactly the approved messages snapshot (wire: snake_case). */
    postInference: (token, body, signal) =>
      call<InferenceResult>(
        "/api/v1/inference",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: body.messages,
            namespace_id: body.namespaceId,
            generation: body.generation,
          }),
          signal,
        },
        token
      ),

    /** POST /api/v1/namespaces — bind this vault's (namespaceId, generation) to the session. */
    registerNamespace: (token, namespaceId, generation, signal) =>
      call<{
        namespace_id: string;
        generation: number;
        state: string;
        created: boolean;
        deletion_token: string | null;
      }>(
        "/api/v1/namespaces",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ namespace_id: namespaceId, generation }),
          signal,
        },
        token
      ).then((wire) => ({
        namespaceId: wire.namespace_id,
        generation: wire.generation,
        state: wire.state,
        created: wire.created,
        deletionToken: wire.deletion_token,
      })),

    /** POST /api/v1/namespaces/{id}/artifacts — upload one encrypted envelope (idempotent). */
    uploadArtifact: (token, envelope, signal) =>
      call<{ artifact_id: string; status: UploadStatus }>(
        `/api/v1/namespaces/${encodeURIComponent(envelope.namespaceId)}/artifacts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            namespace_id: envelope.namespaceId,
            generation: envelope.generation,
            artifact_id: envelope.artifactId,
            schema_version: envelope.schemaVersion,
            iv: envelope.iv,
            ciphertext: envelope.ciphertext,
          }),
          signal,
        },
        token
      ).then((result) => result.status),

    /** GET /api/v1/namespaces/{id}/artifacts — list the namespace's encrypted envelopes. */
    listArtifacts: (token, namespaceId, signal) =>
      call<{ artifacts: unknown[] }>(
        `/api/v1/namespaces/${encodeURIComponent(namespaceId)}/artifacts`,
        { method: "GET", signal },
        token
      ).then((result) => result.artifacts.map(fromWireEnvelope)),

    /** GET /api/v1/namespaces/{id}/artifacts/{artifactId} — fetch one encrypted envelope. */
    fetchArtifact: (token, namespaceId, artifactId, signal) =>
      call<unknown>(
        `/api/v1/namespaces/${encodeURIComponent(namespaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { method: "GET", signal },
        token
      ).then(fromWireEnvelope),

    /** POST /api/v1/namespaces/{id}/erase — deletion capability only; idempotent. */
    eraseNamespace: (deletionToken, namespaceId, idempotencyKey, signal) =>
      call<ErasureResult>(
        `/api/v1/namespaces/${encodeURIComponent(namespaceId)}/erase`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotency_key: idempotencyKey }),
          signal,
        },
        deletionToken
      ),

    /** GET /api/v1/namespaces/{id}/erasure — retrieve the recorded erasure result. */
    getErasure: (deletionToken, namespaceId, signal) =>
      call<ErasureResult>(`/api/v1/namespaces/${encodeURIComponent(namespaceId)}/erasure`, { method: "GET", signal }, deletionToken),

    /** GET /api/v1/namespaces/{id}/status — owner-scoped lifecycle + real artifact count. */
    getNamespaceStatus: (token, namespaceId, signal) =>
      call<{
        namespace_id: string;
        generation: number;
        state: string;
        artifact_count: number;
        observed_at: string;
      }>(
        `/api/v1/namespaces/${encodeURIComponent(namespaceId)}/status`,
        { method: "GET", signal },
        token
      ).then((wire) => ({
        namespaceId: wire.namespace_id,
        generation: wire.generation,
        state: wire.state,
        artifactCount: wire.artifact_count,
        observedAt: wire.observed_at,
      })),
  };
}

/** The wire format uses snake_case; map it back to the browser's envelope shape unchanged. */
export function fromWireEnvelope(raw: unknown): ArtifactEnvelope {
  const value = raw as Record<string, unknown>;
  return {
    namespaceId: value.namespace_id as string,
    generation: value.generation as number,
    artifactId: value.artifact_id as string,
    schemaVersion: value.schema_version as number,
    iv: value.iv as string,
    ciphertext: value.ciphertext as string,
  };
}

export const remoteApi = createRemoteApi();
