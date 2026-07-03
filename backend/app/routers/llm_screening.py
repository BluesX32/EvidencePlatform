"""LLM screening endpoints.

Prefix: /projects/{project_id}/llm-screening

GET  /estimate                              → estimated cost/time
POST /runs                                  → create and launch a run
GET  /runs                                  → list runs (newest first)
GET  /runs/{run_id}                        → single run with progress %
GET  /runs/{run_id}/results                → paginated results
POST /runs/{run_id}/results/{result_id}/review → mark reviewed
GET  /runs/{run_id}/export                 → CSV download
GET  /runs/{run_id}/comparison             → compare LLM vs human decisions
POST /runs/{run_id}/send-to-consensus      → flag disagreements in consensus table
GET  /preview-prompt                       → preview resolved prompt for a sample record

GET  /projects/{project_id}/llm-config     → get LLM prompt config
PATCH /projects/{project_id}/llm-config    → save LLM prompt config
"""
from __future__ import annotations

import csv
import io
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import Integer, case, func as sqlfunc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE
from app.models.fulltext_pdf import FulltextPdf
from app.models.llm_screening import LlmScreeningResult, LlmScreeningRun
from app.models.ontology_node import OntologyNode
from app.models.overlap_cluster import OverlapCluster
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.project import Project
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_decision import ScreeningDecision
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.services import llm_client
from app.services import llm_screening_service as svc
from app.services.llm_client import LlmLogContext, set_llm_log_context

router = APIRouter(tags=["llm_screening"])


async def _live_counts(
    db: AsyncSession, run_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[str, int]]:
    """Query actual decision counts from llm_screening_results for the given run IDs.

    Returns a dict keyed by run_id with keys:
      included, excluded, uncertain, abstract_only, new_concepts
    Uses a single aggregation query regardless of how many runs are listed.
    """
    if not run_ids:
        return {}

    rows = (
        await db.execute(
            select(
                LlmScreeningResult.run_id,
                sqlfunc.sum(
                    case((LlmScreeningResult.ta_decision == "include", 1), else_=0)
                ).label("included"),
                sqlfunc.sum(
                    case((LlmScreeningResult.ta_decision == "exclude", 1), else_=0)
                ).label("excluded"),
                sqlfunc.sum(
                    case((LlmScreeningResult.ta_decision == "uncertain", 1), else_=0)
                ).label("uncertain"),
                sqlfunc.sum(
                    case(
                        (
                            (LlmScreeningResult.full_text_source == "abstract_only")
                            & LlmScreeningResult.ft_decision.is_(None),
                            1,
                        ),
                        else_=0,
                    )
                ).label("abstract_only"),
                sqlfunc.sum(
                    case((LlmScreeningResult.review_action.isnot(None), 1), else_=0)
                ).label("reviewed"),
            )
            .where(LlmScreeningResult.run_id.in_(run_ids))
            .group_by(LlmScreeningResult.run_id)
        )
    ).all()

    result: dict[uuid.UUID, dict[str, int]] = {}
    for row in rows:
        result[row.run_id] = {
            "included":     int(row.included or 0),
            "excluded":     int(row.excluded or 0),
            "uncertain":    int(row.uncertain or 0),
            "abstract_only": int(row.abstract_only or 0),
            "reviewed":     int(row.reviewed or 0),
        }
    return result


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


async def _require_run(
    run_id: str,
    project: Project,
    db: AsyncSession,
    reviewer_only: Optional[uuid.UUID] = None,
) -> LlmScreeningRun:
    try:
        rid = uuid.UUID(run_id)
    except ValueError:
        raise HTTPException(400, "Invalid run_id")
    run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, rid)
    if run is None or run.project_id != project.id:
        raise HTTPException(404, "Run not found")
    if reviewer_only is not None and run.triggered_by != reviewer_only:
        raise HTTPException(404, "Run not found")
    return run


async def _reviewer_filter(project_id: str, user: User, db: AsyncSession) -> Optional[uuid.UUID]:
    """Return user.id if user is a reviewer (not owner/admin), else None.

    Reviewers can't create runs, so scoping by triggered_by returns nothing for them.
    """
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return None
    role = await ProjectRepo.user_role(db, pid, user.id)
    return user.id if role not in _RUN_ROLES else None


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------


class EstimateStage(BaseModel):
    role: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    reach_pct: float  # 0-100 — what fraction of records reach this stage


class EstimateResponse(BaseModel):
    total_records: int
    estimated_input_tokens: int
    estimated_output_tokens: int
    estimated_cost_usd: float
    estimated_minutes: float
    model: str
    cost_breakdown: dict[str, float]
    stages: list[EstimateStage] = []
    avg_ta_tokens_per_record: Optional[int] = None
    avg_ta_output_per_record: Optional[int] = None
    ft_availability_pct: Optional[float] = None
    token_data_source: Optional[str] = None


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
    # Mode fields (migration 025)
    mode: str
    source_id: Optional[str]
    seed: Optional[int]
    saturation_threshold: int
    include_extraction: bool
    stopped_at_saturation: bool
    # Agent fields (migration 027)
    agent_mode: str
    agent_pipeline: Optional[Any]
    # Two-phase fields (migration 038)
    source_run_id: Optional[str]
    abstract_only_count: int
    # Human-review coverage: results where a human recorded accept/reject/merge
    reviewed_count: int


class LlmResultResponse(BaseModel):
    id: str
    run_id: str
    project_id: str
    record_id: Optional[str]
    cluster_id: Optional[str]
    title: Optional[str]
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
    extracted_json: Optional[Any]
    created_at: str


class CreateRunBody(BaseModel):
    model: str = "claude-sonnet-4-6"
    mode: str = "prisma_scr"
    source_id: Optional[str] = None
    seed: Optional[int] = None
    saturation_threshold: int = 5
    include_extraction: bool = True
    agent_mode: str = "single"
    pipeline: Optional[list] = None
    source_run_id: Optional[str] = None  # ft_only runs only


class ReviewBody(BaseModel):
    action: str  # accepted / rejected / merged


class LlmConfigBody(BaseModel):
    research_question: Optional[str] = None
    custom_system_additions: Optional[str] = None
    extraction_instructions: Optional[str] = None
    concept_instructions: Optional[str] = None
    use_full_override: bool = False
    full_override_prompt: Optional[str] = None


class SendToConsensusBody(BaseModel):
    record_ids: list[str]
    stage: str  # "TA" or "FT"


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _run_to_response(
    run: LlmScreeningRun,
    live: Optional[dict[str, int]] = None,
) -> LlmRunResponse:
    """Serialize a run row. When `live` is provided (from _live_counts), its
    decision counts override the potentially-stale denormalized columns."""
    processed = run.processed_records or 0
    total = run.total_records or 0
    progress = (processed / total * 100.0) if total > 0 else 0.0

    def _dec(val: Optional[Decimal]) -> Optional[float]:
        return float(val) if val is not None else None

    def _dt(val: Optional[datetime]) -> Optional[str]:
        return val.isoformat() if val is not None else None

    # Use live result-table counts when available; fall back to denormalized row.
    included  = live["included"]      if live else (run.included_count  or 0)
    excluded  = live["excluded"]      if live else (run.excluded_count  or 0)
    uncertain = live["uncertain"]     if live else (run.uncertain_count or 0)
    # abstract_only from the results table equals records processed as abstract-only;
    # for ta_only completed runs that = total records, which is more meaningful.
    # Use the larger of the two so we don't show 0 for runs completed before live counts.
    abstract_only_live = live["abstract_only"] if live else 0
    abstract_only = max(abstract_only_live, run.abstract_only_count or 0)
    reviewed = live["reviewed"] if live else 0

    return LlmRunResponse(
        id=str(run.id),
        project_id=str(run.project_id),
        status=run.status,
        model=run.model,
        total_records=run.total_records,
        processed_records=processed,
        included_count=included,
        excluded_count=excluded,
        uncertain_count=uncertain,
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
        mode=run.mode or "prisma_scr",
        source_id=str(run.source_id) if run.source_id else None,
        seed=run.seed,
        saturation_threshold=run.saturation_threshold or 5,
        include_extraction=run.include_extraction if run.include_extraction is not None else True,
        stopped_at_saturation=run.stopped_at_saturation or False,
        agent_mode=run.agent_mode or "single",
        agent_pipeline=run.agent_pipeline,
        source_run_id=str(run.source_run_id) if run.source_run_id else None,
        abstract_only_count=abstract_only,
        reviewed_count=reviewed,
    )


def _result_to_response(res: LlmScreeningResult, title: Optional[str] = None) -> LlmResultResponse:
    def _dt(val: Optional[datetime]) -> Optional[str]:
        return val.isoformat() if val is not None else None

    return LlmResultResponse(
        id=str(res.id),
        run_id=str(res.run_id),
        project_id=str(res.project_id),
        record_id=str(res.record_id) if res.record_id else None,
        cluster_id=str(res.cluster_id) if res.cluster_id else None,
        title=title,
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
        extracted_json=res.extracted_json,
        created_at=res.created_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# LLM Config endpoints
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/llm-config")
async def get_llm_config(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return the project's LLM prompt configuration."""
    project = await _require_project(project_id, db, user)
    return project.llm_config or {}


@router.patch("/projects/{project_id}/llm-config")
async def update_llm_config(
    project_id: str,
    body: LlmConfigBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Save LLM prompt configuration for a project (admin/owner only)."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    updated = await ProjectRepo.update_llm_config(db, project.id, body.model_dump())
    await db.commit()
    return updated.llm_config or {}  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Default pipeline definitions
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/llm-screening/default-pipelines")
async def get_default_pipelines(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return the built-in single-agent and multi-agent pipeline definitions."""
    await _require_project(project_id, db, user)
    return {
        "single": svc.DEFAULT_SINGLE_PIPELINE,
        "multi": svc.DEFAULT_MULTI_PIPELINE,
    }


@router.get("/projects/{project_id}/llm-screening/default-system-prompts")
async def get_default_system_prompts(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return the built-in system prompts for each agent role."""
    await _require_project(project_id, db, user)
    return {
        "single": svc._SYSTEM_PROMPT,
        "ta_screener": svc._SYSTEM_PROMPT_TA,
        "ft_screener": svc._SYSTEM_PROMPT_FT,
        "extractor": (
            "You are an expert systematic review researcher performing structured data extraction. "
            "Extract specific data fields from papers that have been included after full-text screening. "
            "You MUST use the submit_extraction tool to return your answer — do not produce any other output."
        ),
        "verifier": svc._SYSTEM_PROMPT_VERIFY,
        "custom": svc._SYSTEM_PROMPT,
    }


# ---------------------------------------------------------------------------
# Screening endpoints
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/estimate",
    response_model=EstimateResponse,
)
async def estimate(
    project_id: str,
    model: str = Query(default="claude-sonnet-4-6"),
    source_id: Optional[str] = Query(default=None),
    agent_mode: str = Query(default="single"),
    mode: str = Query(default="prisma_scr"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EstimateResponse:
    """Return estimated cost and time for an LLM screening run."""
    project = await _require_project(project_id, db, user)
    sid: Optional[uuid.UUID] = None
    if source_id:
        try:
            sid = uuid.UUID(source_id)
        except ValueError:
            raise HTTPException(400, "Invalid source_id")
    data = await svc.estimate_run(db, project.id, model, source_id=sid, agent_mode=agent_mode, mode=mode)
    stages = [
        EstimateStage(
            role=s.get("stage", s.get("role", "")),
            model=s.get("model", model),
            input_tokens=s.get("input_tokens", 0),
            output_tokens=s.get("output_tokens", 0),
            cost_usd=s.get("cost_usd", 0.0),
            reach_pct=s.get("reach_pct", 0.0),
        )
        for s in data.get("stages", [])
    ]
    return EstimateResponse(model=model, stages=stages, **{k: v for k, v in data.items() if k != "stages"})


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

    # Validate mode-specific requirements
    if body.mode not in ("prisma_scr", "saturation", "ta_only", "ft_only"):
        raise HTTPException(400, "mode must be 'prisma_scr', 'saturation', 'ta_only', or 'ft_only'")
    if body.mode == "saturation" and not body.source_id:
        raise HTTPException(422, "source_id is required for saturation mode")

    # Resolve API keys: header override → user profile → env var
    profile_keys = user.api_keys or {}
    effective_anthropic = (
        x_anthropic_api_key
        or profile_keys.get("anthropic")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    effective_openrouter = (
        x_openrouter_api_key
        or profile_keys.get("openrouter")
        or os.environ.get("OPENROUTER_API_KEY")
    )
    is_claude = body.model.startswith("claude-")

    if is_claude and not effective_anthropic and not effective_openrouter:
        raise HTTPException(
            400,
            "No API key configured. Add an Anthropic or OpenRouter key in your account profile.",
        )
    if not is_claude and not effective_openrouter:
        raise HTTPException(
            400,
            "An OpenRouter API key is required for non-Claude models. "
            "Add one in your account profile.",
        )

    source_id_uuid: Optional[uuid.UUID] = None
    if body.source_id:
        try:
            source_id_uuid = uuid.UUID(body.source_id)
        except ValueError:
            raise HTTPException(400, "Invalid source_id")

    source_run_uuid: Optional[uuid.UUID] = None
    if body.source_run_id:
        try:
            source_run_uuid = uuid.UUID(body.source_run_id)
        except ValueError:
            raise HTTPException(400, "Invalid source_run_id")
        # Verify the source run belongs to this project
        src_run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, source_run_uuid)
        if src_run is None or src_run.project_id != project.id:
            raise HTTPException(404, "source_run_id not found in this project")
        if src_run.mode != "ta_only":
            raise HTTPException(400, "source_run_id must reference a ta_only run")

    run = await svc.create_and_launch_run(
        db=db,
        project_id=project.id,
        model=body.model,
        triggered_by=user.id,
        background_tasks=background_tasks,
        anthropic_api_key=effective_anthropic,
        openrouter_api_key=effective_openrouter,
        mode=body.mode,
        source_id=source_id_uuid,
        seed=body.seed,
        saturation_threshold=body.saturation_threshold,
        include_extraction=body.include_extraction,
        agent_mode=body.agent_mode,
        pipeline=body.pipeline,
        source_run_id=source_run_uuid,
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
    """List LLM screening runs for a project, newest first.

    Reviewers only see runs they triggered (blank for them since only admins can create runs).
    """
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)

    stmt = select(LlmScreeningRun).where(LlmScreeningRun.project_id == project.id)
    if reviewer_id is not None:
        stmt = stmt.where(LlmScreeningRun.triggered_by == reviewer_id)
    stmt = stmt.order_by(LlmScreeningRun.created_at.desc())

    runs = (await db.execute(stmt)).scalars().all()
    counts = await _live_counts(db, [r.id for r in runs])
    return [_run_to_response(r, counts.get(r.id)) for r in runs]


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
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)
    counts = await _live_counts(db, [run.id])
    return _run_to_response(run, counts.get(run.id))


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
    """Return paginated LLM screening results for a run."""
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)

    stmt = select(LlmScreeningResult).where(LlmScreeningResult.run_id == run.id)
    if ta_decision:
        stmt = stmt.where(LlmScreeningResult.ta_decision == ta_decision)

    stmt = stmt.order_by(LlmScreeningResult.created_at)
    offset = (page - 1) * page_size
    stmt = stmt.offset(offset).limit(page_size)
    results = (await db.execute(stmt)).scalars().all()

    count_stmt = select(sqlfunc.count()).select_from(LlmScreeningResult).where(
        LlmScreeningResult.run_id == run.id
    )
    if ta_decision:
        count_stmt = count_stmt.where(LlmScreeningResult.ta_decision == ta_decision)
    total: int = (await db.execute(count_stmt)).scalar_one()

    # Batch-fetch titles for record-based results
    record_ids = [r.record_id for r in results if r.record_id is not None]
    title_map: dict = {}
    if record_ids:
        recs = (await db.execute(
            select(Record.id, Record.title).where(Record.id.in_(record_ids))
        )).all()
        title_map = {row.id: row.title for row in recs}

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [_result_to_response(r, title=title_map.get(r.record_id) if r.record_id else None) for r in results],
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
    reviewer_id = await _reviewer_filter(project_id, user, db)
    # Validate the run is accessible to this user before touching its results
    await _require_run(run_id, project, db, reviewer_only=reviewer_id)

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
    res.reviewed_at = datetime.now(tz=timezone.utc)
    res.review_action = body.action

    await db.commit()
    await db.refresh(res)
    return _result_to_response(res)


# ---------------------------------------------------------------------------
# CSV Export
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}/export",
)
async def export_run_csv(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Stream a CSV of all results for a completed run."""
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)

    # Build extraction template columns
    extraction_rows: list[dict] = []
    if project.extraction_template and project.extraction_template.get("rows"):
        extraction_rows = project.extraction_template["rows"]
    extraction_headers = [
        f"{r.get('domain', '')}: {r.get('item', '')}" if r.get('domain') else r.get('item', r.get('id', ''))
        for r in extraction_rows
    ]
    extraction_ids = [r.get("id", "") for r in extraction_rows]

    # Load all results with record metadata
    results = (
        await db.execute(
            select(LlmScreeningResult)
            .where(LlmScreeningResult.run_id == run.id)
            .order_by(LlmScreeningResult.created_at)
        )
    ).scalars().all()

    # Pre-load records for metadata
    record_ids = [r.record_id for r in results if r.record_id]
    record_map: dict[uuid.UUID, Record] = {}
    if record_ids:
        recs = (
            await db.execute(select(Record).where(Record.id.in_(record_ids)))
        ).scalars().all()
        record_map = {r.id: r for r in recs}

    def _generate() -> Any:
        output = io.StringIO()
        writer = csv.writer(output)

        base_headers = [
            "record_id", "title", "authors", "year", "doi",
            "ta_decision", "ta_reason", "ft_decision", "ft_reason",
        ]
        writer.writerow(base_headers + extraction_headers)
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for res in results:
            rec = record_map.get(res.record_id) if res.record_id else None
            authors_str = "; ".join(rec.authors or []) if rec and rec.authors else ""
            row = [
                str(res.record_id) if res.record_id else str(res.cluster_id or ""),
                (rec.title or "") if rec else "",
                authors_str,
                str(rec.year or "") if rec else "",
                (rec.doi or "") if rec else "",
                res.ta_decision or "",
                res.ta_reason or "",
                res.ft_decision or "",
                res.ft_reason or "",
            ]
            # Extraction fields
            extracted = res.extracted_json or {}
            for eid in extraction_ids:
                val = extracted.get(eid, "")
                if isinstance(val, list):
                    val = "; ".join(str(v) for v in val)
                row.append(str(val) if val is not None else "")
            writer.writerow(row)
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    filename = f"llm_results_{str(run.id)[-8:]}.csv"
    return StreamingResponse(
        _generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ---------------------------------------------------------------------------
# Human Comparison
# ---------------------------------------------------------------------------


def _cohen_kappa_simple(agreements: int, total: int, p_e: float) -> Optional[float]:
    """Cohen's kappa: κ = (p_o - p_e) / (1 - p_e)."""
    if total == 0:
        return None
    p_o = agreements / total
    denom = 1.0 - p_e
    if denom == 0:
        return 1.0 if p_o == 1.0 else 0.0
    return (p_o - p_e) / denom


def _cohen_kappa_3class(items: list, llm_key: str, human_key: str) -> Optional[float]:
    """3-class Cohen's kappa (include / uncertain / exclude).

    κ = (p_o - p_e) / (1 - p_e)

    p_o = fraction of papers where LLM and human gave the exact same decision
    p_e = Σ_k (p_LLM,k × p_Human,k)   [expected agreement by chance]
          where k ∈ {include, uncertain, exclude}
          and p_X,k = fraction of rater X's decisions in category k

    Only papers where BOTH raters made a decision are counted (N).
    """
    cats = ["include", "uncertain", "exclude"]
    compared = [i for i in items if i[llm_key] and i[human_key]]
    n = len(compared)
    if n == 0:
        return None

    agreements = sum(1 for i in compared if i[llm_key] == i[human_key])
    p_o = agreements / n

    p_e = 0.0
    for cat in cats:
        p_llm = sum(1 for i in compared if i[llm_key] == cat) / n
        p_human = sum(1 for i in compared if i[human_key] == cat) / n
        p_e += p_llm * p_human

    denom = 1.0 - p_e
    if denom == 0:
        return 1.0 if p_o == 1.0 else 0.0
    return (p_o - p_e) / denom


def _kappa_label(kappa: Optional[float]) -> str:
    if kappa is None:
        return "n/a"
    if kappa >= 0.81:
        return "almost perfect"
    if kappa >= 0.61:
        return "substantial"
    if kappa >= 0.41:
        return "moderate"
    if kappa >= 0.21:
        return "fair"
    if kappa >= 0.0:
        return "slight"
    return "poor"


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}/comparison",
)
async def compare_with_humans(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Compare LLM decisions with human reviewer decisions for this run."""
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)

    # Load all LLM results for records (not clusters)
    llm_results = (
        await db.execute(
            select(LlmScreeningResult)
            .where(
                LlmScreeningResult.run_id == run.id,
                LlmScreeningResult.record_id.isnot(None),
            )
        )
    ).scalars().all()

    if not llm_results:
        return {
            "stats": {
                "n_compared_ta": 0,
                "ta_agreement_pct": None,
                "kappa_ta": None,
                "kappa_ta_label": "n/a",
                "n_compared_ft": 0,
                "ft_agreement_pct": None,
                "kappa_ft": None,
                "kappa_ft_label": "n/a",
            },
            "items": [],
        }

    # Load human decisions for the same records
    record_ids = [r.record_id for r in llm_results if r.record_id]

    # Some records were screened as part of a cross-source cluster — decisions are stored
    # against cluster_id in that case. Build record→cluster map first.
    cluster_rows = (
        await db.execute(
            select(RecordSource.record_id, OverlapClusterMember.cluster_id)
            .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
            .join(OverlapCluster, OverlapCluster.id == OverlapClusterMember.cluster_id)
            .where(
                OverlapCluster.project_id == project.id,
                OverlapCluster.scope == "cross_source",
                RecordSource.record_id.in_(record_ids),
            )
        )
    ).all()
    # record_id → cluster_id (first cluster wins, consistent with screening service)
    record_to_cluster: dict[uuid.UUID, uuid.UUID] = {}
    for row in cluster_rows:
        if row.record_id not in record_to_cluster:
            record_to_cluster[row.record_id] = row.cluster_id

    cluster_ids = list(set(record_to_cluster.values()))

    # Fetch record-based decisions
    record_decisions = (
        await db.execute(
            select(ScreeningDecision)
            .where(
                ScreeningDecision.project_id == project.id,
                ScreeningDecision.record_id.in_(record_ids),
                ScreeningDecision.reviewer_id.isnot(None),
            )
            .order_by(ScreeningDecision.created_at.desc())
        )
    ).scalars().all()

    # Fetch cluster-based decisions (for records that were screened as a cluster)
    cluster_decisions = []
    if cluster_ids:
        cluster_decisions = (
            await db.execute(
                select(ScreeningDecision)
                .where(
                    ScreeningDecision.project_id == project.id,
                    ScreeningDecision.cluster_id.in_(cluster_ids),
                    ScreeningDecision.reviewer_id.isnot(None),
                )
                .order_by(ScreeningDecision.created_at.desc())
            )
        ).scalars().all()

    # cluster_id → {stage: decision}
    cluster_decision_map: dict[uuid.UUID, dict[str, str]] = {}
    for hd in cluster_decisions:
        cid = hd.cluster_id
        if cid not in cluster_decision_map:
            cluster_decision_map[cid] = {}
        if hd.stage not in cluster_decision_map[cid]:
            cluster_decision_map[cid][hd.stage] = hd.decision.lower().strip() if hd.decision else hd.decision

    # Build per-record human decision map: {record_id: {stage: decision}}
    # Prefers record-level decisions; falls back to cluster-level decisions.
    human_map: dict[uuid.UUID, dict[str, str]] = {}
    for hd in record_decisions:
        rid = hd.record_id
        if rid not in human_map:
            human_map[rid] = {}
        # Keep most-recent decision per stage (results ordered desc already)
        if hd.stage not in human_map[rid]:
            human_map[rid][hd.stage] = hd.decision.lower().strip() if hd.decision else hd.decision
    # Fill in cluster decisions for records that have no direct record-level decision
    for rid, cid in record_to_cluster.items():
        if rid not in human_map and cid in cluster_decision_map:
            human_map[rid] = cluster_decision_map[cid]

    # Load record titles for display
    recs = (
        await db.execute(select(Record).where(Record.id.in_(record_ids)))
    ).scalars().all()
    record_title_map = {r.id: r.title for r in recs}

    # Build comparison items — exact 3-way match for ta_agrees / ft_agrees
    items = []

    for res in llm_results:
        rid = res.record_id
        if rid is None:
            continue

        human_ta = human_map.get(rid, {}).get("TA")
        human_ft = human_map.get(rid, {}).get("FT")
        llm_ta = res.ta_decision.lower().strip() if res.ta_decision else res.ta_decision
        llm_ft = res.ft_decision.lower().strip() if res.ft_decision else res.ft_decision

        # Exact agreement: include==include, uncertain==uncertain, exclude==exclude
        ta_agrees: Optional[bool] = None
        if llm_ta and human_ta:
            ta_agrees = (llm_ta == human_ta)

        ft_agrees: Optional[bool] = None
        if llm_ft and human_ft:
            ft_agrees = (llm_ft == human_ft)

        items.append(
            {
                "record_id": str(rid),
                "title": record_title_map.get(rid, ""),
                "llm_ta": llm_ta,
                "human_ta": human_ta,
                "ta_agrees": ta_agrees,
                "llm_ft": llm_ft,
                "human_ft": human_ft,
                "ft_agrees": ft_agrees,
            }
        )

    # Tallies for % agreement
    ta_compared = sum(1 for i in items if i["ta_agrees"] is not None)
    ta_agree    = sum(1 for i in items if i["ta_agrees"] is True)
    ft_compared = sum(1 for i in items if i["ft_agrees"] is not None)
    ft_agree    = sum(1 for i in items if i["ft_agrees"] is True)

    # 3-class Cohen's kappa (include / uncertain / exclude)
    ta_pct: Optional[float] = None
    kappa_ta: Optional[float] = None
    if ta_compared > 0:
        ta_pct = round(ta_agree / ta_compared * 100, 1)
        raw = _cohen_kappa_3class(items, "llm_ta", "human_ta")
        kappa_ta = round(raw, 3) if raw is not None else None

    ft_pct: Optional[float] = None
    kappa_ft: Optional[float] = None
    if ft_compared > 0:
        ft_pct = round(ft_agree / ft_compared * 100, 1)
        raw = _cohen_kappa_3class(items, "llm_ft", "human_ft")
        kappa_ft = round(raw, 3) if raw is not None else None

    return {
        "stats": {
            "n_compared_ta": ta_compared,
            "ta_agreement_pct": ta_pct,
            "kappa_ta": kappa_ta,
            "kappa_ta_label": _kappa_label(kappa_ta),
            "n_compared_ft": ft_compared,
            "ft_agreement_pct": ft_pct,
            "kappa_ft": kappa_ft,
            "kappa_ft_label": _kappa_label(kappa_ft),
        },
        "items": items,
    }


# ---------------------------------------------------------------------------
# Compare two LLM runs against each other
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/compare-runs",
)
async def compare_runs(
    project_id: str,
    run_a_id: str,
    run_b_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Compare TA decisions between two completed LLM screening runs."""
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run_a = await _require_run(run_a_id, project, db, reviewer_only=reviewer_id)
    run_b = await _require_run(run_b_id, project, db, reviewer_only=reviewer_id)

    def _effectively_completed(run: LlmScreeningRun) -> bool:
        total = run.total_records or 0
        return run.status == "completed" or (
            total > 0 and run.processed_records >= total
            and run.status in ("cancelled", "interrupted")
        )

    if not _effectively_completed(run_a):
        raise HTTPException(status_code=400, detail="Run A is not completed")
    if not _effectively_completed(run_b):
        raise HTTPException(status_code=400, detail="Run B is not completed")

    # Load results for both runs (record-level only)
    results_a = (await db.execute(
        select(LlmScreeningResult)
        .where(LlmScreeningResult.run_id == run_a.id, LlmScreeningResult.record_id.isnot(None))
    )).scalars().all()

    results_b = (await db.execute(
        select(LlmScreeningResult)
        .where(LlmScreeningResult.run_id == run_b.id, LlmScreeningResult.record_id.isnot(None))
    )).scalars().all()

    map_a = {r.record_id: r for r in results_a}
    map_b = {r.record_id: r for r in results_b}
    common_ids = set(map_a) & set(map_b)

    if not common_ids:
        empty_stats = {"n_compared": 0, "ta_agreement_pct": None, "kappa_ta": None, "kappa_ta_label": "n/a",
                       "run_a_included": 0, "run_b_included": 0, "only_a_included": 0, "only_b_included": 0}
        return {"stats": empty_stats, "disagreements": []}

    # Load titles
    recs = (await db.execute(select(Record).where(Record.id.in_(list(common_ids))))).scalars().all()
    title_map = {r.id: (r.title, r.year) for r in recs}

    items = []
    for rid in common_ids:
        a = map_a[rid]
        b = map_b[rid]
        ta_a = (a.ta_decision or "").lower().strip() or None
        ta_b = (b.ta_decision or "").lower().strip() or None
        items.append({
            "record_id": str(rid),
            "run_a_ta": ta_a,
            "run_b_ta": ta_b,
        })

    # Stats
    compared = [i for i in items if i["run_a_ta"] and i["run_b_ta"]]
    n = len(compared)
    agree = sum(1 for i in compared if i["run_a_ta"] == i["run_b_ta"])
    ta_pct = round(agree / n * 100, 1) if n else None
    raw_kappa = _cohen_kappa_3class(compared, "run_a_ta", "run_b_ta")
    kappa = round(raw_kappa, 3) if raw_kappa is not None else None

    a_inc = sum(1 for r in results_a if r.ta_decision == "include")
    b_inc = sum(1 for r in results_b if r.ta_decision == "include")
    only_a = sum(1 for i in compared if i["run_a_ta"] == "include" and i["run_b_ta"] != "include")
    only_b = sum(1 for i in compared if i["run_b_ta"] == "include" and i["run_a_ta"] != "include")

    # Build disagreement list (only where both have a decision and they differ)
    disagreements = []
    for i in compared:
        if i["run_a_ta"] == i["run_b_ta"]:
            continue
        rid_uuid = uuid.UUID(i["record_id"])
        a = map_a[rid_uuid]
        b = map_b[rid_uuid]
        title, year = title_map.get(rid_uuid, (None, None))
        disagreements.append({
            "record_id": i["record_id"],
            "title": title,
            "year": year,
            "run_a_ta": i["run_a_ta"],
            "run_a_reason": a.ta_reason,
            "run_a_reason_code": a.reason_code,
            "run_b_ta": i["run_b_ta"],
            "run_b_reason": b.ta_reason,
            "run_b_reason_code": b.reason_code,
        })

    # Sort: A=include B=exclude first (missed by A), then A=exclude B=include
    disagreements.sort(key=lambda x: (0 if x["run_b_ta"] == "include" else 1, x["title"] or ""))

    return {
        "stats": {
            "n_compared": n,
            "ta_agreement_pct": ta_pct,
            "kappa_ta": kappa,
            "kappa_ta_label": _kappa_label(kappa),
            "run_a_included": a_inc,
            "run_b_included": b_inc,
            "only_a_included": only_a,
            "only_b_included": only_b,
        },
        "disagreements": disagreements,
    }


# ---------------------------------------------------------------------------
# Send disagreements to consensus
# ---------------------------------------------------------------------------


@router.post(
    "/projects/{project_id}/llm-screening/runs/{run_id}/send-to-consensus",
    status_code=201,
)
async def send_to_consensus(
    project_id: str,
    run_id: str,
    body: SendToConsensusBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Insert LLM decisions as synthetic ScreeningDecision rows (reviewer_id=NULL).

    This triggers the existing ConsensusPage conflict detection, which looks for
    items with multiple different decisions at the same stage.
    """
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    run = await _require_run(run_id, project, db)

    if body.stage not in ("TA", "FT"):
        raise HTTPException(400, "stage must be 'TA' or 'FT'")

    created = 0
    for record_id_str in body.record_ids:
        try:
            rid = uuid.UUID(record_id_str)
        except ValueError:
            continue

        # Find the LLM result for this record
        llm_result = (
            await db.execute(
                select(LlmScreeningResult)
                .where(
                    LlmScreeningResult.run_id == run.id,
                    LlmScreeningResult.record_id == rid,
                )
                .limit(1)
            )
        ).scalar_one_or_none()

        if llm_result is None:
            continue

        llm_decision = llm_result.ta_decision if body.stage == "TA" else llm_result.ft_decision
        if not llm_decision or llm_decision == "uncertain":
            continue
        # Normalise to include/exclude
        decision = "include" if llm_decision == "include" else "exclude"

        # AI assists, never decides: skip records where a HUMAN has already
        # recorded a decision at this stage — directly or on the record's
        # cross-source cluster. Synthetic decisions must never override
        # human judgment.
        human_decision = (
            await db.execute(
                select(ScreeningDecision.id)
                .where(
                    ScreeningDecision.project_id == project.id,
                    ScreeningDecision.stage == body.stage,
                    ScreeningDecision.reviewer_id.isnot(None),
                    or_(
                        ScreeningDecision.record_id == rid,
                        ScreeningDecision.cluster_id.in_(
                            select(OverlapClusterMember.cluster_id)
                            .join(RecordSource, RecordSource.id == OverlapClusterMember.record_source_id)
                            .join(OverlapCluster, OverlapCluster.id == OverlapClusterMember.cluster_id)
                            .where(
                                RecordSource.record_id == rid,
                                OverlapCluster.scope == "cross_source",
                            )
                        ),
                    ),
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if human_decision is not None:
            continue

        # Check no duplicate (same record, same stage, reviewer_id IS NULL already)
        existing = (
            await db.execute(
                select(ScreeningDecision)
                .where(
                    ScreeningDecision.project_id == project.id,
                    ScreeningDecision.record_id == rid,
                    ScreeningDecision.stage == body.stage,
                    ScreeningDecision.reviewer_id.is_(None),
                )
                .limit(1)
            )
        ).scalar_one_or_none()

        if existing is not None:
            # Update existing synthetic decision
            existing.decision = decision
            existing.notes = f"LLM: {run.model}"
            existing.origin = "ai"
            existing.llm_run_id = run.id
        else:
            sd = ScreeningDecision(
                project_id=project.id,
                record_id=rid,
                cluster_id=None,
                stage=body.stage,
                decision=decision,
                reviewer_id=None,  # synthetic LLM reviewer
                notes=f"LLM: {run.model}",
                origin="ai",
                llm_run_id=run.id,
            )
            db.add(sd)
            created += 1

    await db.commit()
    return {"created": created}


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------


@router.post(
    "/projects/{project_id}/llm-screening/runs/{run_id}/resume",
    response_model=LlmRunResponse,
)
async def resume_run(
    project_id: str,
    run_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    x_anthropic_api_key: Optional[str] = Header(None, alias="X-Anthropic-Api-Key"),
    x_openrouter_api_key: Optional[str] = Header(None, alias="X-OpenRouter-Api-Key"),
) -> LlmRunResponse:
    """Resume an interrupted run from where it left off."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    run = await _require_run(run_id, project, db)

    profile_keys = user.api_keys or {}
    effective_anthropic = (
        x_anthropic_api_key
        or profile_keys.get("anthropic")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    effective_openrouter = (
        x_openrouter_api_key
        or profile_keys.get("openrouter")
        or os.environ.get("OPENROUTER_API_KEY")
    )

    try:
        run = await svc.resume_run(
            db=db,
            project_id=project.id,
            run_id=run.id,
            background_tasks=background_tasks,
            anthropic_api_key=effective_anthropic,
            openrouter_api_key=effective_openrouter,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    return _run_to_response(run)


@router.post(
    "/projects/{project_id}/llm-screening/runs/{run_id}/cancel",
    response_model=LlmRunResponse,
)
async def cancel_run(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LlmRunResponse:
    """Request a graceful stop for a running or queued LLM screening run."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    run = await _require_run(run_id, project, db)
    try:
        run = await svc.cancel_run(db=db, project_id=project.id, run_id=run.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return _run_to_response(run)


@router.delete(
    "/projects/{project_id}/llm-screening/runs/{run_id}",
    status_code=204,
)
async def delete_run(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete a run and all its screening results."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    run = await _require_run(run_id, project, db)
    try:
        await svc.delete_run(db=db, project_id=project.id, run_id=run.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Sub-project export
# ---------------------------------------------------------------------------


_VALID_CATEGORIES = {"include", "uncertain", "exclude"}


class CreateSubprojectBody(BaseModel):
    name: str
    description: Optional[str] = None
    categories: list = ["include"]  # subset of ["include", "uncertain", "exclude"]
    reason_code_filter: Optional[str] = None   # only 'exclude' rows with this reason_code
    ta_reason_contains: Optional[str] = None   # case-insensitive substring of ta_reason


@router.post(
    "/projects/{project_id}/llm-screening/runs/{run_id}/create-subproject",
    status_code=201,
)
async def create_subproject(
    project_id: str,
    run_id: str,
    body: CreateSubprojectBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Fork LLM-screened papers into a child project — one corpus per decision category."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    run = await _require_run(run_id, project, db)

    if not body.categories or not all(c in _VALID_CATEGORIES for c in body.categories):
        raise HTTPException(400, "categories must be a non-empty list of 'include', 'uncertain', 'exclude'")

    try:
        result = await svc.create_subproject_from_run(
            db=db,
            project_id=project.id,
            run_id=run.id,
            name=body.name,
            description=body.description,
            categories=body.categories,
            triggered_by=user.id,
            reason_code_filter=body.reason_code_filter,
            ta_reason_contains=body.ta_reason_contains,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    return result


# ---------------------------------------------------------------------------
# Prompt preview
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/preview-prompt",
)
async def preview_prompt(
    project_id: str,
    record_id: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return the resolved system + user prompts for a sample record."""
    project = await _require_project(project_id, db, user)

    rid: Optional[uuid.UUID] = None
    if record_id:
        try:
            rid = uuid.UUID(record_id)
        except ValueError:
            raise HTTPException(400, "Invalid record_id")

    preview = await svc.build_prompt_preview(db, project.id, record_id=rid)
    return preview


# ---------------------------------------------------------------------------
# Missing PDFs — records that need a user-uploaded PDF for FT screening
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}/missing-pdfs",
)
async def get_missing_pdfs(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """Return records where TA=include but full_text_source=abstract_only and FT is not yet decided.

    These are candidates for manual PDF upload so a future run can screen the full text.
    """
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)

    rows = (
        await db.execute(
            select(LlmScreeningResult, Record)
            .join(Record, Record.id == LlmScreeningResult.record_id)
            .where(
                LlmScreeningResult.run_id == run.id,
                LlmScreeningResult.ta_decision == "include",
                LlmScreeningResult.full_text_source == "abstract_only",
                LlmScreeningResult.ft_decision.is_(None),
            )
            .order_by(Record.title)
        )
    ).all()

    return [
        {
            "record_id": str(result.record_id),
            "title": record.title or "",
            "authors": record.authors or "",
            "year": record.year,
            "doi": record.doi,
            "ta_reason": result.ta_reason,
        }
        for result, record in rows
    ]


# ---------------------------------------------------------------------------
# Excluded-paper summary — distinct reason_code + text patterns for sub-project forking
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}/excluded-summary",
)
async def get_excluded_summary(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return a structured summary of why papers were excluded in this run.

    Returns two arrays:
      - reason_codes: [{reason_code, count}] — for runs that have the reason_code field populated
      - text_clusters: [{label, count, sample}] — simple keyword clusters from ta_reason text
        (for older runs without reason_code, or as a fallback)
    Also returns total_excluded count.
    """
    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)

    # Total excluded
    total_excluded: int = (
        await db.execute(
            select(sqlfunc.count())
            .select_from(LlmScreeningResult)
            .where(
                LlmScreeningResult.run_id == run.id,
                LlmScreeningResult.ta_decision == "exclude",
            )
        )
    ).scalar_one()

    # Distinct reason_codes with counts (populated by new runs)
    rc_rows = (
        await db.execute(
            select(
                LlmScreeningResult.reason_code,
                sqlfunc.count().label("cnt"),
            )
            .where(
                LlmScreeningResult.run_id == run.id,
                LlmScreeningResult.ta_decision == "exclude",
                LlmScreeningResult.reason_code.isnot(None),
            )
            .group_by(LlmScreeningResult.reason_code)
            .order_by(sqlfunc.count().desc())
        )
    ).all()
    reason_codes = [{"reason_code": r.reason_code, "count": r.cnt} for r in rc_rows]

    # For runs without reason_code: return up to 50 sample ta_reason texts so
    # the frontend can help users build a search filter manually.
    sample_reasons: list[str] = []
    if not reason_codes:
        rows = (
            await db.execute(
                select(LlmScreeningResult.ta_reason)
                .where(
                    LlmScreeningResult.run_id == run.id,
                    LlmScreeningResult.ta_decision == "exclude",
                    LlmScreeningResult.ta_reason.isnot(None),
                )
                .order_by(LlmScreeningResult.created_at)
                .limit(50)
            )
        ).scalars().all()
        sample_reasons = [r for r in rows if r]

    return {
        "total_excluded": total_excluded,
        "reason_codes": reason_codes,
        "has_reason_codes": len(reason_codes) > 0,
        "sample_reasons": sample_reasons,
    }


# ---------------------------------------------------------------------------
# Two-phase interactive screening: FT queue + FT run launcher
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/llm-screening/runs/{run_id}/ft-queue",
)
async def get_ft_queue(
    project_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """Return all TA-included records from a ta_only run, with full-text availability info.

    Used by the Full Text Queue panel to show the user which papers need PDFs
    before the FT phase can run.
    """
    from app.models.fulltext_pdf import FulltextPdf

    project = await _require_project(project_id, db, user)
    reviewer_id = await _reviewer_filter(project_id, user, db)
    run = await _require_run(run_id, project, db, reviewer_only=reviewer_id)

    # Works for ta_only runs (all included papers) and also falls back to
    # the same abstract_only filter for prisma_scr / saturation runs.
    ta_rows = (
        await db.execute(
            select(LlmScreeningResult, Record)
            .join(Record, Record.id == LlmScreeningResult.record_id)
            .where(
                LlmScreeningResult.run_id == run.id,
                LlmScreeningResult.ta_decision == "include",
                LlmScreeningResult.record_id.isnot(None),
            )
            .order_by(Record.title)
        )
    ).all()

    # Collect record IDs that already have an uploaded PDF
    record_ids = [result.record_id for result, _ in ta_rows]
    uploaded_ids: set[uuid.UUID] = set()
    if record_ids:
        pdf_rows = (
            await db.execute(
                select(FulltextPdf.record_id).where(
                    FulltextPdf.project_id == project.id,
                    FulltextPdf.record_id.in_(record_ids),
                )
            )
        ).scalars().all()
        uploaded_ids = {r for r in pdf_rows if r is not None}

    # Check whether an ft_only run already exists for this ta_only run
    ft_run = (
        await db.execute(
            select(LlmScreeningRun)
            .where(
                LlmScreeningRun.project_id == project.id,
                LlmScreeningRun.source_run_id == run.id,
                LlmScreeningRun.mode == "ft_only",
            )
            .order_by(LlmScreeningRun.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    return {  # type: ignore[return-value]
        "ta_run_id": str(run.id),
        "ft_run": _run_to_response(ft_run).model_dump() if ft_run else None,
        "papers": [
            {
                "record_id": str(result.record_id),
                "title": record.title or "",
                "authors": record.authors or "",
                "year": record.year,
                "doi": record.doi,
                "journal": record.journal or "",
                "ta_reason": result.ta_reason,
                "has_pdf": result.record_id in uploaded_ids,
                "ft_decision": result.ft_decision,  # populated after ft_only run
            }
            for result, record in ta_rows
        ],
    }


# ── Sprint B: Per-paper AI auto-fill extraction ────────────────────────────────

class AutoExtractRequest(BaseModel):
    record_id: Optional[str] = None
    cluster_id: Optional[str] = None
    model: str = "claude-haiku-4-5-20251001"


def _resolve_anthropic_key(user: User) -> Optional[str]:
    """Return Anthropic key from profile/env."""
    profile_keys = user.api_keys or {}
    return profile_keys.get("anthropic") or os.environ.get("ANTHROPIC_API_KEY")


def _resolve_openrouter_key(user: User) -> Optional[str]:
    """Return OpenRouter key from profile/env."""
    profile_keys = user.api_keys or {}
    return profile_keys.get("openrouter") or os.environ.get("OPENROUTER_API_KEY")


async def _simple_llm_call(
    user: User,
    model: str,
    system: str,
    prompt: str,
    max_tokens: int = 1024,
    *,
    feature: str,
    project_id: Optional[uuid.UUID] = None,
) -> str:
    """Call LLM via the central gateway (audited to llm_calls). Returns text response."""
    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)

    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured — add an Anthropic or OpenRouter key in Settings")

    try:
        result = await llm_client.call_llm(
            feature=feature,
            model=model,
            prompt=prompt,
            system=system,
            max_tokens=max_tokens,
            anthropic_key=anthropic_key,
            openrouter_key=openrouter_key,
            project_id=project_id,
            user_id=user.id,
        )
    except ValueError as exc:  # no usable API key for this model
        raise HTTPException(400, str(exc))
    return result.text


@router.post("/projects/{project_id}/llm-screening/auto-extract")
async def auto_extract_paper(
    project_id: str,
    body: AutoExtractRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Auto-fill extraction fields for a single paper using AI.

    Reads the paper's title/abstract (and uploaded PDF text if available),
    runs Claude against the project extraction template, and returns a
    pre-filled extracted_json. The caller decides whether to save it.
    """
    await require_project_role(db, uuid.UUID(project_id), user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, uuid.UUID(project_id))
    if not project:
        raise HTTPException(404, "Project not found")

    extraction_template = project.extraction_template or {}
    if not extraction_template.get("rows"):
        raise HTTPException(400, "Project has no extraction template configured")

    # Resolve record
    record: Optional[Record] = None
    if body.record_id:
        record = (await db.execute(select(Record).where(Record.id == uuid.UUID(body.record_id)))).scalar_one_or_none()
    elif body.cluster_id:
        rep_row = (await db.execute(
            select(Record)
            .join(RecordSource, RecordSource.record_id == Record.id)
            .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
            .where(OverlapClusterMember.cluster_id == uuid.UUID(body.cluster_id))
            .order_by(OverlapClusterMember.id)
            .limit(1)
        )).scalar_one_or_none()
        record = rep_row

    if not record:
        raise HTTPException(404, "Record not found")

    # Try to read uploaded PDF text
    full_text: Optional[str] = None
    pdf_row = (await db.execute(
        select(FulltextPdf).where(
            FulltextPdf.project_id == uuid.UUID(project_id),
            FulltextPdf.record_id == record.id if body.record_id else FulltextPdf.cluster_id == uuid.UUID(body.cluster_id or ""),
        ).limit(1)
    )).scalar_one_or_none()

    if pdf_row and pdf_row.storage_path:
        try:
            import pdfplumber
            with pdfplumber.open(pdf_row.storage_path) as pdf:
                full_text = "\n".join(
                    p.extract_text() or "" for p in pdf.pages[:30]
                )[:12000]
        except Exception:
            pass  # fall back to abstract-only extraction

    llm_config = project.llm_config or {}
    set_llm_log_context(LlmLogContext(
        feature="extraction.auto_fill",
        project_id=uuid.UUID(project_id),
        user_id=user.id,
    ))
    result = await svc._extract_one_record(
        record=record,
        full_text=full_text,
        extraction_template=extraction_template,
        llm_config=llm_config,
        model=body.model,
        anthropic_api_key=_resolve_anthropic_key(user),
        openrouter_api_key=_resolve_openrouter_key(user),
    )
    if result is None:
        raise HTTPException(500, "AI extraction failed — check API key and template")
    return {"extracted_json": result}


# ── Sprint C: Auto concept extraction suggestions ─────────────────────────────

class AutoConceptRequest(BaseModel):
    record_id: Optional[str] = None
    cluster_id: Optional[str] = None
    extraction_text: Optional[str] = None  # already-extracted free text to enrich suggestions
    model: str = "claude-haiku-4-5-20251001"


@router.post("/projects/{project_id}/llm-screening/auto-concepts")
async def auto_concept_extract(
    project_id: str,
    body: AutoConceptRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Suggest concept extractions (entities/relations/metadata) for one paper.

    Uses the project's concept_template to build a tool schema, then calls
    Claude against the paper abstract + any provided extraction_text.
    Returns suggested values per field — caller decides whether to accept.
    """
    import anthropic as _anthropic

    await require_project_role(db, uuid.UUID(project_id), user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, uuid.UUID(project_id))
    if not project:
        raise HTTPException(404, "Project not found")

    concept_template = project.concept_template or {}
    fields = concept_template.get("fields") or []
    if not fields:
        raise HTTPException(400, "Project has no concept template configured")

    # Resolve record for title/abstract
    record: Optional[Record] = None
    if body.record_id:
        record = (await db.execute(select(Record).where(Record.id == uuid.UUID(body.record_id)))).scalar_one_or_none()
    elif body.cluster_id:
        record = (await db.execute(
            select(Record)
            .join(RecordSource, RecordSource.record_id == Record.id)
            .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
            .where(OverlapClusterMember.cluster_id == uuid.UUID(body.cluster_id))
            .order_by(OverlapClusterMember.id).limit(1)
        )).scalar_one_or_none()

    # Build concept tool schema
    properties: dict = {}
    for f in fields:
        fid = f.get("id", "")
        if not fid:
            continue
        ft = f.get("field_type", "metadata")
        label = f.get("label", fid)
        input_type = f.get("input_type", "text")
        opts = f.get("options") or []
        desc = f"{ft}: {label}"
        if opts and input_type in ("select", "multiselect"):
            properties[fid] = {"type": "array", "items": {"type": "string", "enum": opts}, "description": desc}
        else:
            properties[fid] = {"type": "array", "items": {"type": "string"}, "description": f"{desc} — list all values found"}

    tool_schema = [{
        "name": "submit_concepts",
        "description": "Submit extracted concept values for this paper",
        "input_schema": {"type": "object", "properties": properties, "required": list(properties.keys())},
    }]

    # Build prompt
    lines = ["## Paper\n"]
    if record:
        lines.append(f"**Title**: {record.title or '(no title)'}")
        if record.abstract:
            lines.append(f"\n**Abstract**: {record.abstract}")
    if body.extraction_text:
        lines.append(f"\n## Extracted Data\n{body.extraction_text[:4000]}")
    lines.append("\n## Concept Fields to Extract")
    for f in fields:
        lines.append(f"- **{f.get('label', f.get('id'))}** ({f.get('field_type', 'metadata')})")
    # Allow user-configured instructions to override/extend the default prompt
    ai_instructions = concept_template.get("ai_instructions") or ""
    if ai_instructions:
        lines.append(f"\n## Additional Instructions\n{ai_instructions}")
    lines.append("\nUse the submit_concepts tool. For each field, list ALL values you can identify from the paper.")

    base_system = "You are an expert qualitative researcher extracting structured concepts from academic papers. Extract only what is explicitly stated."
    system_prompt = f"{base_system}\n\n{ai_instructions}".strip() if ai_instructions else base_system

    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured — add an Anthropic or OpenRouter key in Settings")

    use_openrouter = openrouter_key and (not anthropic_key or not body.model.startswith("claude-"))

    import json as _json
    import time as _time
    _started = _time.monotonic()

    async def _audit(status: str, in_tok: Optional[int], out_tok: Optional[int],
                     result: Optional[dict], error: Optional[str]) -> None:
        await llm_client.log_llm_call(
            feature="concepts.auto_fill",
            provider="openrouter" if use_openrouter else "anthropic",
            model=body.model,
            status=status,
            error_message=error,
            input_tokens=in_tok,
            output_tokens=out_tok,
            latency_ms=int((_time.monotonic() - _started) * 1000),
            system_prompt=system_prompt,
            prompt="\n".join(lines),
            response=_json.dumps(result, default=str) if result is not None else None,
            project_id=uuid.UUID(project_id),
            user_id=user.id,
        )

    try:
        result: dict = {}
        in_tok: Optional[int] = None
        out_tok: Optional[int] = None
        if use_openrouter:
            from openai import AsyncOpenAI  # type: ignore
            oai_tools = [{"type": "function", "function": {"name": "submit_concepts", "description": "Submit extracted concept values", "parameters": {"type": "object", "properties": properties, "required": list(properties.keys())}}}]
            oa_client = AsyncOpenAI(api_key=openrouter_key, base_url="https://openrouter.ai/api/v1", default_headers={"HTTP-Referer": "https://evidence-platform", "X-Title": "EvidencePlatform"})
            or_resp = await oa_client.chat.completions.create(model=body.model, max_tokens=2000, messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": "\n".join(lines)}], tools=oai_tools, tool_choice={"type": "function", "function": {"name": "submit_concepts"}})
            tc = or_resp.choices[0].message.tool_calls
            if tc:
                result = _json.loads(tc[0].function.arguments)
            if or_resp.usage:
                in_tok = or_resp.usage.prompt_tokens
                out_tok = or_resp.usage.completion_tokens
        else:
            ac = _anthropic.AsyncAnthropic(api_key=anthropic_key)
            resp = await ac.messages.create(model=body.model, max_tokens=2000, system=system_prompt, messages=[{"role": "user", "content": "\n".join(lines)}], tools=tool_schema, tool_choice={"type": "tool", "name": "submit_concepts"})
            for block in resp.content:
                if block.type == "tool_use" and block.name == "submit_concepts":
                    result = block.input or {}
                    break
            in_tok = resp.usage.input_tokens
            out_tok = resp.usage.output_tokens
        await _audit("ok", in_tok, out_tok, result, None)
        return {"cells": result}
    except HTTPException:
        raise
    except Exception as exc:
        await _audit("error", None, None, None, str(exc))
        raise HTTPException(500, f"AI concept extraction failed: {exc}")


# ── Sprint E: LLM conflict resolution suggestion ──────────────────────────────

class ConflictSuggestRequest(BaseModel):
    record_id: Optional[str] = None
    cluster_id: Optional[str] = None
    title: Optional[str] = None
    abstract: Optional[str] = None
    reviewer_a_decision: str
    reviewer_a_notes: Optional[str] = None
    reviewer_b_decision: str
    reviewer_b_notes: Optional[str] = None
    criteria: Optional[dict] = None
    model: str = "claude-haiku-4-5-20251001"


@router.post("/projects/{project_id}/llm-screening/suggest-resolution")
async def suggest_conflict_resolution(
    project_id: str,
    body: ConflictSuggestRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Ask the LLM to suggest a resolution for a reviewer conflict.

    Returns {decision, rationale} — not binding. Shown in ConsensusPage as
    an AI suggestion that the adjudicator can accept or override.
    """
    await require_project_role(db, uuid.UUID(project_id), user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, uuid.UUID(project_id))
    if not project:
        raise HTTPException(404, "Project not found")

    criteria = body.criteria or project.criteria or {}
    inclusion_str = "; ".join(criteria.get("inclusion", [])) or "Not specified"
    exclusion_str = "; ".join(criteria.get("exclusion", [])) or "Not specified"

    prompt = f"""You are an expert systematic review methodologist adjudicating a disagreement between two reviewers.

## Paper
Title: {body.title or '(unknown)'}
Abstract: {body.abstract or '(not available)'}

## Inclusion Criteria
{inclusion_str}

## Exclusion Criteria
{exclusion_str}

## Reviewer Disagreement
- Reviewer A: **{body.reviewer_a_decision.upper()}** {f'— "{body.reviewer_a_notes}"' if body.reviewer_a_notes else ''}
- Reviewer B: **{body.reviewer_b_decision.upper()}** {f'— "{body.reviewer_b_notes}"' if body.reviewer_b_notes else ''}

Based on the criteria and the paper content, which decision is better supported?
Respond with a JSON object with two keys: "decision" ("include" or "exclude") and "rationale" (1-2 sentences).
Return ONLY the JSON, no other text."""

    try:
        text = await _simple_llm_call(
            user, body.model,
            system="You are an expert systematic review methodologist. Respond only with valid JSON.",
            prompt=prompt, max_tokens=300,
            feature="consensus.suggest", project_id=uuid.UUID(project_id),
        )
        import json as _json
        parsed = _json.loads(text.strip())
        return {"decision": parsed.get("decision", "uncertain"), "rationale": parsed.get("rationale", "")}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"AI suggestion failed: {exc}")


# ── Sprint F: Evidence synthesis report ───────────────────────────────────────

class SynthesisRequest(BaseModel):
    focus: Optional[str] = None  # optional user-provided focus question
    max_papers: int = 30
    model: str = "claude-sonnet-4-6"


@router.post("/projects/{project_id}/llm-screening/synthesize")
async def synthesize_evidence(
    project_id: str,
    body: SynthesisRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a structured evidence synthesis narrative from extracted data.

    Reads all extraction_records for this project, aggregates thematic codes,
    pulls concept taxonomy, then calls Claude to produce a structured report.
    Returns markdown text that can be displayed in ReportPage.
    """
    from app.models.extraction_record import ExtractionRecord
    from sqlalchemy import text as sa_text

    await require_project_role(db, uuid.UUID(project_id), user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, uuid.UUID(project_id))
    if not project:
        raise HTTPException(404, "Project not found")

    pid = uuid.UUID(project_id)

    # 1. Gather all extraction records (up to max_papers, reviewer = current user OR all if owner)
    from app.models.extraction_record import ExtractionRecord
    extraction_rows = (await db.execute(
        select(ExtractionRecord, Record)
        .join(Record, Record.id == ExtractionRecord.record_id, isouter=True)
        .where(ExtractionRecord.project_id == pid)
        .order_by(ExtractionRecord.created_at.desc())
        .limit(body.max_papers)
    )).all()

    if not extraction_rows:
        raise HTTPException(400, "No extraction data found — extract some papers first")

    # 2. Build paper summaries
    template_rows = (project.extraction_template or {}).get("rows", [])
    field_labels = {r.get("id", ""): f"{r.get('domain','')}: {r.get('item','')}" if r.get('domain') else r.get('item','') for r in template_rows}

    paper_blocks = []
    for er, rec in extraction_rows:
        title = (rec.title if rec else None) or "(unknown title)"
        year = (rec.year if rec else None) or ""
        table = (er.extracted_json or {}).get("table", {})
        fields_text = "\n".join(
            f"  - {field_labels.get(k, k)}: {v}"
            for k, v in table.items() if v
        )
        paper_blocks.append(f"### {title} ({year})\n{fields_text or '  (no fields extracted)'}")

    # 3. Gather themes if available
    theme_rows = (await db.execute(sa_text(
        "SELECT t.name, t.description, COUNT(ta.id) as n "
        "FROM thematic_themes t "
        "LEFT JOIN thematic_assignments ta ON ta.theme_id = t.id "
        "WHERE t.project_id = :pid GROUP BY t.id ORDER BY n DESC LIMIT 20"
    ).bindparams(pid=pid))).fetchall()

    themes_text = ""
    if theme_rows:
        themes_text = "\n## Identified Themes\n" + "\n".join(
            f"- **{r.name}** ({r.n} codes): {r.description or ''}" for r in theme_rows
        )

    # 4. Project criteria for context
    criteria = project.criteria or {}
    focus_q = body.focus or project.name or "evidence synthesis"
    inclusion_criteria = "; ".join(criteria.get("inclusion", [])) or "Not specified"

    prompt = f"""You are an expert systematic review author. Write a structured evidence synthesis based on the following extracted data.

## Review Focus
{focus_q}

## Inclusion Criteria
{inclusion_criteria}
{themes_text}

## Extracted Papers ({len(paper_blocks)} total)

{chr(10).join(paper_blocks[:body.max_papers])}

---

Write a comprehensive evidence synthesis report in markdown with the following sections:
1. **Overview** — number of studies, date range, study designs
2. **Key Findings** — main evidence themes (reference papers by title/year)
3. **Convergences** — where multiple papers agree
4. **Divergences & Gaps** — contradictions or areas with limited evidence  
5. **Limitations** — methodological notes
6. **Conclusion** — summary for policy/practice

Be specific, cite paper titles where relevant, and write in an academic tone."""

    try:
        report_md = await _simple_llm_call(
            user, body.model,
            system="You are an expert systematic review author. Produce clear, structured, academic synthesis reports in markdown.",
            prompt=prompt, max_tokens=4000,
            feature="report.synthesis", project_id=pid,
        )
        report_md = report_md.strip()

        # Persist draft to project
        await db.execute(
            sa_text("UPDATE projects SET synthesis_draft = :draft WHERE id = :pid").bindparams(
                draft=report_md, pid=pid
            )
        )
        await db.commit()

        return {"report": report_md, "paper_count": len(paper_blocks)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Synthesis failed: {exc}")


@router.get("/projects/{project_id}/llm-screening/synthesis-draft")
async def get_synthesis_draft(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return the last saved synthesis draft for this project."""
    from sqlalchemy import text as sa_text
    await require_project_role(db, uuid.UUID(project_id), user.id, allowed=REVIEWER_ROLE)
    row = (await db.execute(
        sa_text("SELECT synthesis_draft FROM projects WHERE id = :pid").bindparams(pid=uuid.UUID(project_id))
    )).one_or_none()
    if not row:
        raise HTTPException(404, "Project not found")
    return {"report": row[0] or ""}
