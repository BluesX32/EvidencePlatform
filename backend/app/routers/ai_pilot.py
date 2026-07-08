"""
AI Pilot router — orchestrates AI at every step of the evidence synthesis pipeline.

Every endpoint is human-in-the-loop: AI proposes, human reviews via existing pages.

GET  /projects/{id}/ai-pilot-status          → pipeline status snapshot
POST /projects/{id}/ai-draft-setup           → AI drafts criteria + templates
POST /projects/{id}/auto-extract-all         → batch extraction (background task)
GET  /projects/{id}/auto-extract-all/status  → poll batch extraction progress
POST /projects/{id}/auto-concepts-all        → batch concept extraction (background)
GET  /projects/{id}/auto-concepts-all/status → poll batch concept progress
POST /projects/{id}/ai-suggest-themes        → suggest themes from extracted data
POST /projects/{id}/ai-resolve-all           → batch conflict resolution (background task)
GET  /projects/{id}/ai-resolve-all/status    → poll batch conflict-resolution progress
GET  /projects/{id}/ai-jobs                  → batch job history
POST /projects/{id}/ai-jobs/{job_id}/stop    → request an in-progress job to stop
GET  /projects/{id}/ai-jobs/{job_id}/results → what a specific job produced
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional

from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, SessionLocal
from app.dependencies import get_current_user, require_project_role, ADMIN_ROLE, REVIEWER_ROLE
from app.models.ai_job import AiJob
from app.models.concept_extraction import ConceptExtraction
from app.models.consensus_decision import ConsensusDecision
from app.models.source import Source
from app.models.extraction_record import ExtractionRecord
from app.models.llm_screening import LlmScreeningRun
from app.models.overlap_cluster import OverlapCluster
from app.models.ontology_node import OntologyNode
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.project import Project
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_decision import ScreeningDecision
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.services import llm_client
from app.services import llm_screening_service as svc
from app.services.concept_mention_service import sync_mentions_for_extraction
from app.services.consensus_service import detect_conflicts, adjudicate
from app.services.llm_client import LlmLogContext, set_llm_log_context

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["ai-pilot"])

# ---------------------------------------------------------------------------
# Batch job tracking — persistent rows in ai_jobs (survives restarts, shared
# across workers, and doubles as run history)
# ---------------------------------------------------------------------------

# A "running" job whose heartbeat is older than this was interrupted
# (e.g. server restart killed the background task) and must not block new runs.
_STALE_JOB_SECONDS = 300

# In-memory mirrors of ai_jobs.stop_requested / the background task handle, for
# immediate effect within this process (same pattern as llm_screening_service's
# _CANCEL_REQUESTS). The persisted `stop_requested` column is the source of
# truth across restarts; these sets just avoid a DB round-trip on every
# per-item loop iteration and let single-call jobs be cancelled outright.
_STOP_REQUESTS: set[uuid.UUID] = set()
_RUNNING_TASKS: Dict[uuid.UUID, asyncio.Task] = {}


def _job_payload(job: Optional[AiJob]) -> Dict[str, Any]:
    if job is None:
        return {"status": "idle"}
    return {
        "job_id": str(job.id),
        "job_type": job.job_type,
        "status": job.status,
        "done": job.done,
        "total": job.total,
        "errors": job.errors,
        "error": job.error_message,
        "model": job.model,
        "triggered_by": str(job.triggered_by) if job.triggered_by else None,
        "created_at": job.created_at.isoformat(),
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "stop_requested": job.stop_requested,
        "result": job.result_json,
    }


async def _latest_job(
    db: AsyncSession, project_id: uuid.UUID, job_type: str
) -> Optional[AiJob]:
    return (await db.execute(
        select(AiJob)
        .where(AiJob.project_id == project_id, AiJob.job_type == job_type)
        .order_by(AiJob.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _reap_if_stale(db: AsyncSession, job: Optional[AiJob]) -> bool:
    """Return True when job is genuinely still running.

    A running job with a stale heartbeat is marked failed so it stops
    blocking new runs and its history entry reflects the interruption.
    """
    if job is None or job.status != "running":
        return False
    age = datetime.now(tz=timezone.utc) - job.updated_at
    if age.total_seconds() < _STALE_JOB_SECONDS:
        return True
    job.status = "failed"
    job.error_message = "Interrupted — job stopped reporting progress (server restart?)"
    job.completed_at = datetime.now(tz=timezone.utc)
    await db.commit()
    return False


async def _current_job_payload(
    db: AsyncSession, project_id: uuid.UUID, job_type: str
) -> Dict[str, Any]:
    job = await _latest_job(db, project_id, job_type)
    await _reap_if_stale(db, job)
    return _job_payload(job)


async def _update_job(job_id: uuid.UUID, **values: Any) -> None:
    """Write job progress in its own session (heartbeat included) so the
    background task's work transaction stays untouched."""
    async with SessionLocal() as session:
        await session.execute(
            update(AiJob)
            .where(AiJob.id == job_id)
            .values(updated_at=func.now(), **values)
        )
        await session.commit()


async def _resolve_record_for_item(
    db: AsyncSession, record_id: Optional[uuid.UUID], cluster_id: Optional[uuid.UUID],
) -> Optional[Record]:
    """One representative Record for a screening slot (a direct record, or
    any member record of an overlap cluster) — shared by the extraction,
    concepts, and results-listing paths."""
    if record_id:
        return (await db.execute(select(Record).where(Record.id == record_id))).scalar_one_or_none()
    return (await db.execute(
        select(Record)
        .join(RecordSource, RecordSource.record_id == Record.id)
        .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
        .where(OverlapClusterMember.cluster_id == cluster_id)
        .limit(1)
    )).scalar_one_or_none()


def _stop_flag_set(job_id: uuid.UUID) -> bool:
    return job_id in _STOP_REQUESTS


async def _finish_job(job_id: uuid.UUID, *, done_status: str = "done", **extra: Any) -> None:
    """Resolve a job's terminal status, clear the in-memory stop bookkeeping,
    and write the final row. done_status is used unless a stop was requested,
    in which case status="stopped" regardless of how far the loop got."""
    status = "stopped" if job_id in _STOP_REQUESTS else done_status
    await _update_job(job_id, status=status, completed_at=func.now(), **extra)
    _STOP_REQUESTS.discard(job_id)
    _RUNNING_TASKS.pop(job_id, None)


@router.post("/{project_id}/ai-jobs/{job_id}/stop")
async def stop_ai_job(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Request an in-progress AI Pilot job to stop.

    Loop-based jobs (extract/concepts/resolve_conflicts) check this flag
    between items and stop before starting the next one — in-flight work
    finishes. Single-call jobs (suggest_themes/draft_setup) are cancelled
    outright via their tracked asyncio.Task, since there's no per-item
    boundary to stop at. Either way, re-running the same action afterward
    picks up any remaining work rather than starting over.
    """
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    job = (await db.execute(
        select(AiJob).where(AiJob.id == job_id, AiJob.project_id == project_id)
    )).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "running":
        raise HTTPException(400, f"Job is not running (status={job.status})")

    job.stop_requested = True
    await db.commit()
    _STOP_REQUESTS.add(job_id)
    task = _RUNNING_TASKS.get(job_id)
    if task is not None and not task.done():
        task.cancel()
    return {"status": "stopping"}


@router.get("/{project_id}/ai-jobs/{job_id}/results")
async def get_ai_job_results(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """What one specific AI Pilot job produced — always available regardless
    of whether the job is still running, stopped, done, or failed."""
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)
    job = (await db.execute(
        select(AiJob).where(AiJob.id == job_id, AiJob.project_id == project_id)
    )).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "Job not found")

    if job.job_type in ("suggest_themes", "draft_setup"):
        return {"job": _job_payload(job), "items": None}

    if job.job_type == "extract":
        model_cls, extra = ExtractionRecord, None
    elif job.job_type == "concepts":
        model_cls, extra = ConceptExtraction, None
    elif job.job_type == "resolve_conflicts":
        model_cls, extra = ConsensusDecision, ("stage", "decision", "notes")
    else:
        return {"job": _job_payload(job), "items": []}

    rows = (await db.execute(
        select(model_cls).where(model_cls.ai_job_id == job_id).order_by(model_cls.created_at)
    )).scalars().all()

    items = []
    for row in rows:
        record = await _resolve_record_for_item(db, row.record_id, row.cluster_id)
        item: Dict[str, Any] = {
            "record_id": str(row.record_id) if row.record_id else None,
            "cluster_id": str(row.cluster_id) if row.cluster_id else None,
            "title": record.title if record else None,
            "created_at": row.created_at.isoformat(),
        }
        if extra:
            for field in extra:
                item[field] = getattr(row, field)
        items.append(item)

    return {"job": _job_payload(job), "items": items}


# ---------------------------------------------------------------------------
# LLM call helper — thin wrapper over the central gateway (app.services.llm_client)
# ---------------------------------------------------------------------------

def _resolve_anthropic_key(user: User) -> Optional[str]:
    keys = user.api_keys or {}
    return keys.get("anthropic") or os.environ.get("ANTHROPIC_API_KEY")


def _resolve_openrouter_key(user: User) -> Optional[str]:
    keys = user.api_keys or {}
    return keys.get("openrouter") or os.environ.get("OPENROUTER_API_KEY")


async def _llm_call(
    anthropic_key: Optional[str],
    openrouter_key: Optional[str],
    model: str,
    system: str,
    prompt: str,
    max_tokens: int = 2048,
    *,
    feature: str,
    project_id: Optional[uuid.UUID] = None,
    user_id: Optional[uuid.UUID] = None,
    ai_job_id: Optional[uuid.UUID] = None,
) -> llm_client.LlmResult:
    """Call LLM via the central gateway (audited to llm_calls), return the result
    (text + usage + the created llm_calls.id, for callers that need to link a
    downstream artifact back to the exact call that produced it)."""
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
            user_id=user_id,
            ai_job_id=ai_job_id,
        )
    except ValueError as exc:  # no usable API key for this model
        raise HTTPException(400, str(exc))
    return result


async def _record_oneshot_job(
    db: AsyncSession, project_id: uuid.UUID, job_type: str, model: str, user_id: uuid.UUID,
    *, status: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None,
) -> None:
    """Persist a one-shot AI action (draft_setup, suggest_themes) as an AiJob
    row so its result stays visible via "View AI Results" after the request
    completes. These are single LLM calls, not loops — there's no per-item
    boundary to stop at, so unlike the batch jobs above this is a history
    record only, not a stoppable/resumable run."""
    db.add(AiJob(
        project_id=project_id, job_type=job_type, status=status, model=model,
        triggered_by=user_id, total=1, done=1 if status == "done" else 0,
        errors=0 if status == "done" else 1, error_message=error, result_json=result,
        completed_at=func.now(),
    ))
    await db.commit()


def _parse_json_response(text: str) -> Any:
    """Strip markdown fences then JSON-parse."""
    t = text.strip()
    if t.startswith("```"):
        parts = t.split("```")
        t = parts[1] if len(parts) > 1 else t
        if t.startswith("json"):
            t = t[4:]
    return json.loads(t.strip())


def _quote_is_grounded(source_text: str, quote: str) -> bool:
    """Whitespace/case-normalized substring check. Never fabricate a locator
    for a quote the model didn't actually copy from the supplied text —
    ungrounded quotes are recorded as such, not silently accepted."""
    norm_quote = " ".join(quote.split()).casefold()
    if not norm_quote:
        return False
    norm_source = " ".join(source_text.split()).casefold()
    return norm_quote in norm_source


# ---------------------------------------------------------------------------
# 1. Pipeline status
# ---------------------------------------------------------------------------

@router.get("/{project_id}/ai-pilot-status")
async def get_pilot_status(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Return a snapshot of every pipeline stage so the AI Pilot page can render status."""
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    pid = project_id

    # ── Criteria ─────────────────────────────────────────────────────────────
    criteria = project.criteria or {}
    has_criteria = bool(criteria.get("inclusion") or criteria.get("exclusion"))

    # ── Import ────────────────────────────────────────────────────────────────
    source_count = (await db.execute(
        select(func.count()).select_from(Source).where(Source.project_id == pid)
    )).scalar() or 0

    record_count = (await db.execute(
        select(func.count()).select_from(RecordSource)
        .join(Source, Source.id == RecordSource.source_id)
        .where(Source.project_id == pid)
    )).scalar() or 0

    # ── Dedup ─────────────────────────────────────────────────────────────────
    cluster_count = (await db.execute(
        select(func.count()).select_from(OverlapCluster).where(OverlapCluster.project_id == pid)
    )).scalar() or 0

    # ── Screening ─────────────────────────────────────────────────────────────
    ft_included = (await db.execute(
        select(func.count()).select_from(ScreeningDecision).where(
            ScreeningDecision.project_id == pid,
            ScreeningDecision.stage == "FT",
            ScreeningDecision.decision == "include",
        )
    )).scalar() or 0

    latest_run_row = (await db.execute(
        select(LlmScreeningRun)
        .where(LlmScreeningRun.project_id == pid)
        .order_by(LlmScreeningRun.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()

    llm_run = None
    if latest_run_row:
        total = latest_run_row.total_records or 0
        done = latest_run_row.processed_records or 0
        llm_run = {
            "id": str(latest_run_row.id),
            "status": latest_run_row.status,
            "model": latest_run_row.model,
            "total": total,
            "done": done,
            "pct": round(done / total * 100) if total else 0,
        }

    # ── Extraction ────────────────────────────────────────────────────────────
    extracted_count = (await db.execute(
        select(func.count(ExtractionRecord.id.distinct())).where(
            ExtractionRecord.project_id == pid
        )
    )).scalar() or 0

    extract_job = await _current_job_payload(db, pid, "extract")

    # ── Concepts ─────────────────────────────────────────────────────────────
    concept_count = (await db.execute(
        select(func.count(ConceptExtraction.id.distinct())).where(
            ConceptExtraction.project_id == pid
        )
    )).scalar() or 0

    concepts_job = await _current_job_payload(db, pid, "concepts")

    # ── Thematic ─────────────────────────────────────────────────────────────
    theme_count = (await db.execute(
        select(func.count()).select_from(OntologyNode).where(
            OntologyNode.project_id == pid,
            OntologyNode.namespace == "theme",
        )
    )).scalar() or 0

    code_count = (await db.execute(
        select(func.count()).select_from(OntologyNode).where(
            OntologyNode.project_id == pid,
            OntologyNode.namespace == "code",
        )
    )).scalar() or 0

    # ── Conflicts ─────────────────────────────────────────────────────────────
    conflicts = await detect_conflicts(db, pid, only_unresolved=True)
    resolve_job = await _current_job_payload(db, pid, "resolve_conflicts")

    return {
        "setup": {
            "has_criteria": has_criteria,
            "has_extraction_template": bool(project.extraction_template),
            "has_concept_template": bool(project.concept_template),
        },
        "import": {
            "source_count": source_count,
            "record_count": record_count,
        },
        "dedup": {
            "cluster_count": cluster_count,
        },
        "screening": {
            "ft_included_count": ft_included,
            "llm_run": llm_run,
        },
        "extraction": {
            "extracted_count": extracted_count,
            "ft_included_count": ft_included,
            "batch_job": extract_job,
        },
        "concepts": {
            "concept_count": concept_count,
            "batch_job": concepts_job,
        },
        "thematic": {
            "theme_count": theme_count,
            "code_count": code_count,
        },
        "conflicts": {
            "unresolved_count": len(conflicts),
            "batch_job": resolve_job,
        },
    }


# ---------------------------------------------------------------------------
# 2. AI project setup — draft criteria + extraction + concept templates
# ---------------------------------------------------------------------------

class DraftSetupRequest(BaseModel):
    research_question: str
    model: str = "anthropic/claude-haiku-4-5"


@router.post("/{project_id}/ai-draft-setup")
async def ai_draft_setup(
    project_id: uuid.UUID,
    body: DraftSetupRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Ask the LLM to suggest criteria, extraction template, and concept template for a research question."""
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured")

    system = (
        "You are an expert systematic reviewer. Given a research question, "
        "return a JSON object with three sections that a researcher can use as a starting point. "
        "Return only valid JSON, no markdown fences."
    )
    prompt = f"""Research question: "{body.research_question}"

Return a JSON object with these keys:
- "criteria": {{
    "inclusion": [{{ "text": "criterion", "active": true }}, ...],
    "exclusion": [{{ "text": "criterion", "active": true }}, ...]
  }}
  (3-6 inclusion and 3-6 exclusion criteria typical for this type of review)

- "extraction_template": {{
    "rows": [
      {{ "id": "r1", "domain": "Study Design", "item": "Study type", "type": "text", "options": [] }},
      ...
    ]
  }}
  (8-12 fields covering population, intervention, outcome, study design, setting, sample size, key findings, limitations)

- "concept_template": {{
    "fields": [
      {{ "id": "f1", "label": "Key Concept", "field_type": "entity", "input_type": "string", "options": [], "allow_custom_options": false }},
      ...
    ]
  }}
  (4-6 concept fields suited to this research question)

The extraction_template row ids must be unique strings like r1, r2, etc.
The concept_template field ids must be unique strings like f1, f2, etc.
"""
    try:
        raw = await _llm_call(
            anthropic_key, openrouter_key, body.model, system, prompt, max_tokens=3000,
            feature="ai_pilot.draft_setup", project_id=project_id, user_id=user.id,
        )
        result = _parse_json_response(raw.text)
    except json.JSONDecodeError:
        await _record_oneshot_job(db, project_id, "draft_setup", body.model, user.id,
                                   status="failed", error="AI returned invalid JSON")
        raise HTTPException(502, "AI returned invalid JSON — please retry")
    except Exception as exc:
        await _record_oneshot_job(db, project_id, "draft_setup", body.model, user.id,
                                   status="failed", error=str(exc))
        raise HTTPException(502, f"LLM call failed: {exc}")

    await _record_oneshot_job(db, project_id, "draft_setup", body.model, user.id,
                               status="done", result=result)
    return result


# ---------------------------------------------------------------------------
# 3. Bulk extraction
# ---------------------------------------------------------------------------

class BatchJobRequest(BaseModel):
    model: str = "anthropic/claude-haiku-4-5"


@router.post("/{project_id}/auto-extract-all")
async def start_bulk_extraction(
    project_id: uuid.UUID,
    body: BatchJobRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Start a background task that AI-extracts all FT-included papers without extractions."""
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    project = await ProjectRepo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if not (project.extraction_template or {}).get("rows"):
        raise HTTPException(400, "Project has no extraction template — configure it first")

    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured")

    existing = await _latest_job(db, project_id, "extract")
    if await _reap_if_stale(db, existing):
        return _job_payload(existing)

    job = AiJob(
        project_id=project_id, job_type="extract",
        status="running", model=body.model, triggered_by=user.id,
    )
    db.add(job)
    await db.commit()
    job_id = job.id

    # Capture primitives — the user/db session is closed before background task runs
    user_id = user.id
    extraction_template = project.extraction_template or {}
    llm_config = project.llm_config or {}

    async def _run() -> None:
        set_llm_log_context(LlmLogContext(
            feature="ai_pilot.extract", project_id=project_id, user_id=user_id, ai_job_id=job_id,
        ))
        done = 0
        errors = 0
        try:
            async with SessionLocal() as db2:
                # FT-included items this reviewer hasn't extracted yet
                included_q = select(
                    ScreeningDecision.record_id, ScreeningDecision.cluster_id
                ).where(
                    ScreeningDecision.project_id == project_id,
                    ScreeningDecision.stage == "FT",
                    ScreeningDecision.decision == "include",
                ).distinct()
                included_rows = (await db2.execute(included_q)).all()

                targets = []
                for row in included_rows:
                    filt = (
                        (ExtractionRecord.record_id == row.record_id)
                        if row.record_id
                        else (ExtractionRecord.cluster_id == row.cluster_id)
                    )
                    existing = (await db2.execute(
                        select(ExtractionRecord.id).where(
                            ExtractionRecord.project_id == project_id,
                            filt,
                            ExtractionRecord.reviewer_id == user_id,
                        ).limit(1)
                    )).scalar_one_or_none()
                    if existing is None:
                        targets.append((row.record_id, row.cluster_id))

                await _update_job(job_id, total=len(targets))

                for rec_id, cl_id in targets:
                    if _stop_flag_set(job_id):
                        break
                    try:
                        record = await _resolve_record_for_item(db2, rec_id, cl_id)

                        if not record:
                            done += 1
                            await _update_job(job_id, done=done)
                            continue

                        result = await svc._extract_one_record(
                            record=record,
                            full_text=None,
                            extraction_template=extraction_template,
                            llm_config=llm_config,
                            model=body.model,
                            anthropic_api_key=anthropic_key,
                            openrouter_api_key=openrouter_key,
                        )
                        if result:
                            er = ExtractionRecord(
                                project_id=project_id,
                                record_id=rec_id,
                                cluster_id=cl_id,
                                extracted_json={"table": result},
                                reviewer_id=user_id,
                                origin="ai",
                                ai_job_id=job_id,
                            )
                            db2.add(er)
                            await db2.flush()
                    except Exception as e:
                        logger.warning("bulk extract error for record=%s: %s", rec_id or cl_id, e)
                        errors += 1

                    done += 1
                    await _update_job(job_id, done=done, errors=errors)

                await db2.commit()
                await _finish_job(job_id)
        except Exception as exc:
            logger.exception("bulk extraction failed for project %s", project_id)
            await _update_job(
                job_id, status="failed", error_message=str(exc), completed_at=func.now()
            )
            _STOP_REQUESTS.discard(job_id)

    background_tasks.add_task(_run)
    return _job_payload(job)


@router.get("/{project_id}/auto-extract-all/status")
async def bulk_extraction_status(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)
    return await _current_job_payload(db, project_id, "extract")


# ---------------------------------------------------------------------------
# 4. Bulk concept extraction
# ---------------------------------------------------------------------------

@router.post("/{project_id}/auto-concepts-all")
async def start_bulk_concepts(
    project_id: uuid.UUID,
    body: BatchJobRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Start a background task that AI-suggests concepts for all FT-included papers."""
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    project = await ProjectRepo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    concept_template = project.concept_template or {}
    if not concept_template.get("fields"):
        raise HTTPException(400, "Project has no concept template — configure it first")

    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured")

    existing = await _latest_job(db, project_id, "concepts")
    if await _reap_if_stale(db, existing):
        return _job_payload(existing)

    job = AiJob(
        project_id=project_id, job_type="concepts",
        status="running", model=body.model, triggered_by=user.id,
    )
    db.add(job)
    await db.commit()
    job_id = job.id

    # Capture primitives before the request session closes
    user_id = user.id
    fields = concept_template.get("fields", [])
    ai_instructions = concept_template.get("ai_instructions", "")
    base_system = "You are an expert qualitative researcher extracting structured concepts from academic papers. Extract only what is explicitly stated. Return a JSON object with field ids as keys and arrays of string values."
    system_prompt = f"{base_system}\n\n{ai_instructions}".strip() if ai_instructions else base_system

    field_map = {f["id"]: f for f in fields}

    async def _run() -> None:
        set_llm_log_context(LlmLogContext(
            feature="ai_pilot.concepts", project_id=project_id, user_id=user_id, ai_job_id=job_id,
        ))
        done = 0
        errors = 0
        try:
            async with SessionLocal() as db2:
                included_q = select(
                    ScreeningDecision.record_id, ScreeningDecision.cluster_id
                ).where(
                    ScreeningDecision.project_id == project_id,
                    ScreeningDecision.stage == "FT",
                    ScreeningDecision.decision == "include",
                ).distinct()
                included_rows = (await db2.execute(included_q)).all()

                targets = []
                for row in included_rows:
                    filt = (
                        (ConceptExtraction.record_id == row.record_id)
                        if row.record_id
                        else (ConceptExtraction.cluster_id == row.cluster_id)
                    )
                    existing = (await db2.execute(
                        select(ConceptExtraction.id).where(
                            ConceptExtraction.project_id == project_id,
                            filt,
                            ConceptExtraction.reviewer_id == user_id,
                        ).limit(1)
                    )).scalar_one_or_none()
                    if existing is None:
                        targets.append((row.record_id, row.cluster_id))

                await _update_job(job_id, total=len(targets))

                for rec_id, cl_id in targets:
                    if _stop_flag_set(job_id):
                        break
                    try:
                        record = await _resolve_record_for_item(db2, rec_id, cl_id)

                        if not record:
                            done += 1
                            await _update_job(job_id, done=done)
                            continue

                        field_lines = [
                            f'  "{f["id"]}": [{{"value": "extracted {f.get("label","?")} value", '
                            f'"quote": "verbatim supporting phrase copied exactly from the title or abstract"}}]'
                            for f in fields
                        ]
                        prompt = (
                            f"## Paper\n**Title**: {record.title or '(no title)'}\n"
                            + (f"**Abstract**: {record.abstract}\n" if record.abstract else "")
                            + "\n## Concept Fields\nReturn a JSON object with these keys, each an array of objects:\n{\n"
                            + ",\n".join(field_lines)
                            + "\n}\nFor each field, list ALL values found. 'quote' must be copied verbatim "
                              "from the title or abstract above — use an empty string if no exact supporting "
                              "phrase exists. Empty array if no values for a field."
                        )

                        result = await _llm_call(
                            anthropic_key, openrouter_key, body.model, system_prompt, prompt, max_tokens=1500,
                            feature="ai_pilot.concepts", project_id=project_id, user_id=user_id, ai_job_id=job_id,
                        )
                        try:
                            parsed = _parse_json_response(result.text)
                        except Exception:
                            parsed = {}

                        source_text = f"{record.title or ''} {record.abstract or ''}"
                        cells: Dict[str, List[str]] = {}
                        grounding: Dict[str, Dict[str, Any]] = {}
                        for field_id, arr in (parsed.items() if isinstance(parsed, dict) else []):
                            if not isinstance(arr, list):
                                continue
                            values: List[str] = []
                            field_grounding: Dict[str, Any] = {}
                            for entry in arr:
                                if isinstance(entry, dict):
                                    v = str(entry.get("value", "")).strip()
                                    q = entry.get("quote")
                                    q = q.strip() if isinstance(q, str) else None
                                else:
                                    # Model didn't follow the {value, quote} schema — keep the
                                    # value, record it as ungrounded rather than fabricating a quote.
                                    v = str(entry).strip()
                                    q = None
                                if not v:
                                    continue
                                grounded = bool(q) and _quote_is_grounded(source_text, q)
                                values.append(v)
                                field_grounding[v] = {
                                    "quote": q if grounded else None,
                                    "grounded": grounded,
                                    "document": "title_abstract",
                                }
                            if values:
                                cells[field_id] = values
                                grounding[field_id] = field_grounding

                        if cells:
                            ce = ConceptExtraction(
                                project_id=project_id,
                                record_id=rec_id,
                                cluster_id=cl_id,
                                extracted_json={"cells": cells, "grounding": grounding},
                                reviewer_id=user_id,
                                origin="ai",
                                ai_job_id=job_id,
                            )
                            db2.add(ce)
                            await db2.flush()
                            await sync_mentions_for_extraction(
                                db2, ce, field_map=field_map,
                                ai_job_id=job_id, llm_call_id=result.call_id,
                            )
                    except Exception as e:
                        logger.warning("bulk concepts error for record=%s: %s", rec_id or cl_id, e)
                        errors += 1

                    done += 1
                    await _update_job(job_id, done=done, errors=errors)

                await db2.commit()
                await _finish_job(job_id)
        except Exception as exc:
            logger.exception("bulk concepts failed for project %s", project_id)
            await _update_job(
                job_id, status="failed", error_message=str(exc), completed_at=func.now()
            )
            _STOP_REQUESTS.discard(job_id)

    background_tasks.add_task(_run)
    return _job_payload(job)


@router.get("/{project_id}/auto-concepts-all/status")
async def bulk_concepts_status(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)
    return await _current_job_payload(db, project_id, "concepts")


@router.get("/{project_id}/ai-jobs")
async def list_ai_jobs(
    project_id: uuid.UUID,
    job_type: Optional[str] = None,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Run history for AI Pilot batch jobs, newest first."""
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)
    q = select(AiJob).where(AiJob.project_id == project_id)
    if job_type:
        q = q.where(AiJob.job_type == job_type)
    jobs = (await db.execute(
        q.order_by(AiJob.created_at.desc()).limit(min(max(limit, 1), 100))
    )).scalars().all()
    return {"jobs": [_job_payload(j) for j in jobs]}


# ---------------------------------------------------------------------------
# 5. AI theme suggestions
# ---------------------------------------------------------------------------

class SuggestThemesRequest(BaseModel):
    model: str = "anthropic/claude-haiku-4-5"
    focus_question: Optional[str] = None
    max_papers: int = 40


@router.post("/{project_id}/ai-suggest-themes")
async def suggest_themes(
    project_id: uuid.UUID,
    body: SuggestThemesRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Read extracted data and propose a thematic structure."""
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured")

    # Fetch extraction records
    rows = (await db.execute(
        select(ExtractionRecord).where(
            ExtractionRecord.project_id == project_id,
            ExtractionRecord.extracted_json.isnot(None),
        ).limit(body.max_papers)
    )).scalars().all()

    if not rows:
        raise HTTPException(400, "No extraction data found — extract papers first")

    # Summarise extracted data for the prompt
    summaries: List[str] = []
    for i, er in enumerate(rows, 1):
        ej = er.extracted_json or {}
        table = ej.get("table") or {}
        if table:
            items = "; ".join(f"{k}: {v}" for k, v in list(table.items())[:6] if v)
            summaries.append(f"Paper {i}: {items}")
        elif ej.get("free_note"):
            summaries.append(f"Paper {i}: {ej['free_note'][:300]}")

    if not summaries:
        raise HTTPException(400, "Extraction records have no data to analyse")

    focus_note = f"\nFocus question: {body.focus_question}" if body.focus_question else ""
    prompt = f"""Below are summaries of {len(summaries)} extracted papers from a systematic review.{focus_note}

{chr(10).join(summaries[:40])}

Identify 4-8 recurring themes that cut across these papers. Return a JSON object:
{{
  "themes": [
    {{
      "name": "Theme name (3-5 words)",
      "description": "One sentence describing what this theme covers.",
      "rationale": "Why this theme emerged from the data (1-2 sentences)."
    }},
    ...
  ]
}}

Return only valid JSON, no markdown fences."""

    system = "You are an expert qualitative researcher specialising in thematic synthesis of systematic review data."

    try:
        raw = await _llm_call(
            anthropic_key, openrouter_key, body.model, system, prompt, max_tokens=2000,
            feature="ai_pilot.suggest_themes", project_id=project_id, user_id=user.id,
        )
        result = _parse_json_response(raw.text)
    except json.JSONDecodeError:
        await _record_oneshot_job(db, project_id, "suggest_themes", body.model, user.id,
                                   status="failed", error="AI returned invalid JSON")
        raise HTTPException(502, "AI returned invalid JSON — please retry")
    except Exception as exc:
        await _record_oneshot_job(db, project_id, "suggest_themes", body.model, user.id,
                                   status="failed", error=str(exc))
        raise HTTPException(502, f"LLM call failed: {exc}")

    await _record_oneshot_job(db, project_id, "suggest_themes", body.model, user.id,
                               status="done", result=result)
    return result


# ---------------------------------------------------------------------------
# 6. Bulk conflict resolution
# ---------------------------------------------------------------------------

class ResolveAllRequest(BaseModel):
    model: str = "anthropic/claude-haiku-4-5"
    stage: Optional[str] = None  # None = all stages


@router.post("/{project_id}/ai-resolve-all")
async def ai_resolve_all(
    project_id: uuid.UUID,
    body: ResolveAllRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Start a background task that asks the AI to resolve every unresolved
    conflict and applies each resolution. Same job-tracked pattern as bulk
    extraction/concepts: stoppable mid-run, and re-running afterward only
    considers conflicts still unresolved."""
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    anthropic_key = _resolve_anthropic_key(user)
    openrouter_key = _resolve_openrouter_key(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(400, "No API key configured")

    existing = await _latest_job(db, project_id, "resolve_conflicts")
    if await _reap_if_stale(db, existing):
        return _job_payload(existing)

    job = AiJob(
        project_id=project_id, job_type="resolve_conflicts",
        status="running", model=body.model, triggered_by=user.id,
    )
    db.add(job)
    await db.commit()
    job_id = job.id

    user_id = user.id
    stage = body.stage
    system = "You are an expert systematic reviewer. Given two reviewers' screening decisions and notes, suggest the correct resolution. Return a JSON object with exactly two keys: 'decision' (either 'include' or 'exclude') and 'rationale' (one sentence). Return only valid JSON."

    async def _run() -> None:
        set_llm_log_context(LlmLogContext(
            feature="ai_pilot.resolve_conflicts", project_id=project_id, user_id=user_id, ai_job_id=job_id,
        ))
        done = 0
        errors = 0
        try:
            async with SessionLocal() as db2:
                conflicts = await detect_conflicts(db2, project_id, stage=stage, only_unresolved=True)
                await _update_job(job_id, total=len(conflicts))

                for conflict in conflicts:
                    if _stop_flag_set(job_id):
                        break
                    try:
                        decisions_text = "\n".join(
                            f"Reviewer {i+1}: {d['decision']}" + (f" — {d['notes']}" if d.get("notes") else "")
                            for i, d in enumerate(conflict["decisions"])
                        )
                        prompt = (
                            f"Stage: {conflict['stage']}\nReviewer decisions:\n{decisions_text}\n\n"
                            "Should this paper be included or excluded? Return JSON with 'decision' and 'rationale'."
                        )

                        raw = await _llm_call(
                            anthropic_key, openrouter_key, body.model, system, prompt, max_tokens=200,
                            feature="ai_pilot.resolve_conflicts", project_id=project_id, user_id=user_id, ai_job_id=job_id,
                        )
                        parsed = _parse_json_response(raw.text)
                        decision = parsed.get("decision", "").lower()
                        rationale = parsed.get("rationale", "AI-assisted resolution")

                        if decision not in ("include", "exclude"):
                            errors += 1
                        else:
                            record_id = uuid.UUID(conflict["record_id"]) if conflict.get("record_id") else None
                            cluster_id = uuid.UUID(conflict["cluster_id"]) if conflict.get("cluster_id") else None

                            cd = await adjudicate(
                                db=db2,
                                project_id=project_id,
                                record_id=record_id,
                                cluster_id=cluster_id,
                                stage=conflict["stage"],
                                decision=decision,
                                adjudicator_id=user_id,
                                notes=f"[AI] {rationale}",
                                origin="ai",
                            )
                            cd.ai_job_id = job_id
                    except Exception as e:
                        logger.warning("ai-resolve-all conflict error: %s", e)
                        errors += 1

                    done += 1
                    await _update_job(job_id, done=done, errors=errors)

                await db2.commit()
                await _finish_job(job_id)
        except Exception as exc:
            logger.exception("ai-resolve-all failed for project %s", project_id)
            await _update_job(
                job_id, status="failed", error_message=str(exc), completed_at=func.now()
            )
            _STOP_REQUESTS.discard(job_id)

    background_tasks.add_task(_run)
    return _job_payload(job)


@router.get("/{project_id}/ai-resolve-all/status")
async def ai_resolve_all_status(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)
    return await _current_job_payload(db, project_id, "resolve_conflicts")
