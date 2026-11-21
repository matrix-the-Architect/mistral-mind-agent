"""Authentication for the ``/api/v1`` group: anonymous demo sessions plus deletion capabilities.

There is no signup, email verification or OAuth here — this milestone ships a minimal anonymous
demo session: ``POST /api/v1/sessions`` mints a cryptographically random bearer token, returns it
exactly once, and the server stores only its SHA-256 hash. Every other route in the group requires
a valid credential (group dependency in ``v1/__init__.py``); route modules then narrow it:

- the relay and all memory routes require a **session** principal (``require_session``);
- the erasure routes require a **deletion capability** principal (``require_deletion_capability``),
  a separate token issued once at namespace registration. It can erase exactly its own namespace
  and read the erasure result — nothing else — and it keeps working after the namespace is revoked,
  because it is resolved by its own hash, not through the session or the namespace's active state.

Tokens travel only in the ``Authorization: Bearer`` header — never in URLs, bodies or logs.
"""

import uuid
from dataclasses import dataclass
from typing import Annotated, Union

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import Depends, HTTPException, Request, status


@dataclass(frozen=True)
class SessionPrincipal:
    session_id: uuid.UUID


@dataclass(frozen=True)
class DeletionPrincipal:
    """The one namespace this deletion capability may erase (plus the hash it was resolved by)."""

    namespace_id: str
    token_hash: str


Principal = Union[SessionPrincipal, DeletionPrincipal]

# Endpoints marked with this attribute are reachable without a credential (session bootstrap only).
ANONYMOUS_MARKER = "ghost_anonymous"


def _bearer_token(request: Request) -> str:
    header = request.headers.get("authorization")
    if header is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization: Bearer <token> header.",
        )
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed Authorization header; expected 'Bearer <token>'.",
        )
    return token.strip()


async def ghost_credential(request: Request) -> Principal | None:
    """The group access rule: resolve the bearer token to a principal, or reject with 401.

    A token is either a session token (owns namespaces, reads/writes memory, calls inference) or a
    deletion capability (erases exactly one namespace). Anything else is 401. Only the endpoint
    marked anonymous (session bootstrap) may be reached without a header. The token value itself
    is hashed immediately and never logged.
    """
    endpoint = request.scope.get("endpoint")
    if getattr(endpoint, ANONYMOUS_MARKER, False):
        return None
    token_hash = ghost_db.hash_token(_bearer_token(request))
    async with get_session_maker()() as session:
        row = await ghost_db.get_session_by_token_hash(session, token_hash)
        if row is not None:
            return SessionPrincipal(session_id=row.id)
        namespace = await ghost_db.get_namespace_by_deletion_token_hash(session, token_hash)
        if namespace is not None:
            return DeletionPrincipal(namespace_id=namespace.namespace_id, token_hash=token_hash)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unknown or revoked credential.",
    )


async def require_session(
    principal: Annotated[Principal | None, Depends(ghost_credential)],
) -> SessionPrincipal:
    """Narrow the group credential to a session: memory operations and inference."""
    if not isinstance(principal, SessionPrincipal):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This operation requires a session token; a deletion capability cannot read memory or call inference.",
        )
    return principal


async def require_deletion_capability(
    principal: Annotated[Principal | None, Depends(ghost_credential)],
) -> DeletionPrincipal:
    """Narrow the group credential to a deletion capability: erase + erasure result only."""
    if not isinstance(principal, DeletionPrincipal):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This operation requires the namespace's deletion capability, not a session token.",
        )
    return principal
