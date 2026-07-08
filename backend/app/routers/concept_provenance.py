"""Concept provenance export endpoint (implementation-audit P0.8).

GET /projects/{id}/concept-provenance/export → one machine-readable bundle
joining extraction rows, concept mentions, canonical mappings, the
transformation-event ledger, and ontology mappings — per article/cluster, or
project-wide when no record_id/cluster_id is given.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE, ADMIN_ROLE
from app.models.user import User
from app.services.concept_provenance_service import build_provenance_export

router = APIRouter(prefix="/projects/{project_id}/concept-provenance", tags=["concept_provenance"])


@router.get("/export")
async def export_provenance(
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID] = Query(None),
    cluster_id: Optional[uuid.UUID] = Query(None),
    as_reviewer_id: Optional[uuid.UUID] = Query(None, description="Admin only: scope to one reviewer"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    role = await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)
    if as_reviewer_id and role in ADMIN_ROLE:
        reviewer_id = as_reviewer_id
    elif role in ADMIN_ROLE:
        reviewer_id = None
    else:
        reviewer_id = current_user.id
    return await build_provenance_export(
        db, project_id, record_id=record_id, cluster_id=cluster_id, reviewer_id=reviewer_id
    )
