"""Ghost's relay: the only place the Mistral credential is spent.

The browser sends a complete ``messages`` array plus the vault's ``namespace_id`` and
``generation``; the relay forwards exactly that array to ``/v1/chat/completions`` on the
configured provider origin and never appends history or private context of its own. The
provider origin and model come only from this process's environment — the request model
forbids extra fields, so a browser cannot point the relay at an arbitrary URL, another
model, or a credential of its own.

Request bodies, response bodies, credentials and memory content are never logged: only
status codes and error class names are.
"""

import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

import httpx
from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from env.mistral import env as mistral_env
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from utils.mistral import mistral_api_url, mistral_app_token, MistralNotConfiguredError

from api.routers.api.v1._auth import SessionPrincipal, require_session

logger = logging.getLogger(__name__)

# Every relay route requires a session token; a deletion capability cannot call inference.
router = APIRouter(tags=["ghost"], dependencies=[Depends(require_session)])

# A modest ceiling on one inference request: enough for a brief plus a few recalled memories.
MAX_BODY_BYTES = 64 * 1024
MAX_MESSAGES = 50
MAX_CONTENT_CHARS = 20_000
MODEL_CHECK_TIMEOUT_SECONDS = 10.0
COMPLETION_TIMEOUT_SECONDS = 60.0
# How long a successful /v1/models answer is trusted before the model is checked again.
MODEL_CHECK_TTL_SECONDS = 60.0

Role = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role
    content: Annotated[str, Field(min_length=1, max_length=MAX_CONTENT_CHARS)]


class InferenceRequest(BaseModel):
    # `extra="forbid"` is what rejects a browser-supplied provider URL, model or API key.
    model_config = ConfigDict(extra="forbid")

    messages: Annotated[list[ChatMessage], Field(min_length=1, max_length=MAX_MESSAGES)]
    namespace_id: Annotated[str, Field(pattern=r"^[0-9a-fA-F-]{8,64}$")]
    generation: Annotated[int, Field(ge=1, le=1_000_000)]


class InferenceResponse(BaseModel):
    text: str
    model: str
    namespace_id: str
    generation: int


class ConfigResponse(BaseModel):
    configured: bool
    model: str
    provider_origin: str
    # None when the credential is missing or the availability check itself failed.
    model_available: bool | None


def _v1_root() -> str:
    """The configured provider's ``/v1`` root. Never rewritten to another origin."""
    root = mistral_api_url().rstrip("/")
    return root if root.endswith("/v1") else f"{root}/v1"


def _provider_origin() -> str:
    parsed = urlparse(_v1_root())
    return f"{parsed.scheme}://{parsed.netloc}"


def _default_client_factory(timeout_seconds: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds, connect=10.0))


# One factory per timeout; tests replace these to route the relay at a mock transport.
def _models_client() -> httpx.AsyncClient:
    return _models_client_factory()


def _completion_client() -> httpx.AsyncClient:
    return _completion_client_factory()


_models_client_factory: Callable[[], httpx.AsyncClient] = lambda: _default_client_factory(MODEL_CHECK_TIMEOUT_SECONDS)
_completion_client_factory: Callable[[], httpx.AsyncClient] = lambda: _default_client_factory(COMPLETION_TIMEOUT_SECONDS)

# (origin, model) -> (checked_at, available). A short TTL so a key rotation or a provider-side
# model rollout is noticed without paying for /v1/models on every inference.
_model_availability: dict[tuple[str, str], tuple[float, bool]] = {}


def _configured_model() -> str:
    return mistral_env.mistral_model


async def _model_available(origin: str, model: str, token: str) -> bool:
    cached = _model_availability.get((origin, model))
    if cached is not None and time.monotonic() - cached[0] < MODEL_CHECK_TTL_SECONDS:
        return cached[1]
    async with _models_client() as client:
        response = await client.get(
            f"{_v1_root()}/models",
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
    ids = {entry.get("id") for entry in response.json().get("data", [])}
    available = model in ids
    _model_availability[(origin, model)] = (time.monotonic(), available)
    return available


async def _require_available_model(origin: str, model: str, token: str) -> None:
    """Check the configured model against /v1/models on the same configured origin.

    There is deliberately no fallback: when a regional (e.g. EU) origin is configured and does
    not serve the model, the answer says so instead of silently calling the global endpoint.
    """
    try:
        available = await _model_available(origin, model, token)
    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail=f"The configured provider origin {origin} did not answer /v1/models in time; "
            "the relay cannot confirm that model '{model}' is served there.",
        ) from error
    except httpx.HTTPStatusError as error:
        raise HTTPException(
            status_code=502,
            detail=f"The configured provider origin {origin} rejected the /v1/models check with "
            f"HTTP {error.response.status_code}; check the relay's credential and origin.",
        ) from error
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502,
            detail=f"The configured provider origin {origin} is unreachable ({type(error).__name__}).",
        ) from error
    if not available:
        raise HTTPException(
            status_code=502,
            detail=f"Model '{model}' is not served by the configured provider origin {origin}. "
            "The relay does not fall back to the global endpoint; fix MISTRAL_MODEL or MISTRAL_BASE_URL.",
        )


def _extract_text(payload: dict[str, Any]) -> str:
    """Read the first choice's content, whether it arrived as a string or as content parts."""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise HTTPException(status_code=502, detail="The provider returned no choices.")
    content = choices[0].get("message", {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    raise HTTPException(status_code=502, detail="The provider returned an unreadable message content.")


async def _complete(model: str, messages: list[dict[str, str]], token: str) -> str:
    """One real, non-streaming call to /v1/chat/completions with exactly the given messages."""
    body = {"model": model, "messages": messages, "stream": False}
    try:
        async with _completion_client() as client:
            response = await client.post(
                f"{_v1_root()}/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json=body,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="The Mistral API did not answer within the timeout.") from error
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502, detail=f"The Mistral API is unreachable ({type(error).__name__})."
        ) from error
    if response.status_code == 401 or response.status_code == 403:
        raise HTTPException(
            status_code=502,
            detail="The relay's Mistral credential was rejected (HTTP "
            f"{response.status_code}); check MISTRAL_API_KEY on the server.",
        )
    if response.status_code == 404:
        raise HTTPException(
            status_code=502,
            detail=f"Model '{model}' was not found on the configured provider origin {_provider_origin()}. "
            "The relay does not fall back to the global endpoint; fix MISTRAL_MODEL or MISTRAL_BASE_URL.",
        )
    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="The Mistral API rate-limited the relay; retry later.")
    if response.status_code >= 400:
        logger.warning("ghost relay: provider answered HTTP %s", response.status_code)
        raise HTTPException(
            status_code=502, detail=f"The Mistral API answered HTTP {response.status_code}."
        )
    return _extract_text(response.json())


def _relay_token() -> str:
    try:
        return mistral_app_token()
    except MistralNotConfiguredError as error:
        raise HTTPException(
            status_code=503,
            detail="MISTRAL_API_KEY is not configured on the relay; set it in the server environment.",
        ) from error


@router.get("/config", operation_id="ghost_config", summary="Relay configuration and model availability")
async def ghost_config() -> ConfigResponse:
    """Whether the relay is configured, which model it will call, and whether that model is
    served by the configured provider origin. Never includes the credential."""
    origin = _provider_origin()
    model = _configured_model()
    try:
        token = mistral_app_token()
    except MistralNotConfiguredError:
        return ConfigResponse(configured=False, model=model, provider_origin=origin, model_available=None)
    try:
        available = await _model_available(origin, model, token)
    except (httpx.HTTPError, HTTPException):
        available = None
    return ConfigResponse(configured=True, model=model, provider_origin=origin, model_available=available)


async def _require_active_owned_namespace(namespace_id: str, generation: int, session_id: uuid.UUID) -> None:
    """Check, in a short transaction that is CLOSED before any provider call, that the namespace in
    the request is owned by this session, still active, and at the claimed generation.

    No database transaction is held open across the Mistral network call. A request for another
    session's namespace (or a revoked one) is rejected before anything is sent to the provider.
    """
    async with get_session_maker()() as session:
        namespace = await ghost_db.get_owned_namespace(
            session, namespace_id=namespace_id, owner_session_id=session_id
        )
    if namespace is None:
        raise HTTPException(status_code=403, detail="This namespace does not exist or is not owned by this session.")
    if namespace.state != "active":
        raise HTTPException(status_code=409, detail="This namespace is revoked; inference is refused for it.")
    if namespace.generation != generation:
        raise HTTPException(
            status_code=409,
            detail=f"Generation mismatch: the namespace is at generation {namespace.generation}, the request claims {generation}.",
        )


@router.post("/inference", operation_id="ghost_inference", summary="One non-streaming Mistral completion")
async def ghost_inference(
    request: Request,
    principal: Annotated[SessionPrincipal, Depends(require_session)],
) -> InferenceResponse:
    """Forward the browser's approved ``messages`` snapshot to Mistral and return the text.

    The relay appends nothing: no system prompt, no history, no private context. The admitted
    ``namespace_id`` and ``generation`` are echoed back so the browser can show which vault
    the answer belongs to. The namespace must be registered, owned by this session, active and at
    the claimed generation before anything is sent to the provider.
    """
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413, detail=f"Request body exceeds the {MAX_BODY_BYTES}-byte relay limit."
        )
    try:
        payload = InferenceRequest.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as error:
        raise HTTPException(status_code=422, detail="Invalid inference request; extra fields such as a provider URL are rejected.") from error

    await _require_active_owned_namespace(payload.namespace_id, payload.generation, principal.session_id)

    token = _relay_token()
    origin = _provider_origin()
    model = _configured_model()
    await _require_available_model(origin, model, token)
    messages = [{"role": message.role, "content": message.content} for message in payload.messages]
    text = await _complete(model, messages, token)
    return InferenceResponse(
        text=text, model=model, namespace_id=payload.namespace_id, generation=payload.generation
    )
