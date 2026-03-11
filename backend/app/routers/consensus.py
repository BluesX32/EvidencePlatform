"""Consensus and inter-rater reliability endpoints.

All endpoints scoped under /projects/{project_id}/consensus.

GET  /conflicts              — list unresolved conflicts (any member)
GET  /resolved               — list adjudicated decisions (any member)
POST /adjudicate             — submit adjudication (admin/owner)
GET  /reliability            — Cohen's kappa + % agreement (any member)
GET  /stats                  — per-reviewer screening progress (any member)
GET  /team-decisions/{item_id} — all reviewer decisions for one item (any member)
"""
from __future__ import annotations

import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.consensus_decision import ConsensusDecision
from app.models.screening_decision import ScreeningDecision
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.team_repo import TeamRepo
from app.services.consensus_service import (
    adjudicate,
    compute_reliability,
    detect_conflicts,
    team_screening_stats,
)

router = APIRouter(prefix="/projects/{project_id}/consensus", tags=["consensus"])


# ── Access helpers ────────────────────────────────────────────────────────────

async def _require_any_member(project_id, current_user, db):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.created_by == current_user.id:
        return project
    member = await TeamRepo.get_member(db, project_id, current_user.id)
    if member is None:
        raise HTTPException(status_code=403, detail="Not a project member")
    return project


async def _require_admin(project_id, current_user, db):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.created_by == current_user.id:
        return project
    member = await TeamRepo.get_member(db, project_id, current_user.id)
    if member is None or member.role not in ("admin",):
        raise HTTPException(status_code=403, detail="Admin access required")
    return project


# ── Schemas ───────────────────────────────────────────────────────────────────

class AdjudicateRequest(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    stage: str           # TA | FT
    decision: str        # include | exclude
    reason_code: Optional[str] = None
    notes: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/conflicts")
async def list_conflicts(
    project_id: uuid.UUID,
    stage: Optional[str] = Query(None, description="TA | FT"),
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    """Return all items where reviewers disagree (unresolved)."""
    await _require_any_member(project_id, current_user, db)
    conflicts = await detect_conflicts(db, project_id, stage=stage, only_unresolved=True)
    return conflicts


@router.get("/resolved")
async def list_resolved(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    """Return all adjudicated consensus decisions."""
    await _require_any_member(project_id, current_user, db)
    rows = await db.execute(
        select(ConsensusDecision)
        .where(ConsensusDecision.project_id == project_id)
        .order_by(ConsensusDecision.created_at.desc())
    )
    decisions = rows.scalars().all()
    return [_consensus_out(c) for c in decisions]


@router.post("/adjudicate", status_code=201)
async def adjudicate_conflict(
    project_id: uuid.UUID,
    body: AdjudicateRequest,
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    """Admin/owner submits a final adjudication decision for a conflict."""
    await _require_admin(project_id, current_user, db)

    if body.record_id is None and body.cluster_id is None:
        raise HTTPException(status_code=422, detail="Provide record_id or cluster_id")
    if body.record_id and body.cluster_id:
        raise HTTPException(status_code=422, detail="Provide record_id OR cluster_id, not both")
    if body.stage not in ("TA", "FT"):
        raise HTTPException(status_code=422, detail="stage must be TA or FT")
    if body.decision not in ("include", "exclude"):
        raise HTTPException(status_code=422, detail="decision must be include or exclude")

    consensus = await adjudicate(
        db,
        project_id=project_id,
        record_id=body.record_id,
        cluster_id=body.cluster_id,
        stage=body.stage,
        decision=body.decision,
        adjudicator_id=current_user.id,
        reason_code=body.reason_code,
        notes=body.notes,
    )
    await db.commit()
    return _consensus_out(consensus)


@router.get("/reliability")
async def get_reliability(
    project_id: uuid.UUID,
    stage: Optional[str] = Query(None, description="TA | FT"),
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    """Inter-rater reliability: % agreement and Cohen's kappa per reviewer pair."""
    await _require_any_member(project_id, current_user, db)
    return await compute_reliability(db, project_id, stage=stage)


@router.get("/stats")
async def get_team_stats(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    """Per-reviewer screening progress (TA include/exclude, FT include/exclude, extractions)."""
    await _require_any_member(project_id, current_user, db)
    return await team_screening_stats(db, project_id)


@router.get("/team-decisions")
async def get_team_decisions_for_item(
    project_id: uuid.UUID,
    record_id: Optional[str] = Query(None),
    cluster_id: Optional[str] = Query(None),
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    """Return all reviewer decisions for a specific item (for sidebar comparison)."""
    await _require_any_member(project_id, current_user, db)

    if record_id is None and cluster_id is None:
        raise HTTPException(status_code=422, detail="Provide record_id or cluster_id")

    try:
        rec_uuid = uuid.UUID(record_id) if record_id else None
        clu_uuid = uuid.UUID(cluster_id) if cluster_id else None
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid UUID")

    q = select(ScreeningDecision).where(ScreeningDecision.project_id == project_id)
    if rec_uuid:
        q = q.where(ScreeningDecision.record_id == rec_uuid)
    else:
        q = q.where(ScreeningDecision.cluster_id == clu_uuid)

    rows = await db.execute(q.order_by(ScreeningDecision.stage, ScreeningDecision.created_at))
    decisions = rows.scalars().all()

    # Fetch reviewer names
    reviewer_ids = {d.reviewer_id for d in decisions if d.reviewer_id}
    names: dict = {}
    if reviewer_ids:
        from app.models.user import User as UserModel
        user_rows = await db.execute(
            select(UserModel.id, UserModel.name, UserModel.email).where(UserModel.id.in_(reviewer_ids))
        )
        for uid, name, email in user_rows:
            names[str(uid)] = name or email

    # Check for consensus decision
    consensus_row = None
    if rec_uuid or clu_uuid:
        filter_col = ConsensusDecision.record_id if rec_uuid else ConsensusDecision.cluster_id
        item_uuid = rec_uuid or clu_uuid
        cr = await db.execute(
            select(ConsensusDecision).where(
                ConsensusDecision.project_id == project_id,
                filter_col == item_uuid,
            )
        )
        consensus_rows = cr.scalars().all()
        if consensus_rows:
            consensus_row = [_consensus_out(c) for c in consensus_rows]

    return {
        "decisions": [
            {
                "id": str(d.id),
                "stage": d.stage,
                "decision": d.decision,
                "reason_code": d.reason_code,
                "notes": d.notes,
                "reviewer_id": str(d.reviewer_id) if d.reviewer_id else None,
                "reviewer_name": names.get(str(d.reviewer_id), "Unknown") if d.reviewer_id else None,
                "created_at": d.created_at.isoformat(),
            }
            for d in decisions
        ],
        "consensus": consensus_row,
    }


# ── Serialisation helpers ─────────────────────────────────────────────────────

def _consensus_out(c: ConsensusDecision) -> dict:
    return {
        "id": str(c.id),
        "project_id": str(c.project_id),
        "record_id": str(c.record_id) if c.record_id else None,
        "cluster_id": str(c.cluster_id) if c.cluster_id else None,
        "stage": c.stage,
        "decision": c.decision,
        "reason_code": c.reason_code,
        "notes": c.notes,
        "adjudicator_id": str(c.adjudicator_id) if c.adjudicator_id else None,
        "created_at": c.created_at.isoformat(),
    }