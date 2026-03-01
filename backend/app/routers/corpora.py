"""
Corpora & Screening API endpoints — VS4.

All endpoints are scoped under /projects/{project_id}/corpora.

POST   /                                     create corpus
GET    /                                     list corpora
GET    /{corpus_id}                          corpus detail + saturation stats
POST   /{corpus_id}/queue/generate           generate (or re-generate) queue
GET    /{corpus_id}/queue/next               next pending item
POST   /{corpus_id}/queue/skip               skip current item (not useful now)
GET    /{corpus_id}/queue                    paginated queue list
POST   /{corpus_id}/decisions                submit TA or FT decision
GET    /{corpus_id}/decisions                list decisions
GET    /{corpus_id}/borderline               list borderline cases
POST   /{corpus_id}/borderline/{case_id}/resolve  resolve borderline
POST   /{corpus_id}/extractions              save extraction (triggers saturation)
GET    /{corpus_id}/extractions              list extractions
POST   /{corpus_id}/second-reviews           submit second review
"""
from __future__ import annotations

import math
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.corpus_repo import CorpusRepo
from app.repositories.project_repo import ProjectRepo
from app.repositories.screening_repo import ScreeningRepo
from app.services.screening_service import (
    generate_queue,
    get_next_item,
    skip_item,
    submit_decision,
    submit_extraction,
)

router = APIRouter(prefix="/projects/{project_id}/corpora", tags=["corpora"])


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


async def _require_corpus(
    corpus_id: uuid.UUID,
    project_id: uuid.UUID,
    db: AsyncSession,
):
    corpus = await CorpusRepo.get(db, corpus_id)
    if corpus is None or corpus.project_id != project_id:
        raise HTTPException(status_code=404, detail="Corpus not found")
    return corpus


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class CorpusCreate(BaseModel):
    name: str
    description: Optional[str] = None
    # Accept string UUIDs from the frontend and coerce them to uuid.UUID
    source_ids: List[uuid.UUID] = []
    saturation_threshold: int = 10

    @validator("source_ids", pre=True, each_item=True)
    def coerce_source_uuid(cls, v: Any) -> uuid.UUID:
        if isinstance(v, uuid.UUID):
            return v
        try:
            return uuid.UUID(str(v))
        except (ValueError, AttributeError):
            raise ValueError(f"Invalid UUID: {v!r}")


class GenerateQueueRequest(BaseModel):
    seed: Optional[int] = None


class SkipRequest(BaseModel):
    canonical_key: str


class DecisionCreate(BaseModel):
    canonical_key: str
    stage: str       # "TA" | "FT"
    decision: str    # "include" | "exclude" | "borderline"
    reason_code: Optional[str] = None
    notes: Optional[str] = None


class ResolveRequest(BaseModel):
    resolution_decision: str   # "include" | "exclude"
    resolution_notes: Optional[str] = None


class ExtractionCreate(BaseModel):
    canonical_key: str
    extracted_json: Dict[str, Any]
    # framework_updated is also stored inside extracted_json;
    # the service reads it from there.


class SecondReviewCreate(BaseModel):
    canonical_key: str
    stage: str    # "TA" | "FT" | "extraction"
    agree: bool
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Corpus CRUD
# ---------------------------------------------------------------------------

@router.post("/", status_code=201)
async def create_corpus(
    project_id: uuid.UUID,
    body: CorpusCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    corpus = await CorpusRepo.create(
        db,
        project_id=project_id,
        name=body.name,
        description=body.description,
        source_ids=body.source_ids,
        saturation_threshold=body.saturation_threshold,
    )
    await db.commit()
    await db.refresh(corpus)
    return _corpus_out(corpus)


@router.get("/")
async def list_corpora(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    corpora = await CorpusRepo.list_for_project(db, project_id)
    return [_corpus_out(c) for c in corpora]


@router.get("/{corpus_id}")
async def get_corpus(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    corpus = await _require_corpus(corpus_id, project_id, db)
    ta_decided = await ScreeningRepo.get_decided_keys(db, corpus_id, stage="TA")
    ta_included = await ScreeningRepo.list_included_keys(db, corpus_id, stage="TA")
    out = _corpus_out(corpus)
    out["ta_screened"] = len(ta_decided)
    out["ta_included"] = len(ta_included)
    return out


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------

@router.post("/{corpus_id}/queue/generate")
async def generate_queue_endpoint(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    body: GenerateQueueRequest = GenerateQueueRequest(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    corpus = await _require_corpus(corpus_id, project_id, db)
    result = await generate_queue(db, corpus, seed=body.seed)
    await db.commit()
    return result


@router.get("/{corpus_id}/queue/next")
async def next_queue_item(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    corpus = await _require_corpus(corpus_id, project_id, db)
    item = await get_next_item(db, corpus)
    if item is None:
        return {"done": True}
    return {"done": False, **item}


@router.post("/{corpus_id}/queue/skip")
async def skip_queue_item_endpoint(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    body: SkipRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark current item as skipped and return the next pending item."""
    await _require_project(project_id, current_user, db)
    corpus = await _require_corpus(corpus_id, project_id, db)
    result = await skip_item(db, corpus, body.canonical_key)
    await db.commit()
    if result["next"] is None:
        return {"skipped": result["skipped"], "done": True}
    return {"skipped": result["skipped"], "done": False, **result["next"]}


@router.get("/{corpus_id}/queue")
async def list_queue(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    await _require_corpus(corpus_id, project_id, db)
    total = await ScreeningRepo.count_queue(db, corpus_id)
    offset = (page - 1) * page_size
    items = await ScreeningRepo.get_queue_page(db, corpus_id, offset, page_size)
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, math.ceil(total / page_size)) if total else 1,
        "items": [
            {"canonical_key": i.canonical_key, "order_index": i.order_index, "status": i.status}
            for i in items
        ],
    }


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------

@router.post("/{corpus_id}/decisions", status_code=201)
async def create_decision(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    body: DecisionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    corpus = await _require_corpus(corpus_id, project_id, db)
    result = await submit_decision(
        db,
        corpus=corpus,
        canonical_key=body.canonical_key,
        stage=body.stage,
        decision=body.decision,
        reason_code=body.reason_code,
        notes=body.notes,
        reviewer_id=current_user.id,
    )
    await db.commit()
    return result


@router.get("/{corpus_id}/decisions")
async def list_decisions_endpoint(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    stage: Optional[str] = Query(None),
    canonical_key: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    await _require_corpus(corpus_id, project_id, db)
    decisions = await ScreeningRepo.list_decisions(
        db, corpus_id, stage=stage, canonical_key=canonical_key
    )
    return [_decision_out(d) for d in decisions]


# ---------------------------------------------------------------------------
# Borderline
# ---------------------------------------------------------------------------

@router.get("/{corpus_id}/borderline")
async def list_borderline_endpoint(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    status: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    await _require_corpus(corpus_id, project_id, db)
    cases = await ScreeningRepo.list_borderline(db, corpus_id, status=status)
    return [_borderline_out(c) for c in cases]


@router.post("/{corpus_id}/borderline/{case_id}/resolve")
async def resolve_borderline_endpoint(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    case_id: uuid.UUID,
    body: ResolveRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    await _require_corpus(corpus_id, project_id, db)
    case = await ScreeningRepo.get_borderline(db, case_id)
    if case is None or case.corpus_id != corpus_id:
        raise HTTPException(status_code=404, detail="Borderline case not found")
    case = await ScreeningRepo.resolve_borderline(
        db,
        case,
        resolution_decision=body.resolution_decision,
        resolution_notes=body.resolution_notes,
        resolved_by=current_user.id,
    )
    await db.commit()
    return _borderline_out(case)


# ---------------------------------------------------------------------------
# Extractions (saturation-first)
# ---------------------------------------------------------------------------

@router.post("/{corpus_id}/extractions", status_code=201)
async def create_extraction(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    body: ExtractionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Save an extraction for a canonical key.
    extracted_json must contain framework_updated (bool) and framework_update_note (str).
    Saturation counter is updated based on framework_updated.
    """
    await _require_project(project_id, current_user, db)
    corpus = await _require_corpus(corpus_id, project_id, db)
    result = await submit_extraction(
        db,
        corpus=corpus,
        canonical_key=body.canonical_key,
        extracted_json=body.extracted_json,
        reviewer_id=current_user.id,
    )
    await db.commit()
    return result


@router.get("/{corpus_id}/extractions")
async def list_extractions_endpoint(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    await _require_corpus(corpus_id, project_id, db)
    extractions = await ScreeningRepo.list_extractions(db, corpus_id)
    return [_extraction_out(e) for e in extractions]


# ---------------------------------------------------------------------------
# Second reviews
# ---------------------------------------------------------------------------

@router.post("/{corpus_id}/second-reviews", status_code=201)
async def create_second_review(
    project_id: uuid.UUID,
    corpus_id: uuid.UUID,
    body: SecondReviewCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project(project_id, current_user, db)
    await _require_corpus(corpus_id, project_id, db)
    row = await ScreeningRepo.insert_second_review(
        db,
        corpus_id=corpus_id,
        canonical_key=body.canonical_key,
        stage=body.stage,
        agree=body.agree,
        notes=body.notes,
        reviewer_id=current_user.id,
    )
    await db.commit()
    return {
        "id": row.id,
        "corpus_id": row.corpus_id,
        "canonical_key": row.canonical_key,
        "stage": row.stage,
        "agree": row.agree,
        "notes": row.notes,
        "reviewer_id": row.reviewer_id,
        "created_at": row.created_at,
    }


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _corpus_out(c) -> dict:
    return {
        "id": c.id,
        "project_id": c.project_id,
        "name": c.name,
        "description": c.description,
        "source_ids": [str(sid) for sid in (c.source_ids or [])],
        "saturation_threshold": c.saturation_threshold,
        "consecutive_no_novelty": c.consecutive_no_novelty,
        "total_extracted": c.total_extracted,
        "stopped_at": c.stopped_at,
        "queue_seed": c.queue_seed,
        "queue_generated_at": c.queue_generated_at,
        "queue_size": c.queue_size,
        "created_at": c.created_at,
    }


def _decision_out(d) -> dict:
    return {
        "id": d.id,
        "corpus_id": d.corpus_id,
        "canonical_key": d.canonical_key,
        "stage": d.stage,
        "decision": d.decision,
        "reason_code": d.reason_code,
        "notes": d.notes,
        "reviewer_id": d.reviewer_id,
        "created_at": d.created_at,
    }


def _borderline_out(c) -> dict:
    return {
        "id": c.id,
        "corpus_id": c.corpus_id,
        "canonical_key": c.canonical_key,
        "stage": c.stage,
        "status": c.status,
        "resolution_decision": c.resolution_decision,
        "resolution_notes": c.resolution_notes,
        "resolved_by": c.resolved_by,
        "resolved_at": c.resolved_at,
        "created_at": c.created_at,
    }


def _extraction_out(e) -> dict:
    return {
        "id": e.id,
        "corpus_id": e.corpus_id,
        "canonical_key": e.canonical_key,
        "extracted_json": e.extracted_json,
        "novelty_flag": e.novelty_flag,
        "novelty_notes": e.novelty_notes,
        "reviewer_id": e.reviewer_id,
        "created_at": e.created_at,
    }
