"""Erasure request: ``POST /api/v1/namespaces/{namespace_id}/erase``.

Authorized ONLY by the namespace's deletion capability (a separate, narrowly scoped token whose
hash alone is stored server-side) — never by a session token, and never requiring the namespace to
still be active, so retries keep working after ordinary access was revoked. The whole erasure is
one database transaction: lock the namespace row, verify the capability, mark it revoked, delete its
artifact rows, record the minimal erasure result, commit. Replays return the same completed result.
"""

from typing import Annotated

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter, Depends, HTTPException

from api.routers.api.v1._auth import DeletionPrincipal, require_deletion_capability
from api.routers.api.v1._erasure import result_out
from api.routers.api.v1._schemas import EraseRequest, ErasureResultOut

router = APIRouter(tags=["ghost-erasure"], dependencies=[Depends(require_deletion_capability)])


@router.post("", operation_id="ghost_erase_namespace", response_model=ErasureResultOut, summary="Erase the namespace (deletion capability only, idempotent)")
async def erase_namespace(
    namespace_id: str,
    body: EraseRequest,
    principal: Annotated[DeletionPrincipal, Depends(require_deletion_capability)],
) -> ErasureResultOut:
    if principal.namespace_id != namespace_id:
        raise HTTPException(status_code=403, detail="This deletion capability belongs to a different namespace.")
    async with get_session_maker()() as session:
        async with session.begin():
            result = await ghost_db.erase_namespace_locked(
                session,
                namespace_id=namespace_id,
                deletion_token_hash=principal.token_hash,
                idempotency_key=body.idempotency_key,
            )
            # Real remaining-artifact count, queried inside the same committed transaction.
            remaining = await ghost_db.count_artifacts(session, namespace_id=namespace_id)
    if result.outcome == "unknown-namespace":
        raise HTTPException(status_code=404, detail="No such namespace.")
    if result.outcome == "forbidden":
        raise HTTPException(status_code=403, detail="The deletion capability does not match this namespace.")
    assert result.erasure is not None and result.namespace is not None
    return result_out(result.erasure, result.namespace, artifacts_remaining=remaining)
