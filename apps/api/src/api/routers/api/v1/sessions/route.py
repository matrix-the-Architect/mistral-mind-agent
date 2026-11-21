"""Session bootstrap: ``POST /api/v1/sessions`` — the only anonymous v1 endpoint.

Mints an anonymous demo session: a cryptographically random bearer token, returned exactly once.
The server stores only its SHA-256 hash, so a database leak does not yield usable credentials. There
is deliberately no signup, email verification or OAuth here.
"""

import uuid

from db import get_session_maker
from db.accessors import ghost_memory as ghost_db
from fastapi import APIRouter
from pydantic import BaseModel

from api.routers.api.v1._auth import ANONYMOUS_MARKER

router = APIRouter(tags=["ghost-auth"])


class SessionCreated(BaseModel):
    session_id: uuid.UUID
    # The bearer token, shown once. The client sends it as `Authorization: Bearer <token>`;
    # the server keeps only its hash. Never placed in a URL or logged.
    token: str


@router.post("", operation_id="ghost_create_session", response_model=SessionCreated, summary="Create an anonymous demo session")
async def create_session() -> SessionCreated:
    async with get_session_maker()() as session:
        async with session.begin():
            row, token = await ghost_db.create_session(session)
    return SessionCreated(session_id=row.id, token=token)


# This endpoint is the group's single anonymous entry point; _auth.ghost_credential checks the marker.
setattr(create_session, ANONYMOUS_MARKER, True)
