/**
 * In-memory fake of the Ghost relay implementing the server contract (bearer sessions, ownership,
 * active-state checks, deletion capability, idempotent erasure). Shared by the milestone-2/3 web
 * tests; the Python suite tests the real FastAPI server. Also records raw request bodies so tests
 * can assert exactly what the client put on the wire.
 */

import type { ArtifactEnvelope } from "../ghost/types";

interface FakeNamespace {
  owner: string;
  generation: number;
  state: "active" | "revoked";
  deletionToken: string;
}

export function createFakeRelay() {
  const sessions = new Map<string, string>(); // token -> sessionId
  const deletionTokens = new Map<string, string>(); // deletion token -> namespaceId
  const namespaces = new Map<string, FakeNamespace>();
  const artifacts = new Map<string, Map<string, ArtifactEnvelope>>();
  const erasures = new Map<string, Record<string, unknown>>();
  let failErase = false;
  const requests: { method: string; path: string; body: unknown }[] = [];

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), "http://relay.test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const token = authHeader.replace(/^Bearer /i, "");
    const sessionId = sessions.get(token);
    const deletionNs = deletionTokens.get(token);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ method, path, body });

    if (path === "/api/v1/sessions" && method === "POST") {
      const sessionToken = `sess-${crypto.randomUUID()}`;
      const sessionTokenId = crypto.randomUUID();
      sessions.set(sessionToken, sessionTokenId);
      return json(200, { session_id: sessionTokenId, token: sessionToken });
    }
    if (path === "/api/v1/config" && method === "GET") {
      if (!sessionId) return json(401, { detail: "Missing credential" });
      return json(200, { configured: true, model: "test-model", provider_origin: "https://provider.test", model_available: true });
    }
    if (path === "/api/v1/inference" && method === "POST") {
      if (!sessionId) return json(401, { detail: "Missing credential" });
      const ns = namespaces.get(body.namespace_id);
      if (!ns || ns.owner !== sessionId) return json(403, { detail: "not owned" });
      if (ns.state !== "active") return json(409, { detail: "revoked" });
      if (ns.generation !== body.generation) return json(409, { detail: "generation mismatch" });
      return json(200, { text: "fake answer", model: "test-model", namespace_id: body.namespace_id, generation: body.generation });
    }
    if (path === "/api/v1/namespaces" && method === "POST") {
      if (!sessionId) return json(401, { detail: "Missing credential" });
      const existing = namespaces.get(body.namespace_id);
      if (existing) {
        if (existing.state === "revoked") return json(409, { detail: "revoked; cannot reactivate" });
        if (existing.owner !== sessionId) return json(409, { detail: "claimed by another session" });
        return json(200, { namespace_id: body.namespace_id, generation: existing.generation, state: existing.state, created: false, deletion_token: null });
      }
      const deletionToken = `del-${crypto.randomUUID()}`;
      namespaces.set(body.namespace_id, { owner: sessionId, generation: body.generation, state: "active", deletionToken });
      deletionTokens.set(deletionToken, body.namespace_id);
      artifacts.set(body.namespace_id, new Map());
      return json(201, { namespace_id: body.namespace_id, generation: body.generation, state: "active", created: true, deletion_token: deletionToken });
    }

    const artifactsMatch = path.match(/^\/api\/v1\/namespaces\/([^/]+)\/artifacts(?:\/([^/]+))?$/u);
    if (artifactsMatch) {
      const nsId = artifactsMatch[1] as string;
      const artifactId = artifactsMatch[2] as string | undefined;
      if (!sessionId) return json(401, { detail: "Missing credential" });
      const ns = namespaces.get(nsId);
      if (!ns || ns.owner !== sessionId) return json(ns ? 403 : 404, { detail: "forbidden or unknown" });
      if (method === "POST") {
        if (ns.state !== "active") return json(409, { detail: "revoked" });
        if (body.generation !== ns.generation) return json(409, { detail: "generation mismatch" });
        const bucket = artifacts.get(nsId)!;
        const existing = bucket.get(body.artifact_id);
        if (existing) {
          if (existing.ciphertext === body.ciphertext && existing.iv === body.iv) {
            return json(200, { artifact_id: body.artifact_id, status: "exists" });
          }
          return json(409, { detail: "conflicting ciphertext for this ID" });
        }
        const envelope: ArtifactEnvelope = {
          namespaceId: body.namespace_id,
          generation: body.generation,
          artifactId: body.artifact_id,
          schemaVersion: body.schema_version,
          iv: body.iv,
          ciphertext: body.ciphertext,
        };
        bucket.set(envelope.artifactId, envelope);
        return json(201, { artifact_id: envelope.artifactId, status: "stored" });
      }
      if (ns.state !== "active") return json(409, { detail: "revoked" });
      const bucket = artifacts.get(nsId)!;
      if (artifactId) {
        const found = bucket.get(artifactId);
        return found ? json(200, wire(found)) : json(404, { detail: "no such artifact" });
      }
      return json(200, { namespace_id: nsId, state: ns.state, artifacts: [...bucket.values()].map(wire) });
    }

    const statusMatch = path.match(/^\/api\/v1\/namespaces\/([^/]+)\/status$/u);
    if (statusMatch) {
      const nsId = statusMatch[1] as string;
      if (!sessionId) return json(401, { detail: "Missing credential" });
      const ns = namespaces.get(nsId);
      if (!ns || ns.owner !== sessionId) return json(404, { detail: "No such namespace for this session." });
      return json(200, {
        namespace_id: nsId,
        generation: ns.generation,
        state: ns.state,
        artifact_count: artifacts.get(nsId)?.size ?? 0,
        observed_at: new Date().toISOString(),
      });
    }

    const eraseMatch = path.match(/^\/api\/v1\/namespaces\/([^/]+)\/(erase|erasure)$/u);
    if (eraseMatch) {
      const nsId = eraseMatch[1] as string;
      const op = eraseMatch[2] as string;
      if (deletionNs !== nsId) return json(deletionNs ? 403 : 401, { detail: "deletion capability required" });
      if (failErase) return json(503, { detail: "offline" });
      const ns = namespaces.get(nsId)!;
      if (op === "erase") {
        const existing = erasures.get(nsId);
        if (ns.state === "revoked" && existing) return json(200, existing);
        ns.state = "revoked";
        const removed = artifacts.get(nsId)?.size ?? 0;
        artifacts.set(nsId, new Map());
        const result = {
          namespace_id: nsId,
          status: "completed",
          artifacts_removed: removed,
          artifacts_remaining: 0,
          idempotency_key: body.idempotency_key,
          requested_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          namespace_state: "revoked",
          revoked_at: new Date().toISOString(),
        };
        erasures.set(nsId, result);
        return json(200, result);
      }
      const existing = erasures.get(nsId);
      if (!existing) return json(404, { detail: "no erasure recorded" });
      return json(200, { ...existing, artifacts_remaining: artifacts.get(nsId)?.size ?? 0 });
    }

    return json(404, { detail: `no route ${method} ${path}` });
  }

  function wire(envelope: ArtifactEnvelope) {
    return {
      namespace_id: envelope.namespaceId,
      generation: envelope.generation,
      artifact_id: envelope.artifactId,
      schema_version: envelope.schemaVersion,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
    };
  }

  return {
    requests,
    fetchFn: fetchFn as typeof fetch,
    setFailErase(value: boolean) {
      failErase = value;
    },
    namespaces,
    artifacts,
  };
}

