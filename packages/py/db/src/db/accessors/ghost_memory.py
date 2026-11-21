"""Accessors for the ``ghost_*`` tables: the only place those rows are read or written.

Every mutating operation that must coordinate with erasure runs inside ONE database transaction
and takes the namespace row's lock (``SELECT ... FOR UPDATE`` on PostgreSQL) before deciding:

- an artifact write that commits before the erasure transaction is included in the deletion;
- an artifact write that arrives after revocation sees ``state == "revoked"`` and is rejected,
  because the erasure holds the same row lock until it commits.

Tokens (session bearer tokens and deletion capabilities) are created here and only their SHA-256
hashes are ever stored or compared.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models.ghost_memory import GhostArtifact, GhostErasure, GhostNamespace, GhostSession


def new_token() -> str:
    """A fresh cryptographically random bearer token (returned once, never stored in the clear)."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """The server-side representation of a token: SHA-256 hex, so a database leak yields no tokens."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- sessions -----------------------------------------------------------------


async def create_session(session: AsyncSession) -> tuple[GhostSession, str]:
    """Create one anonymous demo session; returns the row and the plaintext token (once)."""
    token = new_token()
    row = GhostSession(id=uuid.uuid4(), token_hash=hash_token(token))
    session.add(row)
    await session.flush()
    return row, token


async def get_session_by_token_hash(session: AsyncSession, token_hash: str) -> GhostSession | None:
    statement = select(GhostSession).where(GhostSession.token_hash == token_hash)
    return (await session.execute(statement)).scalar_one_or_none()


async def get_namespace_by_deletion_token_hash(session: AsyncSession, token_hash: str) -> GhostNamespace | None:
    """Resolve a deletion capability to the one namespace it may erase (hash lookup only)."""
    statement = select(GhostNamespace).where(GhostNamespace.deletion_token_hash == token_hash)
    return (await session.execute(statement)).scalar_one_or_none()


# --- namespaces ---------------------------------------------------------------


@dataclass(frozen=True)
class ClaimResult:
    outcome: str  # "created" | "exists" | "conflict" | "revoked"
    namespace: GhostNamespace | None = None
    deletion_token: str | None = None  # plaintext, only on first creation, returned exactly once


async def get_namespace_for_update(session: AsyncSession, namespace_id: str) -> GhostNamespace | None:
    """Lock the namespace row for the rest of the transaction (a no-op render off PostgreSQL)."""
    statement = select(GhostNamespace).where(GhostNamespace.namespace_id == namespace_id).with_for_update()
    return (await session.execute(statement)).scalar_one_or_none()


async def claim_namespace(
    session: AsyncSession, *, namespace_id: str, generation: int, owner_session_id: uuid.UUID
) -> ClaimResult:
    """Bind an unclaimed namespace to the authenticated owner.

    - unclaimed  -> created, and a deletion capability is issued (plaintext returned once);
    - already owned by this session and active -> ``exists`` (idempotent re-registration);
    - owned by another session -> ``conflict``;
    - revoked -> ``revoked``: a revoked namespace never becomes active again.
    """
    existing = await get_namespace_for_update(session, namespace_id)
    if existing is not None:
        if existing.state == "revoked":
            return ClaimResult("revoked", existing)
        if existing.owner_session_id != owner_session_id:
            return ClaimResult("conflict", existing)
        return ClaimResult("exists", existing)
    token = new_token()
    row = GhostNamespace(
        namespace_id=namespace_id,
        owner_session_id=owner_session_id,
        generation=generation,
        state="active",
        deletion_token_hash=hash_token(token),
    )
    session.add(row)
    await session.flush()
    return ClaimResult("created", row, token)


async def get_namespace(session: AsyncSession, namespace_id: str) -> GhostNamespace | None:
    """The namespace row by ID alone (no ownership filter); callers apply their own authz."""
    return await session.get(GhostNamespace, namespace_id)


async def get_owned_namespace(
    session: AsyncSession, *, namespace_id: str, owner_session_id: uuid.UUID
) -> GhostNamespace | None:
    """The namespace row if — and only if — this session owns it (any state). No existence leak."""
    statement = select(GhostNamespace).where(
        GhostNamespace.namespace_id == namespace_id,
        GhostNamespace.owner_session_id == owner_session_id,
    )
    return (await session.execute(statement)).scalar_one_or_none()


@dataclass(frozen=True)
class NamespaceStatus:
    """Read-only lifecycle metadata plus the REAL current artifact count, observed at query time."""

    namespace_id: str
    generation: int
    state: str
    artifact_count: int
    observed_at: datetime


async def count_artifacts(session: AsyncSession, *, namespace_id: str) -> int:
    """A real ``COUNT(*)`` of the namespace's artifact rows — never a cached or capped estimate."""
    statement = select(func.count()).select_from(GhostArtifact).where(GhostArtifact.namespace_id == namespace_id)
    return int((await session.execute(statement)).scalar_one())


async def namespace_status(
    session: AsyncSession, *, namespace_id: str, owner_session_id: uuid.UUID
) -> NamespaceStatus | None:
    """Owner-scoped read-only status: lifecycle state plus the actual artifact count.

    Ownership comes from the session principal, never from a request-supplied owner ID; another
    session's namespace is indistinguishable from a nonexistent one (``None``). Revoked namespaces
    are included on purpose — the owner may still observe its own lifecycle state after erasure.
    """
    namespace = await get_owned_namespace(session, namespace_id=namespace_id, owner_session_id=owner_session_id)
    if namespace is None:
        return None
    return NamespaceStatus(
        namespace_id=namespace.namespace_id,
        generation=namespace.generation,
        state=namespace.state,
        artifact_count=await count_artifacts(session, namespace_id=namespace_id),
        observed_at=_utcnow(),
    )


# --- artifacts ----------------------------------------------------------------


@dataclass(frozen=True)
class ArtifactFields:
    namespace_id: str
    artifact_id: str
    generation: int
    schema_version: int
    iv: str
    ciphertext: str


@dataclass(frozen=True)
class PutResult:
    outcome: str  # "stored" | "exists" | "conflict" | "unknown-namespace" | "forbidden" | "revoked" | "generation-mismatch"
    artifact: GhostArtifact | None = None


async def put_artifact_locked(
    session: AsyncSession, *, owner_session_id: uuid.UUID, artifact: ArtifactFields
) -> PutResult:
    """Insert one envelope in the caller's transaction, under the namespace row lock.

    Authorization (ownership), active state and generation are checked while holding the lock, so a
    concurrent erasure either completed before this write (then this write is rejected as revoked)
    or starts after it (then it deletes this row). Replaying an identical artifact is idempotent;
    reusing its ID with different ciphertext is a conflict.
    """
    namespace = await get_namespace_for_update(session, artifact.namespace_id)
    if namespace is None:
        return PutResult("unknown-namespace")
    if namespace.owner_session_id != owner_session_id:
        return PutResult("forbidden")
    if namespace.state != "active":
        return PutResult("revoked")
    if namespace.generation != artifact.generation:
        return PutResult("generation-mismatch")
    existing = await session.get(GhostArtifact, (artifact.namespace_id, artifact.artifact_id))
    if existing is not None:
        if (
            existing.iv == artifact.iv
            and existing.ciphertext == artifact.ciphertext
            and existing.generation == artifact.generation
            and existing.schema_version == artifact.schema_version
        ):
            return PutResult("exists", existing)
        return PutResult("conflict", existing)
    row = GhostArtifact(
        namespace_id=artifact.namespace_id,
        artifact_id=artifact.artifact_id,
        generation=artifact.generation,
        schema_version=artifact.schema_version,
        iv=artifact.iv,
        ciphertext=artifact.ciphertext,
    )
    session.add(row)
    await session.flush()
    return PutResult("stored", row)


async def list_artifacts(
    session: AsyncSession, *, namespace_id: str, owner_session_id: uuid.UUID
) -> list[GhostArtifact] | None:
    """All envelopes of an active namespace owned by this session; ``None`` when not authorized."""
    namespace = await get_owned_namespace(session, namespace_id=namespace_id, owner_session_id=owner_session_id)
    if namespace is None or namespace.state != "active":
        return None
    statement = (
        select(GhostArtifact)
        .where(GhostArtifact.namespace_id == namespace_id)
        .order_by(GhostArtifact.uploaded_at.asc())
    )
    return list((await session.execute(statement)).scalars().all())


async def get_artifact(
    session: AsyncSession, *, namespace_id: str, owner_session_id: uuid.UUID, artifact_id: str
) -> GhostArtifact | None:
    """One envelope, only for the owning session of an active namespace."""
    artifacts = await list_artifacts(session, namespace_id=namespace_id, owner_session_id=owner_session_id)
    if artifacts is None:
        return None
    return next((row for row in artifacts if row.artifact_id == artifact_id), None)


# --- erasure ------------------------------------------------------------------


@dataclass(frozen=True)
class EraseResult:
    outcome: str  # "completed" | "unknown-namespace" | "forbidden"
    erasure: GhostErasure | None = None
    namespace: GhostNamespace | None = None


async def erase_namespace_locked(
    session: AsyncSession, *, namespace_id: str, deletion_token_hash: str, idempotency_key: str
) -> EraseResult:
    """Revoke a namespace and remove its artifacts in ONE locked transaction.

    Steps, all under the namespace row lock and committed together: verify the deletion capability
    hash, mark the namespace ``revoked``, delete its artifact rows, and record the minimal erasure
    result. A replay after a lost response finds the revoked namespace plus its recorded result and
    returns the same completed answer.
    """
    namespace = await get_namespace_for_update(session, namespace_id)
    if namespace is None:
        return EraseResult("unknown-namespace")
    if namespace.deletion_token_hash != deletion_token_hash:
        return EraseResult("forbidden", namespace=namespace)
    existing = await session.get(GhostErasure, namespace_id)
    if namespace.state == "revoked" and existing is not None:
        # Idempotent replay: same completed result, no further changes.
        return EraseResult("completed", existing, namespace)
    namespace.state = "revoked"
    namespace.revoked_at = _utcnow()
    removed = await session.execute(delete(GhostArtifact).where(GhostArtifact.namespace_id == namespace_id))
    erasure = GhostErasure(
        namespace_id=namespace_id,
        idempotency_key=idempotency_key,
        status="completed",
        artifacts_removed=removed.rowcount or 0,
        requested_at=_utcnow(),
        completed_at=_utcnow(),
    )
    session.add(erasure)
    await session.flush()
    return EraseResult("completed", erasure, namespace)


async def get_erasure_for_capability(
    session: AsyncSession, *, namespace_id: str, deletion_token_hash: str
) -> GhostErasure | None:
    """The recorded erasure result, retrievable with the deletion capability alone.

    This deliberately does NOT require the namespace to still be active (it is revoked by then)
    and does NOT require a session token: retries after ordinary access was revoked must work.
    """
    namespace = await get_namespace_for_update(session, namespace_id)
    if namespace is None or namespace.deletion_token_hash != deletion_token_hash:
        return None
    return await session.get(GhostErasure, namespace_id)
