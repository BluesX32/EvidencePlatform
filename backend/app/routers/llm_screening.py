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
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func as sqlfunc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.llm_screening import LlmScreeningResult, LlmScreeningRun
from app.models.project import Project
from app.models.record import Record
from app.models.screening_decision import ScreeningDecision
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
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


async def _require_run(
    run_id: str,
    project: Project,
    db: AsyncSession,
) -> LlmScreeningRun:
    try:
        rid = uuid.UUID(run_id)
    except ValueError:
        raise HTTPException(400, "Invalid run_id")
    run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, rid)
    if run is None or run.project_id != project.id:
        raise HTTPException(404, "Run not found")
    return run


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
        mode=run.mode or "prisma_scr",
        source_id=str(run.source_id) if run.source_id else None,
        seed=run.seed,
        saturation_threshold=run.saturation_threshold or 5,
        include_extraction=run.include_extraction if run.include_extraction is not None else True,
        stopped_at_saturation=run.stopped_at_saturation or False,
        agent_mode=run.agent_mode or "single",
        agent_pipeline=run.agent_pipeline,
        source_run_id=str(run.source_run_id) if run.source_run_id else None,
        abstract_only_count=run.abstract_only_count or 0,
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
    data = await svc.estimate_run(db, project.id, model, source_id=sid, agent_mode=agent_mode)
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
    run = await _require_run(run_id, project, db)
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
    """Return paginated LLM screening results for a run."""
    project = await _require_project(project_id, db, user)
    run = await _require_run(run_id, project, db)

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
    run = await _require_run(run_id, project, db)

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
    """Cohen's kappa given raw counts."""
    if total == 0:
        return None
    p_o = agreements / total
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
    run = await _require_run(run_id, project, db)

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
    human_decisions = (
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

    # Build per-record human decision map: {record_id: {stage: decision}}
    human_map: dict[uuid.UUID, dict[str, str]] = {}
    for hd in human_decisions:
        rid = hd.record_id
        if rid not in human_map:
            human_map[rid] = {}
        # Keep most-recent decision per stage (results ordered desc already)
        if hd.stage not in human_map[rid]:
            human_map[rid][hd.stage] = hd.decision

    # Load record titles for display
    recs = (
        await db.execute(select(Record).where(Record.id.in_(record_ids)))
    ).scalars().all()
    record_title_map = {r.id: r.title for r in recs}

    # Build comparison items
    items = []
    ta_compared = ta_agree = 0
    ft_compared = ft_agree = 0
    ta_include_rate_llm = ta_include_rate_human = 0.0
    ft_include_rate_llm = ft_include_rate_human = 0.0

    for res in llm_results:
        rid = res.record_id
        if rid is None:
            continue

        human_ta = human_map.get(rid, {}).get("TA")
        human_ft = human_map.get(rid, {}).get("FT")
        llm_ta = res.ta_decision
        llm_ft = res.ft_decision

        ta_agrees: Optional[bool] = None
        if llm_ta and human_ta:
            # Normalise uncertain → treat as exclude for kappa purposes
            llm_ta_norm = "include" if llm_ta == "include" else "exclude"
            ta_agrees = llm_ta_norm == human_ta
            ta_compared += 1
            if ta_agrees:
                ta_agree += 1

        ft_agrees: Optional[bool] = None
        if llm_ft and human_ft:
            llm_ft_norm = "include" if llm_ft == "include" else "exclude"
            ft_agrees = llm_ft_norm == human_ft
            ft_compared += 1
            if ft_agrees:
                ft_agree += 1

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

    # Compute kappa — expected agreement under independence
    def _p_e(n_agree: int, n_both: int, pA: float, pB: float) -> float:
        return pA * pB + (1 - pA) * (1 - pB)

    ta_pct: Optional[float] = None
    kappa_ta: Optional[float] = None
    if ta_compared > 0:
        ta_pct = round(ta_agree / ta_compared * 100, 1)
        # For kappa: both raters' include rate on the compared set
        llm_ta_inc = sum(
            1 for i in items if i["llm_ta"] == "include" and i["human_ta"] is not None
        )
        human_ta_inc = sum(
            1 for i in items if i["human_ta"] == "include" and i["llm_ta"] is not None
        )
        p_llm = llm_ta_inc / ta_compared
        p_human = human_ta_inc / ta_compared
        p_e = _p_e(ta_agree, ta_compared, p_llm, p_human)
        kappa_ta = _cohen_kappa_simple(ta_agree, ta_compared, p_e)
        if kappa_ta is not None:
            kappa_ta = round(kappa_ta, 3)

    ft_pct: Optional[float] = None
    kappa_ft: Optional[float] = None
    if ft_compared > 0:
        ft_pct = round(ft_agree / ft_compared * 100, 1)
        llm_ft_inc = sum(
            1 for i in items if i["llm_ft"] == "include" and i["human_ft"] is not None
        )
        human_ft_inc = sum(
            1 for i in items if i["human_ft"] == "include" and i["llm_ft"] is not None
        )
        p_llm = llm_ft_inc / ft_compared
        p_human = human_ft_inc / ft_compared
        p_e = _p_e(ft_agree, ft_compared, p_llm, p_human)
        kappa_ft = _cohen_kappa_simple(ft_agree, ft_compared, p_e)
        if kappa_ft is not None:
            kappa_ft = round(kappa_ft, 3)

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
        else:
            sd = ScreeningDecision(
                project_id=project.id,
                record_id=rid,
                cluster_id=None,
                stage=body.stage,
                decision=decision,
                reviewer_id=None,  # synthetic LLM reviewer
                notes=f"LLM: {run.model}",
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


# ---------------------------------------------------------------------------
# Sub-project export
# ---------------------------------------------------------------------------


class CreateSubprojectBody(BaseModel):
    name: str
    description: Optional[str] = None
    stage: str = "ta"  # "ta" | "ft"


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
    """Fork LLM-included papers into a new child project, pre-annotated with LLM output."""
    project = await _require_project(project_id, db, user, min_roles=_RUN_ROLES)
    run = await _require_run(run_id, project, db)

    if body.stage not in ("ta", "ft"):
        raise HTTPException(400, "stage must be 'ta' or 'ft'")

    try:
        result = await svc.create_subproject_from_run(
            db=db,
            project_id=project.id,
            run_id=run.id,
            name=body.name,
            description=body.description,
            stage=body.stage,
            triggered_by=user.id,
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
    run = await _require_run(run_id, project, db)

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
    run = await _require_run(run_id, project, db)

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
