"""Fetch one encrypted artifact: ``GET /api/v1/namespaces/{namespace_id}/artifacts/{artifact_id}``."""

from typing import Annotated

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter, Depends, HTTPException

from api.routers.api.v1._auth import SessionPrincipal, require_session
from api.routers.api.v1._namespaces import load_namespace_or_raise
from api.routers.api.v1._schemas import ArtifactEnvelopeOut

router = APIRouter(tags=["ghost-memory"], dependencies=[Depends(require_session)])


@router.get("", operation_id="ghost_get_artifact", response_model=ArtifactEnvelopeOut, summary="Fetch one encrypted artifact")
async def get_artifact(
    namespace_id: str,
    artifact_id: str,
    principal: Annotated[SessionPrincipal, Depends(require_session)],
) -> ArtifactEnvelopeOut:
    async with get_session_maker()() as session:
        await load_namespace_or_raise(session, namespace_id=namespace_id, owner_session_id=principal.session_id)
        row = await ghost_db.get_artifact(
            session, namespace_id=namespace_id, owner_session_id=principal.session_id, artifact_id=artifact_id
        )
    if row is None:
        raise HTTPException(status_code=404, detail="No such artifact in this namespace.")
    return ArtifactEnvelopeOut(
        namespace_id=row.namespace_id,
        generation=row.generation,
        artifact_id=row.artifact_id,
        schema_version=row.schema_version,
        iv=row.iv,
        ciphertext=row.ciphertext,
    )
