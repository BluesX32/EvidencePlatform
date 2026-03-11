"""LLM screening endpoints.

Prefix: /projects/{project_id}/llm-screening

GET  /estimate                              → estimated cost/time
POST /runs                                  → create and launch a run
GET  /runs                                  → list runs (newest first)
GET  /runs/{run_id}                        → single run with progress %
GET  /runs/{run_id}/results                → paginated results
POST /runs/{run_id}/results/{result_id}/review → mark reviewed
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.llm_screening import LlmScreeningResult, LlmScreeningRun
from app.models.project import Project
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.team_repo import TeamRepo
from app.services import llm_screening_service as svc

router = APIRouter(tags=["llm_screening"])


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

# Roles allowed to VIEW LLM results (any team member)
_VIEW_ROLES = frozenset({"owner", "admin", "reviewer", "observer"})
# Roles allowed to TRIGGER a run (costs money — owner/admin only)
_RUN_ROLES = frozenset({"owner", "admin"})


async def _require_project(
    project_id: str,
    db: AsyncSession,
    user: User,
    min_roles: frozenset = _VIEW_ROLES,
) -> Project:
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        raise HTTPException(400, "Invalid project_id")
    role = await ProjectRepo.user_role(db, pid, user.id)
    if role is None:
        raise HTTPException(404, "Project not found")
    if role not in min_roles:
        raise HTTPException(403, "Forbidden")
    row: Optional[Project] = await db.get(Project, pid)
    return row  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------


class EstimateResponse(BaseModel):
    total_records: int
    estimated_input_tokens: int
    estimated_output_tokens: int
    estimated_cost_usd: float
    estimated_minutes: float
    model: str
    cost_breakdown: dict[str, float]


class LlmRunResponse(BaseModel):
    id: str
    project_id: str
    status: str
    model: str
    total_records: Optional[int]
    processed_records: int
    included_count: int
    excluded_count: int
    uncertain_count: int
    new_concepts_count: int
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: Optional[float]
    actual_cost_usd: Optional[float]
    error_message: Optional[str]
    started_at: Optional[str]
    completed_at: Optional[str]
    created_at: str
    triggered_by: Optional[str]
    progress_pct: float


class LlmResultResponse(BaseModel):
    id: str
    run_id: str
    project_id: str
    record_id: Optional[str]
    cluster_id: Optional[str]
    ta_decision: Optional[str]
    ta_reason: Optional[str]
    ft_decision: Optional[str]
    ft_reason: Optional[str]
    matched_codes: Optional[Any]
    new_concepts: Optional[Any]
    full_text_source: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    model: Optional[str]
    reviewed_by: Optional[str]
    reviewed_at: Optional[str]
    review_action: Optional[str]
    created_at: str


class CreateRunBody(BaseModel):
    model: str = "claude-sonnet-4-6"


class ReviewBody(BaseModel):
    action: str  # accepted / rejected / merged


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _run_to_response(run: LlmScreeningRun) -> LlmRunResponse:
    processed = run.processed_records or 0
    total = run.total_records or 0
    progress = (processed / total * 100.0) if total > 0 else 0.0

    def _dec(val: Optional[Decimal]) -> Optional[float]:
        return float(val) if val is not None else None

    def _dt(val: Optional[datetime]) -> Optional[str]:
        return val.isoformat() if val is not None else None

    return LlmRunResponse(
        id=str(run.id),
        project_id=str(run.project_id),
        status=run.status,
        model=run.model,
        total_records=run.total_records,
        processed_records=processed,
        included_count=run.included_count or 0,
        excluded_count=run.excluded_count or 0,
        uncertain_count=run.uncertain_count or 0,
        new_concepts_count=run.new_concepts_count or 0,
        input_tokens=run.input_tokens or 0,
        output_tokens=run.output_tokens or 0,
        estimated_cost_usd=_dec(run.estimated_cost_usd),
        actual_cost_usd=_dec(run.actual_cost_usd),
        error_message=run.error_message,
        started_at=_dt(run.started_at),
        completed_at=_dt(run.completed_at),
        created_at=run.created_at.isoformat(),
        triggered_by=str(run.triggered_by) if run.triggered_by else None,
        progress_pct=round(progress, 1),
    )


def _result_to_response(res: LlmScreeningResult) -> LlmResultResponse:
    def _dt(val: Optional[datetime]) -> Optional[str]:
        return val.isoformat() if val is not None else None

    return LlmResultResponse(
        id=str(res.id),
        run_id=str(res.run_id),
        project_id=str(res.project_id),
        record_id=str(res.record_id) if res.record_id else None,
        cluster_id=str(res.cluster_id) if res.cluster_id else None,
        ta_decision=res.ta_decision,
        ta_reason=res.ta_reason,
        ft_decision=res.ft_decision,
        ft_reason=res.ft_reason,
        matched_codes=res.matched_codes,
        new_concepts=res.new_concepts,
        full_text_source=res.full_text_source,
        input_tokens=res.input_tokens,
        output_tokens=res.output_tokens,
        model=res.model,
        reviewed_by=str(res.reviewed_by) if res.reviewed_by else None,
        reviewed_at=_dt(res.reviewed_at),
        review_action=res.review_action,
        created_at=res.created_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/estimate",
    response_model=EstimateResponse,
)
async def estimate(
    project_id: str,
    model: str = Query(default="claude-sonnet-4-6"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EstimateResponse:
    """Return estimated cost and time for an LLM screening run."""
    project = await _require_project(project_id, db, user)
    data = await svc.estimate_run(db, project.id, model)
    return EstimateResponse(model=model, **data)


@router.post(
    "/projects/{project_id}/llm-screening/runs",
    response_model=LlmRunResponse,
    status_code=201,
)
async def create_run(
    project_id: str,
    body: CreateRunBody,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    x_anthropic_api_key: Optional[str] = Header(default=None, alias="X-Anthropic-Api-Key"),
    x_openrouter_api_key: Optional[str] = Header(default=None, alias="X-Openrouter-Api-Key"),
) -> LlmRunResponse:
    """Create and launch an LLM screening run (admin/owner only — incurs API cost)."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    # Require at least one LLM provider key (header key OR env var).
    effective_anthropic = x_anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
    effective_openrouter = x_openrouter_api_key or os.environ.get("OPENROUTER_API_KEY")
    is_claude = body.model.startswith("claude-")

    if is_claude and not effective_anthropic and not effective_openrouter:
        raise HTTPException(
            400,
            "No API key configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, "
            "or enter a key in the LLM Screening settings.",
        )
    if not is_claude and not effective_openrouter:
        raise HTTPException(
            400,
            "OPENROUTER_API_KEY is required for non-Claude models. "
            "Get a key at https://openrouter.ai/keys",
        )

    run = await svc.create_and_launch_run(
        db=db,
        project_id=project.id,
        model=body.model,
        triggered_by=user.id,
        background_tasks=background_tasks,
        anthropic_api_key=x_anthropic_api_key,
        openrouter_api_key=x_openrouter_api_key,
    )
    return _run_to_response(run)


@router.get(
    "/projects/{project_id}/llm-screening/runs",
    response_model=list[LlmRunResponse],
)
async def list_runs(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[LlmRunResponse]:
    """List all LLM screening runs for a project, newest first."""
    project = await _require_project(project_id, db, user)
    runs = (
        await db.execute(
            select(LlmScreeningRun)
            .where(LlmScreeningRun.project_id == project.id)
            .order_by(LlmScreeningRun.created_at.desc())
        )
    ).scalars().all()
    return [_run_to_response(r) for r in runs]


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}",
    response_model=LlmRunResponse,
)
async def get_run(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LlmRunResponse:
    """Get a single LLM screening run with progress percentage."""
    project = await _require_project(project_id, db, user)
    try:
        rid = uuid.UUID(run_id)
    except ValueError:
        raise HTTPException(400, "Invalid run_id")
    run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, rid)
    if run is None or run.project_id != project.id:
        raise HTTPException(404, "Run not found")
    return _run_to_response(run)


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}/results",
    response_model=dict,
)
async def list_results(
    project_id: str,
    run_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    ta_decision: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return paginated LLM screening results for a run.

    Optional query param: ta_decision (include/exclude/uncertain)
    """
    project = await _require_project(project_id, db, user)
    try:
        rid = uuid.UUID(run_id)
    except ValueError:
        raise HTTPException(400, "Invalid run_id")

    # Validate run belongs to project
    run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, rid)
    if run is None or run.project_id != project.id:
        raise HTTPException(404, "Run not found")

    stmt = select(LlmScreeningResult).where(LlmScreeningResult.run_id == rid)
    if ta_decision:
        stmt = stmt.where(LlmScreeningResult.ta_decision == ta_decision)

    stmt = stmt.order_by(LlmScreeningResult.created_at)
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size)

    results = (await db.execute(stmt)).scalars().all()

    # Count total for pagination
    from sqlalchemy import func as sqlfunc

    count_stmt = select(sqlfunc.count()).select_from(LlmScreeningResult).where(
        LlmScreeningResult.run_id == rid
    )
    if ta_decision:
        count_stmt = count_stmt.where(LlmScreeningResult.ta_decision == ta_decision)
    total: int = (await db.execute(count_stmt)).scalar_one()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [_result_to_response(r) for r in results],
    }


@router.post(
    "/projects/{project_id}/llm-screening/runs/{run_id}/results/{result_id}/review",
)
async def review_result(
    project_id: str,
    run_id: str,
    result_id: str,
    body: ReviewBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LlmResultResponse:
    """Mark an LLM screening result as reviewed."""
    project = await _require_project(project_id, db, user)

    if body.action not in ("accepted", "rejected", "merged"):
        raise HTTPException(400, "action must be one of: accepted, rejected, merged")

    try:
        res_id = uuid.UUID(result_id)
    except ValueError:
        raise HTTPException(400, "Invalid result_id")

    res: Optional[LlmScreeningResult] = await db.get(LlmScreeningResult, res_id)
    if res is None or res.project_id != project.id:
        raise HTTPException(404, "Result not found")

    res.reviewed_by = user.id
    res.reviewed_at = datetime.utcnow()
    res.review_action = body.action

    await db.commit()
    await db.refresh(res)
    return _result_to_response(res)
