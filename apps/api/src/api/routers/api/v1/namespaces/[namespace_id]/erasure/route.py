"""Erasure result retrieval: ``GET /api/v1/namespaces/{namespace_id}/erasure``.

Same narrow authorization as the erase route: the deletion capability alone, with no requirement
that the namespace remain active (it is revoked by design) and no session dependency — a client
that lost the first erase response can always come back for the recorded result.
"""

from typing import Annotated

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter, Depends, HTTPException

from api.routers.api.v1._auth import DeletionPrincipal, require_deletion_capability
from api.routers.api.v1._erasure import result_out
from api.routers.api.v1._schemas import ErasureResultOut

router = APIRouter(tags=["ghost-erasure"], dependencies=[Depends(require_deletion_capability)])


@router.get("", operation_id="ghost_get_erasure", response_model=ErasureResultOut, summary="Retrieve the recorded erasure result")
async def get_erasure(
    namespace_id: str,
    principal: Annotated[DeletionPrincipal, Depends(require_deletion_capability)],
) -> ErasureResultOut:
    if principal.namespace_id != namespace_id:
        raise HTTPException(status_code=403, detail="This deletion capability belongs to a different namespace.")
    async with get_session_maker()() as session:
        erasure = await ghost_db.get_erasure_for_capability(
            session, namespace_id=namespace_id, deletion_token_hash=principal.token_hash
        )
        namespace = await ghost_db.get_namespace(session, namespace_id)
        # Real remaining-artifact count for this namespace, observed now (not a stored estimate).
        remaining = await ghost_db.count_artifacts(session, namespace_id=namespace_id) if namespace is not None else 0
    if erasure is None or namespace is None:
        raise HTTPException(status_code=404, detail="No erasure has been recorded for this namespace yet.")
    return result_out(erasure, namespace, artifacts_remaining=remaining)
