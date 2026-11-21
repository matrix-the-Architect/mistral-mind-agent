"""Request/response schemas for Ghost's remote ciphertext storage routes.

The memory payload is exactly the browser's encrypted envelope — ``namespace_id``, ``generation``,
``artifact_id``, ``schema_version``, ``iv``, ``ciphertext`` — and nothing else. Plaintext memory,
prompts, credentials and keys never appear in any schema here. Field patterns and sizes are
validated before anything touches the database.
"""

import base64
import binascii
import json
import re
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

# The one envelope schema this milestone produces; the browser's SCHEMA_VERSION.
SCHEMA_VERSION = 1
# AES-GCM with a fresh 12-byte IV per encryption.
IV_BYTES = 12
# Modest ceiling on one stored envelope (~256 KiB of ciphertext).
MAX_CIPHERTEXT_BYTES = 256 * 1024
MAX_CIPHERTEXT_CHARS = 4 * ((MAX_CIPHERTEXT_BYTES + 2) // 3) + 4
# The whole upload body (envelope JSON plus field names) stays under this.
MAX_UPLOAD_BODY_BYTES = 512 * 1024

NamespaceId = Annotated[str, Field(pattern=UUID_PATTERN)]
ArtifactId = Annotated[str, Field(pattern=UUID_PATTERN)]


def _decode_base64(value: str, *, field: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"Invalid envelope: {field} is not valid base64.") from error


class RegisterNamespaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    namespace_id: NamespaceId
    generation: Annotated[int, Field(ge=1, le=1_000_000)]


class NamespaceRegistered(BaseModel):
    namespace_id: str
    generation: int
    state: str
    created: bool
    # The deletion capability, returned exactly once at first registration. Only its hash is stored.
    deletion_token: str | None = None


class NamespaceStatusOut(BaseModel):
    """Owner-scoped read-only status: lifecycle metadata plus the real artifact count at query time.

    Not a database-wide count and not a paginated-list length: ``artifact_count`` is a live
    ``COUNT(*)`` scoped to this one namespace, and ``observed_at`` says when it was observed.
    """

    namespace_id: str
    generation: int
    state: str
    artifact_count: int
    observed_at: str


class ArtifactEnvelopeBody(BaseModel):
    """The encrypted envelope exactly as the browser persisted it — unchanged field names."""

    model_config = ConfigDict(extra="forbid")

    namespace_id: NamespaceId
    generation: Annotated[int, Field(ge=1, le=1_000_000)]
    artifact_id: ArtifactId
    schema_version: Annotated[int, Field(ge=1, le=1_000_000)]
    iv: Annotated[str, Field(min_length=1, max_length=32)]
    ciphertext: Annotated[str, Field(min_length=1, max_length=MAX_CIPHERTEXT_CHARS)]

    @field_validator("schema_version")
    @classmethod
    def _supported_schema(cls, value: int) -> int:
        if value != SCHEMA_VERSION:
            raise ValueError(f"unsupported envelope schema_version {value}; this relay stores schema {SCHEMA_VERSION}")
        return value

    @field_validator("iv")
    @classmethod
    def _iv_is_12_bytes(cls, value: str) -> str:
        if len(_decode_base64(value, field="iv")) != IV_BYTES:
            raise ValueError("iv must decode to exactly 12 bytes (AES-GCM)")
        return value

    @field_validator("ciphertext")
    @classmethod
    def _ciphertext_size(cls, value: str) -> str:
        if len(_decode_base64(value, field="ciphertext")) > MAX_CIPHERTEXT_BYTES:
            raise ValueError(f"ciphertext exceeds the {MAX_CIPHERTEXT_BYTES}-byte storage limit")
        return value


class ArtifactUploaded(BaseModel):
    artifact_id: str
    status: Literal["stored", "exists"]


class ArtifactEnvelopeOut(BaseModel):
    namespace_id: str
    generation: int
    artifact_id: str
    schema_version: int
    iv: str
    ciphertext: str


class ArtifactListOut(BaseModel):
    namespace_id: str
    state: str
    artifacts: list[ArtifactEnvelopeOut]


class EraseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: Annotated[str, Field(min_length=8, max_length=64, pattern=r"^[0-9a-fA-F-]+$")]


class ErasureResultOut(BaseModel):
    namespace_id: str
    status: str
    artifacts_removed: int
    # Live remaining-artifact COUNT(*) for the namespace at response time (a real query, usually 0).
    artifacts_remaining: int
    idempotency_key: str
    requested_at: str
    completed_at: str
    namespace_state: str
    revoked_at: str | None


def parse_json_body(raw: bytes, *, max_bytes: int, what: str) -> dict:
    if len(raw) > max_bytes:
        raise HTTPException(status_code=413, detail=f"{what} body exceeds the {max_bytes}-byte relay limit.")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail=f"Invalid {what} request body.") from error
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail=f"Invalid {what} request body.")
    return payload
