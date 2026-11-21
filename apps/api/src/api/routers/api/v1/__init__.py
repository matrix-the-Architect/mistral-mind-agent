"""Version 1 of the HTTP API.

Every route in this group requires a credential: the group access rule is
``_auth.ghost_credential``, which resolves the ``Authorization: Bearer`` token to either a session
principal or a deletion-capability principal (401 otherwise). Route modules then narrow it — the
relay and all memory routes require a session, the erasure routes require the deletion capability,
and only session bootstrap (``sessions/route.py``, marked anonymous on the endpoint itself) is
reachable without a header. The loader still fails closed for any subtree that declares nothing.
"""

from fastapi import params

from api.routers.api.v1._auth import ghost_credential

segment = "v1"

# The access rule, cascading to every module here: a valid bearer credential of either kind.
dependencies: tuple[params.Depends, ...] = (params.Depends(ghost_credential),)
