"""
Direct screening API endpoints (migration 009+).

All endpoints are scoped under /projects/{project_id}/screening.

GET  /sources     → ScreeningSource[] (source list with stats for modal)
GET  /next        → ?source_id=<uuid|all>&mode=screen|fulltext|extract
POST /decisions   → {record_id?, cluster_id?, stage, decision, reason_code?, notes?}
GET  /decisions   → ?stage=TA|FT
POST /extractions → {record_id?, cluster_id?, extracted_json}
GET  /extractions → ExtractionRecord[]
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.extraction_record import ExtractionRecord
from app.models.screening_decision import ScreeningDecision
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.services.direct_screening_service import (
    get_next_item,
    get_project_sources_with_stats,
    submit_decision,
    submit_extraction,
)

router = APIRouter(prefix="/projects/{project_id}/screening", tags=["screening"])


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

async def _require_project(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Forbidden")
    return project


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class DecisionCreate(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    stage: str         # "TA" | "FT"
    decision: str      # "include" | "exclude"
    reason_code: Optional[str] = None
    notes: Optional[str] = None


class ExtractionCreate(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    extracted_json: Dict[str, Any]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/sources")
async def list_sources_with_stats(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return sources with screening stats for StartScreeningModal."""
    await _require_project(project_id, current_user, db)
    return await get_project_sources_with_stats(db, project_id)


@router.get("/next")
async def next_item(
    project_id: uuid.UUID,
    source_id: Optional[str] = Query(None, description="UUID or 'all'"),
    mode: str = Query("screen", description="screen | fulltext | extract"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return the next available item for the given mode and source.

    Inserts a soft-lock claim before returning.  The current user is used as
    reviewer_id for dual-reviewer isolation.
    """
    await _require_project(project_id, current_user, db)

    if mode not in ("screen", "fulltext", "extract"):
        raise HTTPException(status_code=422, detail="mode must be screen, fulltext, or extract")

    result = await get_next_item(
        db,
        project_id=project_id,
        source_id=source_id or "all",
        mode=mode,
        reviewer_id=current_user.id,
    )
    await db.commit()
    return result


@router.post("/decisions", status_code=201)
async def create_decision(
    project_id: uuid.UUID,
    body: DecisionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit a TA or FT screening decision and release the soft lock."""
    await _require_project(project_id, current_user, db)

    if body.record_id is None and body.cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Exactly one of record_id or cluster_id is required"
        )
    if body.record_id is not None and body.cluster_id is not None:
        raise HTTPException(
            status_code=422, detail="Provide record_id OR cluster_id, not both"
        )
    if body.stage not in ("TA", "FT"):
        raise HTTPException(status_code=422, detail="stage must be TA or FT")
    if body.decision not in ("include", "exclude"):
        raise HTTPException(status_code=422, detail="decision must be include or exclude")

    result = await submit_decision(
        db,
        project_id=project_id,
        record_id=body.record_id,
        cluster_id=body.cluster_id,
        stage=body.stage,
        decision=body.decision,
        reason_code=body.reason_code,
        notes=body.notes,
        reviewer_id=current_user.id,
    )
    await db.commit()
    return result


@router.get("/decisions")
async def list_decisions(
    project_id: uuid.UUID,
    stage: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)

    q = select(ScreeningDecision).where(ScreeningDecision.project_id == project_id)
    if stage:
        q = q.where(ScreeningDecision.stage == stage)
    q = q.order_by(ScreeningDecision.created_at)

    rows = await db.execute(q)
    decisions = rows.scalars().all()
    return [_decision_out(d) for d in decisions]


@router.post("/extractions", status_code=201)
async def create_extraction(
    project_id: uuid.UUID,
    body: ExtractionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Save (upsert) an extraction record."""
    await _require_project(project_id, current_user, db)

    if body.record_id is None and body.cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Exactly one of record_id or cluster_id is required"
        )
    if body.record_id is not None and body.cluster_id is not None:
        raise HTTPException(
            status_code=422, detail="Provide record_id OR cluster_id, not both"
        )

    result = await submit_extraction(
        db,
        project_id=project_id,
        record_id=body.record_id,
        cluster_id=body.cluster_id,
        extracted_json=body.extracted_json,
        reviewer_id=current_user.id,
    )
    await db.commit()
    return result


@router.get("/extractions")
async def list_extractions(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)

    rows = await db.execute(
        select(ExtractionRecord)
        .where(ExtractionRecord.project_id == project_id)
        .order_by(ExtractionRecord.created_at)
    )
    extractions = rows.scalars().all()
    return [_extraction_out(e) for e in extractions]


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _decision_out(d: ScreeningDecision) -> dict:
    return {
        "id": str(d.id),
        "project_id": str(d.project_id),
        "record_id": str(d.record_id) if d.record_id else None,
        "cluster_id": str(d.cluster_id) if d.cluster_id else None,
        "stage": d.stage,
        "decision": d.decision,
        "reason_code": d.reason_code,
        "notes": d.notes,
        "reviewer_id": str(d.reviewer_id) if d.reviewer_id else None,
        "created_at": d.created_at,
    }


def _extraction_out(e: ExtractionRecord) -> dict:
    return {
        "id": str(e.id),
        "project_id": str(e.project_id),
        "record_id": str(e.record_id) if e.record_id else None,
        "cluster_id": str(e.cluster_id) if e.cluster_id else None,
        "extracted_json": e.extracted_json,
        "reviewer_id": str(e.reviewer_id) if e.reviewer_id else None,
        "created_at": e.created_at,
    }
