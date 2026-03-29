"""
Direct screening API endpoints (migration 009+).

All endpoints are scoped under /projects/{project_id}/screening.

GET  /sources     → ScreeningSource[] (source list with stats for modal)
GET  /next        → ?source_id=<uuid|all>&mode=screen|fulltext|extract|mixed&strategy=sequential|mixed
POST /decisions   → {record_id?, cluster_id?, stage, decision, reason_code?, notes?, strategy?}
GET  /decisions   → ?stage=TA|FT
POST /extractions → {record_id?, cluster_id?, extracted_json}
GET  /extractions → ExtractionRecord[]
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.extraction_record import ExtractionRecord
from app.models.screening_decision import ScreeningDecision
from app.models.source import Source
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.team_repo import TeamRepo
from app.models.screening_queue import ScreeningQueue
from app.services.direct_screening_service import (
    get_item_by_key,
    get_next_item,
    get_or_create_queue,
    get_project_sources_with_stats,
    get_queue_list_summary,
    get_queue_slot,
    get_saturation,
    get_saturation_papers,
    list_queues_for_project,
    reset_queue,
    submit_decision,
    submit_extraction,
)

router = APIRouter(prefix="/projects/{project_id}/screening", tags=["screening"])
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

async def _require_project(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    """Allow owner, admin, and reviewer roles to use screening endpoints.

    Observers are read-only (viewing records) and cannot screen.
    """
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.created_by == current_user.id:
        return project
    member = await TeamRepo.get_member(db, project_id, current_user.id)
    if member is None:
        raise HTTPException(status_code=403, detail="Not a project member")
    if member.role == "observer":
        raise HTTPException(status_code=403, detail="Observers cannot screen items")
    return project


async def _validate_source(
    source_id_str: str,
    project_id: uuid.UUID,
    db: AsyncSession,
) -> uuid.UUID:
    """Parse and validate source_id belongs to the project. Returns the source UUID."""
    try:
        source_uuid = uuid.UUID(source_id_str)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_SOURCE", "message": f"Invalid source_id: {source_id_str!r}"},
        )
    row = await db.execute(
        select(Source).where(Source.id == source_uuid, Source.project_id == project_id)
    )
    if row.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_SOURCE",
                    "message": "source_id does not belong to this project"},
        )
    return source_uuid


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
    strategy: str = "sequential"   # "sequential" | "mixed"


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


_VALID_BUCKETS = frozenset({
    "ta_unscreened", "ta_included",
    "ft_pending", "ft_included",
    "extract_pending", "extract_done",
})


@router.get("/next")
async def next_item(
    project_id: uuid.UUID,
    source_id: Optional[str] = Query(None, description="UUID or 'all'"),
    mode: str = Query("screen", description="screen | fulltext | extract | mixed"),
    strategy: str = Query("sequential", description="sequential | mixed"),
    bucket: Optional[str] = Query(
        None,
        description="ta_unscreened|ta_included|ft_pending|ft_included|extract_pending|extract_done",
    ),
    randomize: bool = Query(False, description="Use ORDER BY RANDOM() instead of created_at"),
    seed: Optional[int] = Query(None, description="Seed for reproducible randomization"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Return the next available item for the given mode/strategy/bucket and source.

    bucket overrides mode when provided.
    strategy=mixed overrides mode to 'mixed' regardless of the mode param.
    Inserts a soft-lock claim before returning.
    """
    await _require_project(project_id, current_user, db)

    if bucket is not None and bucket not in _VALID_BUCKETS:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_BUCKET", "message": f"Unknown bucket: {bucket!r}"},
        )

    # strategy=mixed always uses mixed CTE regardless of mode param (unless bucket set)
    effective_mode = "mixed" if (strategy == "mixed" and bucket is None) else mode

    if bucket is None and effective_mode not in ("screen", "fulltext", "extract", "mixed"):
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_MODE",
                    "message": "mode must be screen, fulltext, extract, or mixed"},
        )

    # Validate source_id if provided and not "all"
    effective_source: Optional[str] = source_id
    if source_id and source_id not in ("all",):
        await _validate_source(source_id, project_id, db)
        effective_source = source_id

    logger.info(
        "/next project=%s source=%s mode=%s strategy=%s bucket=%s user=%s",
        project_id, source_id, mode, strategy, bucket, current_user.id,
    )

    try:
        result = await get_next_item(
            db,
            project_id=project_id,
            source_id=effective_source or "all",
            mode=effective_mode,
            reviewer_id=current_user.id,
            bucket=bucket,
            randomize=randomize,
            seed=seed,
        )
        await db.commit()
        logger.info(
            "/next done=%s remaining=%s",
            result.get("done"), result.get("remaining"),
        )
        return result
    except HTTPException:
        raise
    except Exception:
        logger.exception("/next unhandled error project=%s source=%s mode=%s bucket=%s",
                         project_id, source_id, effective_mode, bucket)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "SERVER_ERROR", "message": "Failed to fetch next item"}},
        )


@router.get("/item")
async def get_item(
    project_id: uuid.UUID,
    record_id: Optional[str] = Query(None),
    cluster_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Fetch a specific item by record_id or cluster_id without creating a lock.

    Used by the back/forward navigation to re-fetch historical items with
    the latest decisions.
    """
    await _require_project(project_id, current_user, db)

    if record_id is None and cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Provide record_id or cluster_id"
        )
    if record_id is not None and cluster_id is not None:
        raise HTTPException(
            status_code=422, detail="Provide record_id OR cluster_id, not both"
        )

    try:
        rec_uuid = uuid.UUID(record_id) if record_id else None
        clu_uuid = uuid.UUID(cluster_id) if cluster_id else None
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid UUID")

    result = await get_item_by_key(
        db,
        project_id=project_id,
        record_id=rec_uuid,
        cluster_id=clu_uuid,
        reviewer_id=current_user.id,
    )
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
        auto_ta_include=(body.strategy == "mixed"),
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
    record_id: Optional[uuid.UUID] = Query(None),
    cluster_id: Optional[uuid.UUID] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)

    stmt = (
        select(ExtractionRecord)
        .where(ExtractionRecord.project_id == project_id)
    )
    if record_id is not None:
        stmt = stmt.where(ExtractionRecord.record_id == record_id)
    elif cluster_id is not None:
        stmt = stmt.where(ExtractionRecord.cluster_id == cluster_id)

    rows = await db.execute(stmt.order_by(ExtractionRecord.created_at))
    extractions = rows.scalars().all()
    return [_extraction_out(e) for e in extractions]


# ---------------------------------------------------------------------------
# Screening queue endpoints
# ---------------------------------------------------------------------------


@router.post("/queue", status_code=200)
async def create_or_get_queue(
    project_id: uuid.UUID,
    source: str = Query("all"),
    stage: str = Query("screen"),
    seed: Optional[int] = Query(None),
    reset: bool = Query(False, description="Force re-randomize even if queue exists"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create (or get) the screening queue for this reviewer. reset=True forces new randomization."""
    await _require_project(project_id, current_user, db)
    if reset:
        queue = await reset_queue(db, project_id, current_user.id, source, stage, seed)
    else:
        queue = await get_or_create_queue(db, project_id, current_user.id, source, stage, seed)
    await db.commit()
    return {
        "seed": queue.seed,
        "source_id": queue.source_id,
        "stage": queue.stage,
        "position": queue.position,
        "total": len(queue.slots),
        "created_at": queue.created_at.isoformat(),
    }


@router.get("/queue")
async def get_queue_info(
    project_id: uuid.UUID,
    source: str = Query("all"),
    stage: str = Query("screen"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get current queue info for this reviewer."""
    await _require_project(project_id, current_user, db)
    result = await db.execute(
        select(ScreeningQueue).where(
            ScreeningQueue.project_id == project_id,
            ScreeningQueue.reviewer_id == current_user.id,
            ScreeningQueue.source_id == source,
            ScreeningQueue.stage == stage,
        )
    )
    queue = result.scalar_one_or_none()
    if queue is None:
        return None
    return {
        "seed": queue.seed,
        "source_id": queue.source_id,
        "stage": queue.stage,
        "position": queue.position,
        "total": len(queue.slots),
        "created_at": queue.created_at.isoformat(),
    }


@router.get("/queue-history")
async def get_queue_history(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all queues for this project (seed history across all reviewers visible to this user)."""
    await _require_project(project_id, current_user, db)
    queues = await list_queues_for_project(db, project_id)
    return [
        {
            "seed": q.seed,
            "source_id": q.source_id,
            "stage": q.stage,
            "position": q.position,
            "total": len(q.slots),
            "reviewer_id": str(q.reviewer_id),
            "created_at": q.created_at.isoformat(),
        }
        for q in queues
    ]


@router.get("/queue-list")
async def get_queue_list(
    project_id: uuid.UUID,
    source: str = Query("all"),
    stage: str = Query("screen"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all queue slots seen so far with title, ta_decision, ft_decision (for side nav panel)."""
    await _require_project(project_id, current_user, db)
    return await get_queue_list_summary(db, project_id, current_user.id, source, stage)


@router.get("/queue-slot")
async def get_queue_slot_endpoint(
    project_id: uuid.UUID,
    source: str = Query("all"),
    stage: str = Query("screen"),
    position: int = Query(..., ge=1),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get paper metadata at a specific queue position (1-indexed). Only positions 1..current_position are accessible."""
    await _require_project(project_id, current_user, db)
    item = await get_queue_slot(db, project_id, current_user.id, source, stage, position)
    if item is None:
        raise HTTPException(status_code=404, detail="Queue slot not found")
    return item


# ---------------------------------------------------------------------------
# Saturation status
# ---------------------------------------------------------------------------


@router.get("/saturation")
async def get_saturation_status(
    project_id: uuid.UUID,
    threshold: int = Query(5, ge=1, le=50),
    source_id: Optional[uuid.UUID] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return consecutive_no_novelty count for the current reviewer.

    consecutive_no_novelty — number of most-recent extractions in a row where
    framework_updated=false.  Resets to 0 whenever framework_updated=true.
    saturated=true when count >= threshold (default 5).

    When source_id is provided, only extractions for that corpus are considered
    so the counter resets independently per corpus.
    """
    await _require_project(project_id, current_user, db)
    return await get_saturation(
        db,
        project_id=project_id,
        reviewer_id=current_user.id,
        threshold=threshold,
        source_id=source_id,
    )


@router.get("/saturation/papers")
async def get_saturation_papers_list(
    project_id: uuid.UUID,
    source_id: Optional[uuid.UUID] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the list of papers in the current consecutive no-novelty streak."""
    await _require_project(project_id, current_user, db)
    return await get_saturation_papers(
        db,
        project_id=project_id,
        reviewer_id=current_user.id,
        source_id=source_id,
    )


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
