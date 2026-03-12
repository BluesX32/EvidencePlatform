"""Anchored annotation endpoints (Sprint 14 / migration 012).

POST   /projects/{project_id}/annotations           → 201 Annotation
GET    /projects/{project_id}/annotations           → Annotation[]  (?record_id=|cluster_id=)
DELETE /projects/{project_id}/annotations/{ann_id} → 204
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE
from app.models.annotation import Annotation
from app.models.user import User
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects/{project_id}/annotations", tags=["annotations"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _require_project(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, project_id)
    return project


def _ann_out(a: Annotation) -> Dict[str, Any]:
    return {
        "id": str(a.id),
        "project_id": str(a.project_id),
        "record_id": str(a.record_id) if a.record_id else None,
        "cluster_id": str(a.cluster_id) if a.cluster_id else None,
        "selected_text": a.selected_text,
        "comment": a.comment,
        "reviewer_id": str(a.reviewer_id) if a.reviewer_id else None,
        "created_at": a.created_at,
    }


# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------


class AnnotationCreate(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    selected_text: str
    comment: str = ""


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("", status_code=201)
async def create_annotation(
    project_id: uuid.UUID,
    body: AnnotationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new anchored annotation for a record or cluster."""
    await _require_project(project_id, current_user, db)

    if body.record_id is None and body.cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Exactly one of record_id or cluster_id is required"
        )
    if body.record_id is not None and body.cluster_id is not None:
        raise HTTPException(
            status_code=422, detail="Provide record_id OR cluster_id, not both"
        )
    if not body.selected_text.strip() and not body.comment.strip():
        raise HTTPException(
            status_code=422, detail="At least one of selected_text or comment must not be empty"
        )

    ann = Annotation(
        project_id=project_id,
        record_id=body.record_id,
        cluster_id=body.cluster_id,
        selected_text=body.selected_text,
        comment=body.comment,
        reviewer_id=current_user.id,
    )
    db.add(ann)
    await db.flush()
    await db.commit()
    return _ann_out(ann)


@router.get("")
async def list_annotations(
    project_id: uuid.UUID,
    record_id: Optional[str] = None,
    cluster_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Return annotations for a project, optionally filtered by record or cluster."""
    await _require_project(project_id, current_user, db)

    q = select(Annotation).where(Annotation.project_id == project_id)

    if record_id:
        try:
            q = q.where(Annotation.record_id == uuid.UUID(record_id))
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid record_id")
    elif cluster_id:
        try:
            q = q.where(Annotation.cluster_id == uuid.UUID(cluster_id))
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid cluster_id")

    q = q.order_by(Annotation.created_at)
    rows = await db.execute(q)
    return [_ann_out(a) for a in rows.scalars().all()]


@router.delete("/{ann_id}", status_code=204)
async def delete_annotation(
    project_id: uuid.UUID,
    ann_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete an annotation. Only the creating reviewer or project owner may delete."""
    await _require_project(project_id, current_user, db)

    row = await db.execute(
        select(Annotation).where(
            Annotation.id == ann_id,
            Annotation.project_id == project_id,
        )
    )
    ann = row.scalar_one_or_none()
    if ann is None:
        raise HTTPException(status_code=404, detail="Annotation not found")

    await db.delete(ann)
    await db.commit()
