"""Shared per-namespace authorization check for the memory routes.

Lives at the ``v1`` level (not inside a ``[namespace_id]`` directory, whose name is not an importable
identifier) so every route module can use it: unknown namespace → 404, another session's namespace →
403, revoked → 409. A request-supplied namespace UUID is never sufficient — the session principal
from the bearer token decides ownership.
"""

from db.accessors import ghost_memory as ghost_db
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

import uuid


async def load_namespace_or_raise(
    session: AsyncSession, *, namespace_id: str, owner_session_id: uuid.UUID
) -> ghost_db.GhostNamespace:
    namespace = await ghost_db.get_namespace(session, namespace_id)
    if namespace is None:
        raise HTTPException(status_code=404, detail="No such namespace.")
    if namespace.owner_session_id != owner_session_id:
        raise HTTPException(status_code=403, detail="This namespace belongs to another session.")
    if namespace.state != "active":
        raise HTTPException(
            status_code=409, detail="This namespace is revoked; its memory can no longer be read or written."
        )
    return namespace
