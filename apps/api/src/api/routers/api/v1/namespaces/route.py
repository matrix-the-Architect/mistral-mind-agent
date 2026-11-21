"""Namespace registration: ``POST /api/v1/namespaces``.

Binds the browser's existing ``(namespaceId, generation)`` pair to the authenticated session — the
envelope fields and AAD are not renamed or rewritten. An unclaimed namespace is claimed by the
caller and a deletion capability is issued (returned once, only its hash is stored). A namespace
owned by another session is rejected, and a revoked namespace can never be reactivated through
registration.
"""

from typing import Annotated

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from api.routers.api.v1._auth import SessionPrincipal, require_session
from api.routers.api.v1._schemas import NamespaceRegistered, RegisterNamespaceRequest

router = APIRouter(tags=["ghost-memory"], dependencies=[Depends(require_session)])


@router.post("", operation_id="ghost_register_namespace", response_model=NamespaceRegistered, status_code=201, summary="Register the vault's namespace with its owner")
async def register_namespace(
    body: RegisterNamespaceRequest,
    principal: Annotated[SessionPrincipal, Depends(require_session)],
) -> NamespaceRegistered:
    async with get_session_maker()() as session:
        async with session.begin():
            try:
                result = await ghost_db.claim_namespace(
                    session,
                    namespace_id=body.namespace_id,
                    generation=body.generation,
                    owner_session_id=principal.session_id,
                )
            except IntegrityError:
                # A concurrent registration of the same namespace won the race.
                result = ghost_db.ClaimResult("conflict")
    if result.outcome == "conflict":
        raise HTTPException(status_code=409, detail="This namespace is already claimed by another session.")
    if result.outcome == "revoked":
        raise HTTPException(status_code=409, detail="This namespace was revoked and cannot be reactivated.")
    assert result.namespace is not None
    body = NamespaceRegistered(
        namespace_id=result.namespace.namespace_id,
        generation=result.namespace.generation,
        state=result.namespace.state,
        created=result.outcome == "created",
        # Plaintext deletion capability only on first creation; re-registration never re-issues it.
        deletion_token=result.deletion_token,
    )
    if result.outcome == "created":
        return body
    # Idempotent re-registration by the same owner: 200, no new capability.
    return JSONResponse(status_code=200, content=body.model_dump())
