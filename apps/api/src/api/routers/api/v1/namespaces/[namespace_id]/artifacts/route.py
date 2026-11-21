"""Encrypted artifact storage under ``/api/v1/namespaces/{namespace_id}/artifacts``.

Upload (POST) and list (GET). The payload is the browser's envelope verbatim; only ciphertext plus
routing/authorization/lifecycle metadata is stored. Writes take the namespace row lock inside one
transaction and check ownership, active state and generation, so a write that commits before an
erasure is included in that erasure and a write arriving after revocation is rejected. Uploads are
idempotent: the same artifact replayed succeeds; the same ID with different ciphertext is a 409.
"""

from typing import Annotated

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from api.routers.api.v1._auth import SessionPrincipal, require_session
from api.routers.api.v1._namespaces import load_namespace_or_raise
from api.routers.api.v1._schemas import (
    MAX_UPLOAD_BODY_BYTES,
    ArtifactEnvelopeBody,
    ArtifactEnvelopeOut,
    ArtifactListOut,
    ArtifactUploaded,
    parse_json_body,
)

router = APIRouter(tags=["ghost-memory"], dependencies=[Depends(require_session)])


@router.post("", operation_id="ghost_upload_artifact", response_model=ArtifactUploaded, status_code=201, summary="Upload one encrypted artifact (idempotent)")
async def upload_artifact(
    namespace_id: str,
    request: Request,
    principal: Annotated[SessionPrincipal, Depends(require_session)],
) -> ArtifactUploaded:
    try:
        payload = ArtifactEnvelopeBody.model_validate(
            parse_json_body(await request.body(), max_bytes=MAX_UPLOAD_BODY_BYTES, what="artifact upload")
        )
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=f"Invalid artifact envelope: {error.errors()[0]['msg']}") from error
    if payload.namespace_id != namespace_id:
        raise HTTPException(status_code=422, detail="The envelope's namespace_id must match the URL namespace.")
    artifact = ghost_db.ArtifactFields(
        namespace_id=payload.namespace_id,
        artifact_id=payload.artifact_id,
        generation=payload.generation,
        schema_version=payload.schema_version,
        iv=payload.iv,
        ciphertext=payload.ciphertext,
    )
    async with get_session_maker()() as session:
        async with session.begin():
            try:
                result = await ghost_db.put_artifact_locked(
                    session, owner_session_id=principal.session_id, artifact=artifact
                )
            except IntegrityError:
                raise HTTPException(status_code=409, detail="Concurrent write to this artifact ID; replay the identical envelope.")
    outcome = result.outcome
    if outcome == "stored":
        return ArtifactUploaded(artifact_id=payload.artifact_id, status="stored")
    if outcome == "exists":
        # Idempotent replay of an identical artifact: 200, not 201.
        return JSONResponse(
            status_code=200,
            content=ArtifactUploaded(artifact_id=payload.artifact_id, status="exists").model_dump(),
        )
    if outcome == "conflict":
        raise HTTPException(status_code=409, detail="An artifact with this ID but different ciphertext already exists.")
    if outcome == "unknown-namespace":
        raise HTTPException(status_code=404, detail="No such namespace.")
    if outcome == "forbidden":
        raise HTTPException(status_code=403, detail="This namespace belongs to another session.")
    if outcome == "revoked":
        raise HTTPException(status_code=409, detail="This namespace is revoked; no further writes are accepted.")
    raise HTTPException(status_code=409, detail="The envelope's generation does not match the registered namespace generation.")


@router.get("", operation_id="ghost_list_artifacts", response_model=ArtifactListOut, summary="List the namespace's encrypted artifacts")
async def list_artifacts(
    namespace_id: str,
    principal: Annotated[SessionPrincipal, Depends(require_session)],
) -> ArtifactListOut:
    async with get_session_maker()() as session:
        namespace = await load_namespace_or_raise(session, namespace_id=namespace_id, owner_session_id=principal.session_id)
        rows = await ghost_db.list_artifacts(session, namespace_id=namespace_id, owner_session_id=principal.session_id)
    assert rows is not None
    return ArtifactListOut(
        namespace_id=namespace.namespace_id,
        state=namespace.state,
        artifacts=[
            ArtifactEnvelopeOut(
                namespace_id=row.namespace_id,
                generation=row.generation,
                artifact_id=row.artifact_id,
                schema_version=row.schema_version,
                iv=row.iv,
                ciphertext=row.ciphertext,
            )
            for row in rows
        ],
    )
