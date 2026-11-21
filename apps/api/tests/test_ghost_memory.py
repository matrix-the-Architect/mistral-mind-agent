"""Ghost milestone 2: authenticated remote ciphertext storage and the Forget Me erasure flow.

Run against a scratch database (see conftest): SQLite by default; with ``RUN_PG_CONTRACT=1`` a
throwaway real PostgreSQL via pgserver, which additionally exercises ``SELECT ... FOR UPDATE``
row locking, including the concurrent write-vs-erasure race.

The provider is a mock transport where inference is involved; the storage/erasure contract tests
never call the provider at all. Envelopes here are syntactically valid (12-byte base64 IV, base64
ciphertext); the browser-side tests prove real AES-GCM round trips through this same API shape.
"""

import base64
import os
import secrets
import uuid
from collections.abc import Iterator

import httpx
import pytest
from api.routers.api.v1 import route as relay
from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from env.mistral import env as mistral_env
from fastapi.testclient import TestClient
from sqlalchemy import select

from conftest import build_app

MODEL = "test-model-1"
ORIGIN = "https://provider.test"

PG_ONLY = pytest.mark.skipif(not os.getenv("RUN_PG_CONTRACT"), reason="needs a live PostgreSQL (RUN_PG_CONTRACT=1)")


@pytest.fixture(autouse=True)
def relay_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(mistral_env, "mistral_api_key", "test-key")
    monkeypatch.setattr(mistral_env, "mistral_base_url", ORIGIN)
    monkeypatch.setattr(mistral_env, "mistral_model", MODEL)
    relay._model_availability.clear()
    yield
    relay._model_availability.clear()


@pytest.fixture
def client(db: str) -> TestClient:
    return TestClient(build_app())


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def create_session(client: TestClient) -> str:
    res = client.post("/api/v1/sessions")
    assert res.status_code == 200, res.text
    return res.json()["token"]


def register(client: TestClient, token: str, namespace_id: str, generation: int = 1) -> httpx.Response:
    return client.post(
        "/api/v1/namespaces",
        json={"namespace_id": namespace_id, "generation": generation},
        headers=auth(token),
    )


def make_envelope(
    namespace_id: str,
    *,
    generation: int = 1,
    artifact_id: str | None = None,
    schema_version: int = 1,
    iv: str | None = None,
    ciphertext: str | None = None,
) -> dict:
    return {
        "namespace_id": namespace_id,
        "generation": generation,
        "artifact_id": artifact_id or str(uuid.uuid4()),
        "schema_version": schema_version,
        "iv": iv or base64.b64encode(secrets.token_bytes(12)).decode(),
        "ciphertext": ciphertext or base64.b64encode(secrets.token_bytes(64)).decode(),
    }


def upload(client: TestClient, token: str, namespace_id: str, envelope: dict) -> httpx.Response:
    return client.post(
        f"/api/v1/namespaces/{namespace_id}/artifacts", json=envelope, headers=auth(token)
    )


def erase(client: TestClient, token: str, namespace_id: str, idempotency_key: str) -> httpx.Response:
    return client.post(
        f"/api/v1/namespaces/{namespace_id}/erase",
        json={"idempotency_key": idempotency_key},
        headers=auth(token),
    )


def install_mock_provider(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": MODEL}]})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "answer"}}]})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(relay, "_models_client_factory", lambda: httpx.AsyncClient(transport=transport))
    monkeypatch.setattr(relay, "_completion_client_factory", lambda: httpx.AsyncClient(transport=transport))
    return seen


def inference_body(namespace_id: str, generation: int = 1) -> dict:
    return {
        "messages": [{"role": "user", "content": "hello"}],
        "namespace_id": namespace_id,
        "generation": generation,
    }


async def artifact_count() -> int:
    async with get_session_maker()() as session:
        rows = (await session.execute(select(ghost_db.GhostArtifact))).scalars().all()
    return len(rows)


# --- sessions and the access rule -------------------------------------------------


def test_session_bootstrap_returns_the_token_once_and_stores_only_its_hash(client: TestClient, db: str) -> None:
    res = client.post("/api/v1/sessions")
    assert res.status_code == 200
    data = res.json()
    token = data["token"]
    assert data["session_id"] and token and token not in data["session_id"]
    assert client.post("/api/v1/sessions").json()["token"] != token

    import asyncio

    async def stored_hash() -> str | None:
        async with get_session_maker()() as session:
            row = await ghost_db.get_session_by_token_hash(session, ghost_db.hash_token(token))
        return row.token_hash if row else None

    assert asyncio.run(stored_hash()) == ghost_db.hash_token(token)
    assert token != ghost_db.hash_token(token)


def test_every_v1_route_requires_a_valid_credential(client: TestClient, db: str) -> None:
    token = create_session(client)
    ns = str(uuid.uuid4())
    register(client, token, ns)
    envelope = make_envelope(ns)
    calls = [
        ("GET", "/api/v1/config", {}),
        ("POST", "/api/v1/inference", {"json": inference_body(ns)}),
        ("POST", "/api/v1/namespaces", {"json": {"namespace_id": str(uuid.uuid4()), "generation": 1}}),
        ("POST", f"/api/v1/namespaces/{ns}/artifacts", {"json": envelope}),
        ("GET", f"/api/v1/namespaces/{ns}/artifacts", {}),
        ("GET", f"/api/v1/namespaces/{ns}/artifacts/{envelope['artifact_id']}", {}),
        ("POST", f"/api/v1/namespaces/{ns}/erase", {"json": {"idempotency_key": str(uuid.uuid4())}}),
        ("GET", f"/api/v1/namespaces/{ns}/erasure", {}),
    ]
    for method, url, kwargs in calls:
        res = client.request(method, url, **kwargs)
        assert res.status_code == 401, (method, url, res.status_code)
        res = client.request(method, url, headers=auth("not-a-real-token"), **kwargs)
        assert res.status_code == 401, (method, url, res.status_code)
    # The bootstrap itself is the only anonymous v1 endpoint.
    assert client.post("/api/v1/sessions").status_code == 200


# --- registration and ownership ----------------------------------------------------


def test_registration_claims_and_conflicts_and_never_reactivates(client: TestClient, db: str) -> None:
    token_a = create_session(client)
    token_b = create_session(client)
    ns = str(uuid.uuid4())

    first = register(client, token_a, ns)
    assert first.status_code == 201, first.text
    body = first.json()
    assert body["state"] == "active" and body["created"] is True
    deletion_token = body["deletion_token"]
    assert deletion_token and deletion_token != ghost_db.hash_token(deletion_token)

    again = register(client, token_a, ns)
    assert again.status_code == 200 and again.json()["created"] is False
    assert again.json()["deletion_token"] is None, "the capability is issued exactly once"

    conflict = register(client, token_b, ns)
    assert conflict.status_code == 409

    # A revoked namespace cannot be reactivated through registration.
    assert erase(client, deletion_token, ns, str(uuid.uuid4())).status_code == 200
    reactivated = register(client, token_a, ns)
    assert reactivated.status_code == 409
    assert "revoked" in reactivated.json()["detail"]


def test_namespace_id_alone_is_not_authorization(client: TestClient, db: str) -> None:
    token_a = create_session(client)
    token_b = create_session(client)
    ns_a = str(uuid.uuid4())
    register(client, token_a, ns_a)
    envelope = make_envelope(ns_a)
    upload(client, token_a, ns_a, envelope)

    # B knows A's namespace UUID but has no claim on it: read, write and erase are all refused.
    assert upload(client, token_b, ns_a, make_envelope(ns_a)).status_code == 403
    assert client.get(f"/api/v1/namespaces/{ns_a}/artifacts", headers=auth(token_b)).status_code == 403
    assert (
        client.get(f"/api/v1/namespaces/{ns_a}/artifacts/{envelope['artifact_id']}", headers=auth(token_b)).status_code == 403
    )
    assert client.post("/api/v1/inference", json=inference_body(ns_a), headers=auth(token_b)).status_code == 403
    assert erase(client, token_b, ns_a, str(uuid.uuid4())).status_code == 403
    # Unknown namespace: 404 even for a valid session.
    assert client.get(f"/api/v1/namespaces/{uuid.uuid4()}/artifacts", headers=auth(token_b)).status_code == 404


# --- artifact storage ---------------------------------------------------------------


def test_artifact_round_trip_and_idempotent_replay(client: TestClient, db: str) -> None:
    token = create_session(client)
    ns = str(uuid.uuid4())
    register(client, token, ns)
    envelope = make_envelope(ns)

    res = upload(client, token, ns, envelope)
    assert res.status_code == 201, res.text
    assert res.json() == {"artifact_id": envelope["artifact_id"], "status": "stored"}

    replay = upload(client, token, ns, envelope)
    assert replay.status_code == 200 and replay.json()["status"] == "exists"

    different = {**envelope, "ciphertext": base64.b64encode(secrets.token_bytes(64)).decode()}
    conflict = upload(client, token, ns, different)
    assert conflict.status_code == 409

    listed = client.get(f"/api/v1/namespaces/{ns}/artifacts", headers=auth(token))
    assert listed.status_code == 200
    artifacts = listed.json()["artifacts"]
    assert len(artifacts) == 1
    assert artifacts[0] == envelope, "the stored envelope is byte-identical to the uploaded one"
    # The server persists only the envelope fields — never plaintext provenance or memory text.
    assert set(artifacts[0].keys()) == {
        "namespace_id", "generation", "artifact_id", "schema_version", "iv", "ciphertext",
    }

    fetched = client.get(f"/api/v1/namespaces/{ns}/artifacts/{envelope['artifact_id']}", headers=auth(token))
    assert fetched.status_code == 200 and fetched.json() == envelope
    assert client.get(f"/api/v1/namespaces/{ns}/artifacts/{uuid.uuid4()}", headers=auth(token)).status_code == 404


def test_envelope_validation(client: TestClient, db: str) -> None:
    token = create_session(client)
    ns = str(uuid.uuid4())
    register(client, token, ns)

    bad_iv = upload(client, token, ns, make_envelope(ns, iv=base64.b64encode(b"short").decode()))
    assert bad_iv.status_code == 422
    bad_schema = upload(client, token, ns, make_envelope(ns, schema_version=2))
    assert bad_schema.status_code == 422
    extra = upload(client, token, ns, {**make_envelope(ns), "provider_url": "https://evil.example"})
    assert extra.status_code == 422
    mismatch = upload(client, token, ns, make_envelope(str(uuid.uuid4())))
    assert mismatch.status_code == 422, "the envelope's namespace must match the URL"
    bad_generation = upload(client, token, ns, make_envelope(ns, generation=2))
    assert bad_generation.status_code == 409
    huge = upload(client, token, ns, make_envelope(ns, ciphertext=base64.b64encode(secrets.token_bytes(300 * 1024)).decode()))
    assert huge.status_code == 422
    not_b64 = upload(client, token, ns, make_envelope(ns, iv="!!!not-base64!!!"))
    assert not_b64.status_code == 422


# --- erasure ------------------------------------------------------------------------


def test_erasure_revokes_removes_and_replays_after_a_lost_response(client: TestClient, db: str) -> None:
    token = create_session(client)
    ns = str(uuid.uuid4())
    deletion_token = register(client, token, ns).json()["deletion_token"]
    first = make_envelope(ns)
    second = make_envelope(ns)
    upload(client, token, ns, first)
    upload(client, token, ns, second)
    key = str(uuid.uuid4())

    res = erase(client, deletion_token, ns, key)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "completed"
    assert body["artifacts_removed"] == 2
    assert body["namespace_state"] == "revoked"
    assert body["revoked_at"] is not None

    # The write committed before the erasure was included in the deletion.
    import asyncio

    assert asyncio.run(artifact_count()) == 0

    # Losing the first HTTP response changes nothing: the replay returns the same result.
    replay = erase(client, deletion_token, ns, str(uuid.uuid4()))
    assert replay.status_code == 200
    assert replay.json()["status"] == "completed" and replay.json()["artifacts_removed"] == 2

    # The erasure result is retrievable with the deletion capability alone.
    result = client.get(f"/api/v1/namespaces/{ns}/erasure", headers=auth(deletion_token))
    assert result.status_code == 200 and result.json()["status"] == "completed"

    # Ordinary access is gone: reads, writes and inference are all refused.
    assert client.get(f"/api/v1/namespaces/{ns}/artifacts", headers=auth(token)).status_code == 409
    assert upload(client, token, ns, make_envelope(ns)).status_code == 409
    assert client.post("/api/v1/inference", json=inference_body(ns), headers=auth(token)).status_code == 409


def test_deletion_capability_is_narrowly_scoped(client: TestClient, db: str) -> None:
    token = create_session(client)
    ns = str(uuid.uuid4())
    deletion_token = register(client, token, ns).json()["deletion_token"]
    envelope = make_envelope(ns)
    upload(client, token, ns, envelope)

    # It cannot read memory or call inference…
    assert client.get(f"/api/v1/namespaces/{ns}/artifacts", headers=auth(deletion_token)).status_code == 403
    assert upload(client, token, ns, envelope).status_code == 200  # sanity: session write still fine
    assert upload(client, deletion_token, ns, make_envelope(ns)).status_code == 403
    assert client.post("/api/v1/inference", json=inference_body(ns), headers=auth(deletion_token)).status_code == 403
    assert client.get("/api/v1/config", headers=auth(deletion_token)).status_code == 403
    # …a session token cannot erase…
    assert erase(client, token, ns, str(uuid.uuid4())).status_code == 403
    assert client.get(f"/api/v1/namespaces/{ns}/erasure", headers=auth(token)).status_code == 403
    # …but the capability can erase its own namespace and retrieve the result.
    assert erase(client, deletion_token, ns, str(uuid.uuid4())).status_code == 200
    assert client.get(f"/api/v1/namespaces/{ns}/erasure", headers=auth(deletion_token)).status_code == 200
    # And it cannot touch another namespace.
    other_ns = str(uuid.uuid4())
    register(client, token, other_ns)
    assert erase(client, deletion_token, other_ns, str(uuid.uuid4())).status_code == 403


def test_two_sessions_are_isolated_and_forgetting_one_leaves_the_other_intact(client: TestClient, db: str) -> None:
    token_a = create_session(client)
    token_b = create_session(client)
    ns_a, ns_b = str(uuid.uuid4()), str(uuid.uuid4())
    deletion_a = register(client, token_a, ns_a).json()["deletion_token"]
    register(client, token_b, ns_b)
    env_a = make_envelope(ns_a)
    env_b = make_envelope(ns_b)
    upload(client, token_a, ns_a, env_a)
    upload(client, token_b, ns_b, env_b)

    assert erase(client, deletion_a, ns_a, str(uuid.uuid4())).status_code == 200

    listed_b = client.get(f"/api/v1/namespaces/{ns_b}/artifacts", headers=auth(token_b))
    assert listed_b.status_code == 200 and listed_b.json()["artifacts"] == [env_b]
    assert client.get(f"/api/v1/namespaces/{ns_b}/artifacts/{env_b['artifact_id']}", headers=auth(token_b)).status_code == 200
    # A's artifacts are gone from the database, not merely hidden from the API.
    import asyncio

    async def a_rows() -> int:
        async with get_session_maker()() as session:
            rows = (
                await session.execute(select(ghost_db.GhostArtifact).where(ghost_db.GhostArtifact.namespace_id == ns_a))
            ).scalars().all()
        return len(rows)

    assert asyncio.run(a_rows()) == 0


def test_delayed_inference_response_is_refused_after_revocation_and_never_reaches_the_provider(
    client: TestClient, db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = install_mock_provider(monkeypatch)
    token = create_session(client)
    ns = str(uuid.uuid4())
    deletion_token = register(client, token, ns).json()["deletion_token"]

    res = client.post("/api/v1/inference", json=inference_body(ns), headers=auth(token))
    assert res.status_code == 200 and res.json()["text"] == "answer"
    assert any(r.url.path == "/v1/chat/completions" for r in seen)

    assert erase(client, deletion_token, ns, str(uuid.uuid4())).status_code == 200
    seen.clear()
    late = client.post("/api/v1/inference", json=inference_body(ns), headers=auth(token))
    assert late.status_code == 409
    assert not seen, "no provider call may happen for a revoked namespace"

    unregistered = client.post("/api/v1/inference", json=inference_body(str(uuid.uuid4())), headers=auth(token))
    assert unregistered.status_code == 403


@PG_ONLY
def test_concurrent_write_racing_an_erasure_is_rejected_or_included(db: str) -> None:
    """Database-level coordination: the namespace row lock serializes the write and the erasure.

    Whichever transaction wins, the guarantee holds: a write committed before the erasure is
    deleted by it, and a write arriving after revocation is rejected — never silently stored.
    """
    import asyncio

    async def scenario() -> tuple[str, int]:
        async with get_session_maker()() as session:
            async with session.begin():
                _row, session_token = await ghost_db.create_session(session)
                owner = _row.id
        ns = str(uuid.uuid4())
        async with get_session_maker()() as session:
            async with session.begin():
                claim = await ghost_db.claim_namespace(session, namespace_id=ns, generation=1, owner_session_id=owner)
        deletion_hash = ghost_db.hash_token(claim.deletion_token)

        async def do_erase() -> ghost_db.EraseResult:
            async with get_session_maker()() as session:
                async with session.begin():
                    return await ghost_db.erase_namespace_locked(
                        session, namespace_id=ns, deletion_token_hash=deletion_hash, idempotency_key=str(uuid.uuid4())
                    )

        async def do_write() -> ghost_db.PutResult:
            await asyncio.sleep(0.05)  # let the erasure take the row lock first, usually
            async with get_session_maker()() as session:
                async with session.begin():
                    return await ghost_db.put_artifact_locked(
                        session,
                        owner_session_id=owner,
                        artifact=ghost_db.ArtifactFields(
                            namespace_id=ns,
                            artifact_id=str(uuid.uuid4()),
                            generation=1,
                            schema_version=1,
                            iv=base64.b64encode(secrets.token_bytes(12)).decode(),
                            ciphertext=base64.b64encode(secrets.token_bytes(32)).decode(),
                        ),
                    )

        erase_result, put_result = await asyncio.gather(do_erase(), do_write())
        async with get_session_maker()() as session:
            remaining = (
                await session.execute(select(ghost_db.GhostArtifact).where(ghost_db.GhostArtifact.namespace_id == ns))
            ).scalars().all()
        assert len(remaining) == 0, "no artifact may survive the erasure"
        assert erase_result.outcome == "completed"
        # Either the write was rejected as revoked, or it committed first and was counted as removed.
        assert put_result.outcome == "revoked" or erase_result.erasure.artifacts_removed == 1
        return put_result.outcome, erase_result.erasure.artifacts_removed

    outcome, removed = asyncio.run(scenario())
    assert outcome in {"revoked", "stored"}
    assert removed in {0, 1}


def test_namespace_status_is_owner_scoped_with_real_count(client: TestClient, db: str) -> None:
    token_a = create_session(client)
    token_b = create_session(client)
    ns = str(uuid.uuid4())
    deletion_token = register(client, token_a, ns).json()["deletion_token"]
    upload(client, token_a, ns, make_envelope(ns))
    upload(client, token_a, ns, make_envelope(ns))

    # The owner sees lifecycle metadata and the REAL artifact count, with an observation time.
    res = client.get(f"/api/v1/namespaces/{ns}/status", headers=auth(token_a))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["namespace_id"] == ns
    assert body["state"] == "active"
    assert body["generation"] == 1
    assert body["artifact_count"] == 2  # a live COUNT(*), not a capped list length
    assert body["observed_at"]

    # Another session gets the same answer as for a nonexistent namespace: no existence leak.
    assert client.get(f"/api/v1/namespaces/{ns}/status", headers=auth(token_b)).status_code == 404
    assert client.get(f"/api/v1/namespaces/{uuid.uuid4()}/status", headers=auth(token_a)).status_code == 404

    # A deletion capability cannot read status (it may only erase and read the erasure result).
    assert client.get(f"/api/v1/namespaces/{ns}/status", headers=auth(deletion_token)).status_code == 403

    # After revocation the owner can still observe its own lifecycle state, with count 0.
    assert erase(client, deletion_token, ns, str(uuid.uuid4())).status_code == 200
    res = client.get(f"/api/v1/namespaces/{ns}/status", headers=auth(token_a))
    assert res.status_code == 200
    assert res.json()["state"] == "revoked"
    assert res.json()["artifact_count"] == 0


def test_erasure_result_carries_a_real_remaining_artifact_count(client: TestClient, db: str) -> None:
    token = create_session(client)
    ns = str(uuid.uuid4())
    deletion_token = register(client, token, ns).json()["deletion_token"]
    upload(client, token, ns, make_envelope(ns))

    res = erase(client, deletion_token, ns, str(uuid.uuid4()))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["artifacts_removed"] == 1
    assert body["artifacts_remaining"] == 0  # real post-delete COUNT(*) from the same transaction

    # The erasure-result route (deletion capability only, no active-namespace requirement) agrees.
    result = client.get(f"/api/v1/namespaces/{ns}/erasure", headers=auth(deletion_token))
    assert result.status_code == 200
    assert result.json()["artifacts_remaining"] == 0
    # ...and a session token is refused there.
    assert client.get(f"/api/v1/namespaces/{ns}/erasure", headers=auth(token)).status_code == 403
