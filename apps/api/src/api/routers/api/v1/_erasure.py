"""Shared shaping of the erasure result response (private helper for the erasure route modules)."""

from db.models.ghost_memory import GhostErasure, GhostNamespace

from api.routers.api.v1._schemas import ErasureResultOut


def result_out(erasure: GhostErasure, namespace: GhostNamespace, *, artifacts_remaining: int) -> ErasureResultOut:
    return ErasureResultOut(
        namespace_id=erasure.namespace_id,
        status=erasure.status,
        artifacts_removed=erasure.artifacts_removed,
        artifacts_remaining=artifacts_remaining,
        idempotency_key=erasure.idempotency_key,
        requested_at=erasure.requested_at.isoformat(),
        completed_at=erasure.completed_at.isoformat(),
        namespace_state=namespace.state,
        revoked_at=namespace.revoked_at.isoformat() if namespace.revoked_at else None,
    )
