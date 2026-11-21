"""Ghost milestone 2 tables: anonymous demo sessions, namespaces, ciphertext artifacts, erasure.

Everything here is routing, authorization and lifecycle metadata only. Memory text and provenance
live exclusively inside the browser-encrypted ``ciphertext`` of :class:`GhostArtifact`; the server
never sees plaintext, prompts or keys, and never logs these rows' content columns.

Tables:

- ``ghost_session``     — one anonymous demo session; only the SHA-256 of its bearer token is stored.
- ``ghost_namespace``   — one browser vault namespace, bound to its owning session, with its state
  (``active``/``revoked``) and the hash of its narrowly scoped deletion capability.
- ``ghost_artifact``    — one encrypted envelope, keyed by ``(namespace_id, artifact_id)``.
- ``ghost_erasure``     — the minimal scoped erasure result retained after a Forget Me, so retries
  can retrieve the same completed answer. This control metadata is deliberately kept: it is the
  disclosed record that a namespace was revoked and its artifacts removed.
"""

import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class GhostSession(SQLModel, table=True):
    """An anonymous demo session. The bearer token itself is returned once and never stored."""

    __tablename__ = "ghost_session"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # SHA-256 hex of the bearer token; the token itself never touches the database.
    token_hash: str = Field(max_length=64, unique=True, index=True)
    created_at: datetime = Field(
        default_factory=_utcnow, sa_column=sa.Column(sa.DateTime(timezone=True), nullable=False)
    )


class GhostNamespace(SQLModel, table=True):
    """A browser vault namespace bound to the session that claimed it.

    ``state`` starts ``active`` and can only move to ``revoked`` (by the deletion capability, in
    one locked transaction); a revoked namespace can never be reactivated.
    """

    __tablename__ = "ghost_namespace"

    namespace_id: str = Field(primary_key=True, max_length=64)
    owner_session_id: uuid.UUID = Field(foreign_key="ghost_session.id", index=True)
    generation: int = Field(ge=1, le=1_000_000)
    state: str = Field(default="active", max_length=16, index=True)
    # SHA-256 hex of the deletion capability issued once at registration.
    deletion_token_hash: str = Field(max_length=64)
    created_at: datetime = Field(
        default_factory=_utcnow, sa_column=sa.Column(sa.DateTime(timezone=True), nullable=False)
    )
    revoked_at: datetime | None = Field(
        default=None, sa_column=sa.Column(sa.DateTime(timezone=True), nullable=True)
    )


class GhostArtifact(SQLModel, table=True):
    """One encrypted memory envelope. ``iv``/``ciphertext`` are base64; nothing else is stored."""

    __tablename__ = "ghost_artifact"

    namespace_id: str = Field(primary_key=True, foreign_key="ghost_namespace.namespace_id", max_length=64)
    artifact_id: str = Field(primary_key=True, max_length=64)
    generation: int = Field(ge=1, le=1_000_000)
    schema_version: int = Field(ge=1, le=1_000_000)
    iv: str = Field(max_length=32)
    ciphertext: str = Field(max_length=1_048_576)
    uploaded_at: datetime = Field(
        default_factory=_utcnow, sa_column=sa.Column(sa.DateTime(timezone=True), nullable=False)
    )


class GhostErasure(SQLModel, table=True):
    """The minimal scoped erasure result for a revoked namespace.

    Retained after Forget Me so a replayed or retried erasure request returns the same completed
    result. It deliberately records only lifecycle facts (when, how many artifacts, under which
    idempotency key) — never any memory content.
    """

    __tablename__ = "ghost_erasure"

    namespace_id: str = Field(primary_key=True, foreign_key="ghost_namespace.namespace_id", max_length=64)
    idempotency_key: str = Field(max_length=64)
    status: str = Field(max_length=16)
    artifacts_removed: int = Field(ge=0)
    requested_at: datetime = Field(
        default_factory=_utcnow, sa_column=sa.Column(sa.DateTime(timezone=True), nullable=False)
    )
    completed_at: datetime = Field(
        default_factory=_utcnow, sa_column=sa.Column(sa.DateTime(timezone=True), nullable=False)
    )
