"""Ghost's relay: what it forwards, what it refuses, and how it reports provider failures.

The provider is a mock transport: these tests pin the relay's contract (exact messages out,
configured origin/model only, readable errors) without spending a real credential. A live
smoke test against the real API is run separately during development.
"""

import json
from collections.abc import Iterator

import httpx
import pytest
from api.routers.api.v1 import route as relay
from env.mistral import env as mistral_env
from fastapi.testclient import TestClient

from conftest import build_app

MODEL = "test-model-1"
ORIGIN = "https://provider.test"
NAMESPACE = "11111111-2222-3333-4444-555555555555"


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
    """An app client whose default headers carry a fresh demo session that owns NAMESPACE."""
    client = TestClient(build_app())
    res = client.post("/api/v1/sessions")
    assert res.status_code == 200, res.text
    token = res.json()["token"]
    reg = client.post(
        "/api/v1/namespaces",
        json={"namespace_id": NAMESPACE, "generation": 1},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert reg.status_code in (200, 201), reg.text
    client.headers["Authorization"] = f"Bearer {token}"
    return client


def test_v1_routes_reject_missing_or_unknown_credentials(db: str) -> None:
    anonymous = TestClient(build_app())
    assert anonymous.get("/api/v1/config").status_code == 401
    assert anonymous.post("/api/v1/inference", json=_inference_body()).status_code == 401
    bad = TestClient(build_app())
    bad.headers["Authorization"] = "Bearer not-a-token"
    assert bad.get("/api/v1/config").status_code == 401
    assert bad.post("/api/v1/inference", json=_inference_body()).status_code == 401


def _install_transport(monkeypatch: pytest.MonkeyPatch, handler) -> list[httpx.Request]:
    """Route both relay clients at one mock transport and record every outbound request."""
    seen: list[httpx.Request] = []

    def recording_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(recording_handler)
    monkeypatch.setattr(relay, "_models_client_factory", lambda: httpx.AsyncClient(transport=transport))
    monkeypatch.setattr(relay, "_completion_client_factory", lambda: httpx.AsyncClient(transport=transport))
    return seen


def _models_response(ids: list[str]) -> httpx.Response:
    return httpx.Response(200, json={"data": [{"id": model_id} for model_id in ids]})


def _completion_response(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"role": "assistant", "content": text}}]},
    )


def _inference_body(**overrides) -> dict:
    body = {
        "messages": [{"role": "user", "content": "hello"}],
        "namespace_id": NAMESPACE,
        "generation": 1,
    }
    body.update(overrides)
    return body


def test_inference_forwards_exactly_the_approved_messages(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _install_transport(
        monkeypatch,
        lambda request: _models_response([MODEL])
        if request.url.path == "/v1/models"
        else _completion_response("cedar answer"),
    )

    messages = [
        {"role": "system", "content": "You are Ghost."},
        {"role": "user", "content": "brief + recalled memories"},
    ]
    res = client.post("/api/v1/inference", json=_inference_body(messages=messages))

    assert res.status_code == 200, res.text
    data = res.json()
    assert data["text"] == "cedar answer"
    assert data["model"] == MODEL
    assert data["namespace_id"] == NAMESPACE
    assert data["generation"] == 1

    completion = next(request for request in seen if request.url.path == "/v1/chat/completions")
    assert completion.url.host == "provider.test"
    outbound = json.loads(completion.content)
    assert outbound["model"] == MODEL
    assert outbound["stream"] is False
    # The relay appended nothing: the messages are exactly the approved snapshot.
    assert outbound["messages"] == messages
    assert completion.headers["authorization"] == "Bearer test-key"


def test_inference_rejects_a_browser_supplied_provider_url(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _install_transport(monkeypatch, lambda request: _models_response([MODEL]))
    res = client.post(
        "/api/v1/inference",
        json=_inference_body(baseUrl="https://evil.example/v1", model="other-model", apiKey="x"),
    )
    assert res.status_code == 422
    assert not seen, "no provider call may happen for a rejected request"


def test_inference_without_a_configured_key_is_a_readable_503(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mistral_env, "mistral_api_key", None)
    monkeypatch.setattr(relay, "_models_client_factory", lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda r: _models_response([MODEL]))))
    res = client.post("/api/v1/inference", json=_inference_body())
    assert res.status_code == 503
    assert "MISTRAL_API_KEY" in res.json()["detail"]


def test_unavailable_model_on_the_configured_origin_is_reported_without_fallback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _install_transport(
        monkeypatch,
        lambda request: _models_response(["some-other-model"])
        if request.url.path == "/v1/models"
        else _completion_response("never"),
    )
    res = client.post("/api/v1/inference", json=_inference_body())
    assert res.status_code == 502
    detail = res.json()["detail"]
    assert MODEL in detail
    assert ORIGIN in detail
    assert "global endpoint" in detail
    assert all(request.url.host == "provider.test" for request in seen)


def test_config_route_reports_origin_and_model_availability(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_transport(
        monkeypatch,
        lambda request: _models_response([MODEL]) if request.url.path == "/v1/models" else httpx.Response(500),
    )
    res = client.get("/api/v1/config")
    assert res.status_code == 200
    data = res.json()
    assert data == {
        "configured": True,
        "model": MODEL,
        "provider_origin": ORIGIN,
        "model_available": True,
    }
    assert "test-key" not in res.text


def test_config_route_without_a_key_says_so_without_leaking_it(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mistral_env, "mistral_api_key", None)
    res = client.get("/api/v1/config")
    assert res.status_code == 200
    data = res.json()
    assert data["configured"] is False
    assert data["model_available"] is None


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        pytest.param(401, 502, id="unauthorized"),
        pytest.param(403, 502, id="forbidden"),
        pytest.param(429, 429, id="rate_limited"),
        pytest.param(500, 502, id="server_error"),
    ],
)
def test_provider_failures_map_to_readable_errors(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, status: int, expected: int
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return _models_response([MODEL])
        return httpx.Response(status, json={"error": "secret provider detail"})

    _install_transport(monkeypatch, handler)
    res = client.post("/api/v1/inference", json=_inference_body())
    assert res.status_code == expected
    assert "secret provider detail" not in res.text


def test_provider_timeout_is_a_504(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return _models_response([MODEL])
        raise httpx.ReadTimeout("timed out", request=request)

    _install_transport(monkeypatch, handler)
    res = client.post("/api/v1/inference", json=_inference_body())
    assert res.status_code == 504


def test_oversized_body_is_rejected_before_parsing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _install_transport(monkeypatch, lambda request: _models_response([MODEL]))
    big = _inference_body(messages=[{"role": "user", "content": "x" * (relay.MAX_BODY_BYTES + 1)}])
    res = client.post("/api/v1/inference", json=big)
    assert res.status_code == 413
    assert not seen


def test_malformed_body_is_a_422(client: TestClient) -> None:
    res = client.post(
        "/api/v1/inference",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 422


def test_list_shaped_message_content_is_rendered_as_text(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return _models_response([MODEL])
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "Part one. "},
                                {"type": "text", "text": "Part two."},
                            ],
                        }
                    }
                ]
            },
        )

    _install_transport(monkeypatch, handler)
    res = client.post("/api/v1/inference", json=_inference_body())
    assert res.status_code == 200
    assert res.json()["text"] == "Part one. Part two."


def test_a_base_url_already_ending_in_v1_is_not_doubled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mistral_env, "mistral_base_url", f"{ORIGIN}/v1")
    seen = _install_transport(
        monkeypatch,
        lambda request: _models_response([MODEL])
        if request.url.path == "/v1/models"
        else _completion_response("ok"),
    )
    res = client.post("/api/v1/inference", json=_inference_body())
    assert res.status_code == 200
    assert all(request.url.path in {"/v1/models", "/v1/chat/completions"} for request in seen)
