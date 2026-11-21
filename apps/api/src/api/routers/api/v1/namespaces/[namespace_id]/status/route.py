"""Read-only namespace status: ``GET /api/v1/namespaces/{namespace_id}/status``.

Owner-scoped and session-authorized: the session principal from the bearer token decides ownership,
never a request-supplied owner ID. Another session's namespace is indistinguishable from a
nonexistent one (404), and a deletion capability cannot use this route (403 — it must not read
memory or lifecycle detail beyond the erasure result). The response carries only lifecycle metadata
and a REAL per-namespace artifact count with its observation time — never content. Revoked
namespaces are included on purpose, so the owner can observe its own state after erasure.
"""

from typing import Annotated

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter, Depends, HTTPException

from api.routers.api.v1._auth import SessionPrincipal, require_session
from api.routers.api.v1._schemas import NamespaceStatusOut

router = APIRouter(tags=["ghost-memory"], dependencies=[Depends(require_session)])


@router.get("", operation_id="ghost_get_namespace_status", response_model=NamespaceStatusOut, summary="Read-only owner-scoped namespace status with the real artifact count")
async def get_namespace_status(
    namespace_id: str,
    principal: Annotated[SessionPrincipal, Depends(require_session)],
) -> NamespaceStatusOut:
    async with get_session_maker()() as session:
        status = await ghost_db.namespace_status(
            session, namespace_id=namespace_id, owner_session_id=principal.session_id
        )
    if status is None:
        # Unknown or owned by another session: same answer, no existence leak.
        raise HTTPException(status_code=404, detail="No such namespace for this session.")
    return NamespaceStatusOut(
        namespace_id=status.namespace_id,
        generation=status.generation,
        state=status.state,
        artifact_count=status.artifact_count,
        observed_at=status.observed_at.isoformat(),
    )
