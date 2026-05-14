"""LLM screening service.

Supports two provider backends, auto-selected by model name and env vars:

  1. Anthropic SDK (direct) — used when model starts with "claude-" and
     ANTHROPIC_API_KEY is set.  Uses native tool_use for structured output.

  2. OpenRouter (universal gateway) — used for all other models, and as a
     fallback for Claude when only OPENROUTER_API_KEY is set.  Uses the
     OpenAI-compatible API with function calling.
     See https://openrouter.ai for model catalogue and pricing.

Workflow:
  1. estimate_run()         → cost/time preview (no DB side effects)
  2. create_and_launch_run() → creates LlmScreeningRun row, fires background task
  3. _execute_run()          → background task: screens every record in parallel
     OR _execute_run_saturation() for corpus-by-corpus saturation mode

Rate limiting: asyncio.Semaphore(CONCURRENT_REQUESTS = 8) — PRISMA mode only
Saturation mode processes records sequentially (order matters for saturation counter).
Retry: exponential backoff on rate-limit errors (max 3 retries)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from fastapi import BackgroundTasks
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal
from app.models.extraction_record import ExtractionRecord
from app.models.import_job import ImportJob
from app.models.llm_screening import LlmScreeningResult, LlmScreeningRun
from app.models.ontology_node import OntologyNode
from app.models.project import Project
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_decision import ScreeningDecision
from app.models.screening_queue import ScreeningQueue
from app.models.source import Source
from app.models.user import User
from app.utils.fulltext_fetcher import get_full_text

logger = logging.getLogger(__name__)

CONCURRENT_REQUESTS = 8

# ---------------------------------------------------------------------------
# Pricing table (USD per token) — covers direct Anthropic + OpenRouter models
# OpenRouter prices: https://openrouter.ai/models
# ---------------------------------------------------------------------------

_PRICING: dict[str, tuple[float, float]] = {
    # ── Claude (Anthropic direct or via OpenRouter) ────────────────────────
    "claude-haiku-4-5-20251001":          (0.80 / 1_000_000,   4.00 / 1_000_000),
    "claude-sonnet-4-6":                  (3.00 / 1_000_000,  15.00 / 1_000_000),
    "claude-opus-4-6":                    (15.00 / 1_000_000, 75.00 / 1_000_000),
    # ── OpenAI via OpenRouter ─────────────────────────────────────────────
    "openai/gpt-4o-mini":                 (0.15 / 1_000_000,   0.60 / 1_000_000),
    "openai/gpt-4o":                      (2.50 / 1_000_000,  10.00 / 1_000_000),
    "openai/o1-mini":                     (1.10 / 1_000_000,   4.40 / 1_000_000),
    "openai/o3-mini":                     (1.10 / 1_000_000,   4.40 / 1_000_000),
    "openai/gpt-5.3-chat":                (8.00 / 1_000_000,  24.00 / 1_000_000),
    "openai/gpt-5.4":                     (10.00 / 1_000_000, 30.00 / 1_000_000),
    "openai/gpt-5.4-pro":                 (117.00 / 1_000_000, 117.00 / 1_000_000),
    # ── Google Gemini via OpenRouter ──────────────────────────────────────
    "google/gemini-flash-1.5":            (0.075 / 1_000_000,  0.30 / 1_000_000),
    "google/gemini-pro-1.5":              (1.25 / 1_000_000,   5.00 / 1_000_000),
    "google/gemini-2.0-flash-001":        (0.10 / 1_000_000,   0.40 / 1_000_000),
    "google/gemini-2.5-pro-preview":      (1.25 / 1_000_000,  10.00 / 1_000_000),
    "google/gemini-3-flash-preview":      (0.15 / 1_000_000,   0.60 / 1_000_000),
    "google/gemini-3.1-flash-lite-preview": (0.05 / 1_000_000, 0.20 / 1_000_000),
    "google/gemini-3.1-pro-preview":      (8.00 / 1_000_000,  24.00 / 1_000_000),
    # ── Meta Llama via OpenRouter ─────────────────────────────────────────
    "meta-llama/llama-3.3-70b-instruct":  (0.12 / 1_000_000,  0.30 / 1_000_000),
    "meta-llama/llama-3.1-405b-instruct": (2.70 / 1_000_000,  2.70 / 1_000_000),
    "meta-llama/llama-4-scout":           (0.15 / 1_000_000,  0.60 / 1_000_000),
    "meta-llama/llama-4-maverick":        (0.90 / 1_000_000,  2.70 / 1_000_000),
    # ── Mistral via OpenRouter ─────────────────────────────────────────────
    "mistralai/mistral-small":            (0.10 / 1_000_000,   0.30 / 1_000_000),
    "mistralai/mistral-small-3.1":        (0.10 / 1_000_000,   0.30 / 1_000_000),
    "mistralai/mistral-large":            (2.00 / 1_000_000,   6.00 / 1_000_000),
    "mistralai/mistral-large-2512":       (1.35 / 1_000_000,   4.05 / 1_000_000),
    "mistralai/ministral-8b-2512":        (0.28 / 1_000_000,   0.84 / 1_000_000),
    # ── DeepSeek via OpenRouter ───────────────────────────────────────────
    "deepseek/deepseek-chat":             (0.14 / 1_000_000,   0.28 / 1_000_000),
    "deepseek/deepseek-r1":               (0.55 / 1_000_000,   2.19 / 1_000_000),
    "deepseek/deepseek-v3.2":             (0.55 / 1_000_000,   1.65 / 1_000_000),
    # ── Qwen (Alibaba) via OpenRouter ────────────────────────────────────
    "qwen/qwen3.5-plus-02-15":            (0.50 / 1_000_000,   1.50 / 1_000_000),
    "qwen/qwen3-max-thinking":            (1.80 / 1_000_000,   5.40 / 1_000_000),
    # ── NVIDIA Nemotron (free) via OpenRouter ─────────────────────────────
    "nemotron/nemotron-3-super":          (0.00 / 1_000_000,   0.00 / 1_000_000),
    # ── Cohere via OpenRouter ─────────────────────────────────────────────
    "cohere/command-a-03-2025":           (2.50 / 1_000_000,  10.00 / 1_000_000),
}

_MINUTES_PER_RECORD: dict[str, float] = {
    "claude-haiku-4-5-20251001":            0.008,
    "claude-sonnet-4-6":                    0.015,
    "claude-opus-4-6":                      0.020,
    "openai/gpt-4o-mini":                   0.007,
    "openai/gpt-4o":                        0.012,
    "openai/o1-mini":                       0.018,
    "openai/o3-mini":                       0.018,
    "openai/gpt-5.3-chat":                  0.013,
    "openai/gpt-5.4":                       0.014,
    "openai/gpt-5.4-pro":                   0.025,
    "google/gemini-flash-1.5":              0.006,
    "google/gemini-pro-1.5":                0.014,
    "google/gemini-2.0-flash-001":          0.006,
    "google/gemini-2.5-pro-preview":        0.016,
    "google/gemini-3-flash-preview":        0.005,
    "google/gemini-3.1-flash-lite-preview": 0.004,
    "google/gemini-3.1-pro-preview":        0.014,
    "meta-llama/llama-3.3-70b-instruct":    0.010,
    "meta-llama/llama-3.1-405b-instruct":   0.018,
    "meta-llama/llama-4-scout":             0.008,
    "meta-llama/llama-4-maverick":          0.012,
    "mistralai/mistral-small":              0.008,
    "mistralai/mistral-small-3.1":          0.008,
    "mistralai/mistral-large":              0.012,
    "mistralai/mistral-large-2512":         0.011,
    "mistralai/ministral-8b-2512":          0.007,
    "deepseek/deepseek-chat":               0.009,
    "deepseek/deepseek-r1":                 0.020,
    "deepseek/deepseek-v3.2":              0.009,
    "qwen/qwen3.5-plus-02-15":              0.010,
    "qwen/qwen3-max-thinking":              0.022,
    "nemotron/nemotron-3-super":            0.010,
    "cohere/command-a-03-2025":             0.012,
}

_DEFAULT_MODEL = "claude-sonnet-4-6"

# Estimated tokens per record (abstract-only baseline)
_AVG_INPUT_TOKENS = 1500
_AVG_OUTPUT_TOKENS = 400

# Per-stage token estimates (used for adaptive cost estimation)
_STAGE_AVG_INPUT: dict[str, int] = {
    "ta":       800,   # title + abstract + criteria only
    "ft":      3200,   # criteria + full text (when available)
    "extract": 2800,   # extraction template + full text
    "verify":  1200,   # record summary + previous decisions
    "single":  1500,   # combined TA+FT in one call (current baseline)
}
_STAGE_AVG_OUTPUT: dict[str, int] = {
    "ta":      200,
    "ft":      280,
    "extract": 320,
    "verify":  180,
    "single":  400,
}
# Fraction of records expected to reach each stage (empirical priors for systematic reviews)
_STAGE_REACH: dict[str, float] = {
    "ta":      1.00,   # all records go through TA
    "ft":      0.30,   # ~30% pass TA screening
    "extract": 0.15,   # ~50% of FT-included → 15% of total
    "verify":  0.30,   # verifier only checks TA-included records (~30%)
    "single":  1.00,   # single agent sees all records
}

# ---------------------------------------------------------------------------
# Default agent pipelines
# ---------------------------------------------------------------------------

DEFAULT_SINGLE_PIPELINE: list[dict] = [
    {
        "id": "main",
        "role": "single",
        "name": "Screening & Extraction Agent",
        "description": (
            "One agent handles all stages: evaluates title/abstract, then full text "
            "if available, then extracts structured data from included papers. "
            "Uses a single model and prompt for the entire workflow."
        ),
        "model": "claude-sonnet-4-6",
        "enabled": True,
        "system_prompt_override": None,
        "system_prompt_additions": None,
    }
]

DEFAULT_MULTI_PIPELINE: list[dict] = [
    {
        "id": "ta",
        "role": "ta_screener",
        "name": "Title/Abstract Screener",
        "description": (
            "Reviews only the title and abstract to make a fast initial "
            "include/exclude decision. Use a fast, cost-efficient model here."
        ),
        "model": "claude-haiku-4-5-20251001",
        "enabled": True,
        "system_prompt_override": None,
        "system_prompt_additions": None,
    },
    {
        "id": "ft",
        "role": "ft_screener",
        "name": "Full-Text Screener",
        "description": (
            "Reads the full text (if available) for papers that passed TA screening. "
            "Makes the final include/exclude decision. Use a capable model here."
        ),
        "model": "claude-sonnet-4-6",
        "enabled": True,
        "system_prompt_override": None,
        "system_prompt_additions": None,
    },
    {
        "id": "extract",
        "role": "extractor",
        "name": "Data Extractor",
        "description": (
            "Extracts structured data from papers that passed full-text screening, "
            "filling in the project's extraction template fields."
        ),
        "model": "claude-sonnet-4-6",
        "enabled": True,
        "system_prompt_override": None,
        "system_prompt_additions": None,
    },
    {
        "id": "verify",
        "role": "verifier",
        "name": "Verification Agent",
        "description": (
            "Independently reviews the TA and FT decisions made by the other agents "
            "and flags disagreements for human review. Disabled by default."
        ),
        "model": "claude-haiku-4-5-20251001",
        "enabled": False,
        "system_prompt_override": None,
        "system_prompt_additions": None,
    },
]


def _norm_decision(val: Optional[str]) -> Optional[str]:
    """Normalize LLM decision strings to lowercase — guards against 'Include' vs 'include'."""
    return val.lower().strip() if val else None


def _cost_per_token(model: str) -> tuple[float, float]:
    """Return (input_price_per_token, output_price_per_token) in USD."""
    return _PRICING.get(model, _PRICING[_DEFAULT_MODEL])


def _detect_provider(model: str) -> str:
    """Auto-select provider backend.

    Returns 'anthropic' when model is a Claude model and ANTHROPIC_API_KEY is
    present.  Falls back to 'openrouter' for everything else (requires
    OPENROUTER_API_KEY).
    """
    if model.startswith("claude-") and os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return "openrouter"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def estimate_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    model: str,
    source_id: Optional[uuid.UUID] = None,
    agent_mode: str = "single",
    pipeline: Optional[list] = None,
    include_extraction: bool = True,
) -> dict[str, Any]:
    """Return adaptive cost/time preview for a screening run. No DB side effects.

    Uses actual record text lengths to compute accurate per-record token estimates.
    When agent_mode='single', breaks cost into TA / FT / Extraction stages.
    When agent_mode='multi', maps each enabled agent to its reach fraction.
    """
    # ── Record count (scoped to source if given) ──────────────────────────────
    base_where = [Record.project_id == project_id]
    if source_id is not None:
        total_result = await db.execute(
            select(func.count())
            .select_from(Record)
            .join(RecordSource, RecordSource.record_id == Record.id)
            .where(*base_where, RecordSource.source_id == source_id)
        )
    else:
        total_result = await db.execute(
            select(func.count()).select_from(Record).where(*base_where)
        )
    total: int = total_result.scalar_one()

    # ── Compute actual average text length from project records ───────────────
    # Use title + abstract character count as proxy for TA input tokens.
    avg_len_result = await db.execute(
        select(
            func.avg(
                func.length(
                    func.coalesce(Record.title, "") + " " + func.coalesce(Record.abstract, "")
                )
            )
        ).where(*base_where, Record.abstract.isnot(None))
    )
    avg_chars: float = float(avg_len_result.scalar_one_or_none() or 0.0)

    # 4 chars ≈ 1 token; add ~400 tokens overhead for criteria + system prompt
    if avg_chars > 0:
        avg_ta_tokens = int(avg_chars / 4) + 400
    else:
        avg_ta_tokens = _STAGE_AVG_INPUT["ta"]

    # FT token estimate: TA tokens + ~2500 tokens for full-text body
    avg_ft_tokens = avg_ta_tokens + 2500

    # ── FT availability: fraction of records likely to have open-access full text ──
    doi_count_result = await db.execute(
        select(func.count()).select_from(Record).where(*base_where, Record.doi.isnot(None))
    )
    doi_count: int = doi_count_result.scalar_one()
    ft_avail_frac = min(doi_count / total, 1.0) if total > 0 else 0.5
    # Blend: records with DOI get full-text tokens; others get TA-only tokens
    effective_ft_tokens = int(avg_ft_tokens * ft_avail_frac + avg_ta_tokens * (1 - ft_avail_frac))

    # ── Resolve effective pipeline ─────────────────────────────────────────────
    if agent_mode == "multi":
        effective_pipeline: list[dict] = pipeline or DEFAULT_MULTI_PIPELINE
    else:
        effective_pipeline = pipeline or [{"id": "main", "role": "single", "model": model, "enabled": True}]
        if effective_pipeline and effective_pipeline[0].get("role") == "single":
            effective_pipeline[0]["model"] = model

    pipeline_estimate = estimate_pipeline_cost(
        total, agent_mode, effective_pipeline,
        avg_ta_tokens=avg_ta_tokens,
        effective_ft_tokens=effective_ft_tokens,
        include_extraction=include_extraction,
    )

    # ── Per-model cost comparison (single-agent, same reach fractions) ─────────
    _COMPARISON_MODELS = [
        "claude-haiku-4-5-20251001",
        "claude-sonnet-4-6",
        "openai/gpt-4o-mini",
        "openai/gpt-4o",
        "google/gemini-flash-1.5",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-chat",
    ]
    cost_breakdown: dict[str, float] = {}
    for m in _COMPARISON_MODELS:
        single_pl = [{"id": "main", "role": "single", "model": m, "enabled": True}]
        est = estimate_pipeline_cost(
            total, "single", single_pl,
            avg_ta_tokens=avg_ta_tokens,
            effective_ft_tokens=effective_ft_tokens,
            include_extraction=include_extraction,
        )
        cost_breakdown[m] = est["estimated_cost_usd"]

    return {
        "total_records":           total,
        "estimated_input_tokens":  pipeline_estimate["estimated_input_tokens"],
        "estimated_output_tokens": pipeline_estimate["estimated_output_tokens"],
        "estimated_cost_usd":      pipeline_estimate["estimated_cost_usd"],
        "estimated_minutes":       pipeline_estimate["estimated_minutes"],
        "cost_breakdown":          cost_breakdown,
        "stages":                  pipeline_estimate["stages"],
        # Expose inputs so the frontend can show how the estimate was computed
        "avg_ta_tokens_per_record": avg_ta_tokens,
        "ft_availability_pct": round(ft_avail_frac * 100, 1),
    }


async def create_and_launch_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    model: str,
    triggered_by: Optional[uuid.UUID],
    background_tasks: BackgroundTasks,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    mode: str = "prisma_scr",
    source_id: Optional[uuid.UUID] = None,
    seed: Optional[int] = None,
    saturation_threshold: int = 5,
    include_extraction: bool = True,
    agent_mode: str = "single",
    pipeline: Optional[list] = None,
    source_run_id: Optional[uuid.UUID] = None,
) -> LlmScreeningRun:
    """Create an LlmScreeningRun row and enqueue the background execution."""
    # Resolve effective pipeline and store a snapshot
    if agent_mode == "multi":
        effective_pipeline: list[dict] = pipeline or DEFAULT_MULTI_PIPELINE
    else:
        effective_pipeline = pipeline or [{"id": "main", "role": "single", "model": model, "enabled": True}]
        effective_pipeline[0]["model"] = model

    estimate = await estimate_run(
        db, project_id, model, source_id=source_id,
        agent_mode=agent_mode, pipeline=effective_pipeline,
    )

    run = LlmScreeningRun(
        project_id=project_id,
        status="queued",
        model=model,
        total_records=estimate["total_records"],
        estimated_cost_usd=Decimal(str(estimate["estimated_cost_usd"])),
        triggered_by=triggered_by,
        mode=mode,
        source_id=source_id,
        seed=seed,
        saturation_threshold=saturation_threshold,
        include_extraction=include_extraction,
        agent_mode=agent_mode,
        agent_pipeline=effective_pipeline,
        source_run_id=source_run_id,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    run_id = run.id
    if mode == "saturation":
        background_tasks.add_task(
            _execute_run_saturation,
            project_id, run_id, model, source_id, seed,
            saturation_threshold, include_extraction,
            anthropic_api_key, openrouter_api_key,
            effective_pipeline,
        )
    elif mode == "ta_only":
        background_tasks.add_task(
            _execute_run_ta_only, project_id, run_id, model,
            anthropic_api_key, openrouter_api_key, effective_pipeline,
        )
    elif mode == "ft_only":
        background_tasks.add_task(
            _execute_run_ft_only, project_id, run_id, model,
            source_run_id,
            anthropic_api_key, openrouter_api_key, effective_pipeline,
        )
    else:
        background_tasks.add_task(
            _execute_run, project_id, run_id, model,
            anthropic_api_key, openrouter_api_key, effective_pipeline,
        )
    return run


async def resume_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
) -> LlmScreeningRun:
    """Re-queue an interrupted run, picking up where it left off."""
    run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, run_id)
    if run is None or run.project_id != project_id:
        raise ValueError("Run not found")
    if run.status != "interrupted":
        raise ValueError(f"Only interrupted runs can be resumed (current status: {run.status!r})")

    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(status="queued", error_message=None, completed_at=None)
    )
    await db.commit()
    await db.refresh(run)

    model = run.model
    pipeline = run.agent_pipeline

    if run.mode == "saturation":
        background_tasks.add_task(
            _execute_run_saturation,
            project_id, run_id, model,
            run.source_id, run.seed, run.saturation_threshold, run.include_extraction,
            anthropic_api_key, openrouter_api_key, pipeline,
        )
    elif run.mode == "ta_only":
        background_tasks.add_task(
            _execute_run_ta_only, project_id, run_id, model,
            anthropic_api_key, openrouter_api_key, pipeline,
        )
    elif run.mode == "ft_only":
        background_tasks.add_task(
            _execute_run_ft_only, project_id, run_id, model,
            run.source_run_id, anthropic_api_key, openrouter_api_key, pipeline,
        )
    else:
        background_tasks.add_task(
            _execute_run, project_id, run_id, model,
            anthropic_api_key, openrouter_api_key, pipeline,
        )
    return run


_CATEGORY_LABELS = {
    "include": "LLM Included",
    "uncertain": "LLM Uncertain",
    "exclude": "LLM Excluded",
}


async def create_subproject_from_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    name: str,
    description: Optional[str],
    categories: list,
    triggered_by: uuid.UUID,
) -> dict:
    """Fork an LLM run's papers into a new child project.

    categories: list of ta_decision values to import, e.g. ["include", "uncertain"].
    Each category becomes its own Source corpus in the sub-project so humans can
    screen them independently.  All ScreeningDecisions and ExtractionRecords are
    pre-populated so the PRISMA flow is complete from day one.
    """
    run: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, run_id)
    if run is None or run.project_id != project_id:
        raise ValueError("Run not found")
    if run.status != "completed":
        raise ValueError("Only completed runs can be exported as a sub-project")

    # Fetch all results for the requested categories in one query
    all_results = (
        await db.execute(
            select(LlmScreeningResult).where(
                LlmScreeningResult.run_id == run_id,
                LlmScreeningResult.record_id.isnot(None),
                LlmScreeningResult.ta_decision.in_(categories),
            )
        )
    ).scalars().all()

    if not all_results:
        raise ValueError("No records match the selected categories in this run")

    # Group by ta_decision so we create one source per category
    by_category: dict = {cat: [] for cat in categories}
    for r in all_results:
        if r.ta_decision in by_category:
            by_category[r.ta_decision].append(r)

    parent: Optional[Project] = await db.get(Project, project_id)

    # Create child project inheriting criteria + templates from parent
    child = Project(
        name=name,
        description=description,
        created_by=triggered_by,
        parent_project_id=project_id,
        criteria=parent.criteria if parent else {},
        extraction_template=parent.extraction_template if parent else None,
        llm_config=parent.llm_config if parent else None,
    )
    db.add(child)
    await db.flush()

    imported = 0

    for cat in categories:
        results = by_category.get(cat, [])
        if not results:
            continue

        source_label = _CATEGORY_LABELS.get(cat, f"LLM {cat.title()}")
        source = Source(project_id=child.id, name=source_label)
        db.add(source)
        await db.flush()

        import_job = ImportJob(
            project_id=child.id,
            source_id=source.id,
            created_by=triggered_by,
            filename=f"llm_run_{run_id}_{cat}",
            file_format="llm_import",
            status="completed",
            record_count=len(results),
            completed_at=datetime.now(tz=timezone.utc),
        )
        db.add(import_job)
        await db.flush()

        for result in results:
            orig: Optional[Record] = await db.get(Record, result.record_id)
            if orig is None:
                continue

            # Get raw_data from any existing RecordSource (for norm fields)
            rs_orig = (
                await db.execute(
                    select(RecordSource)
                    .where(RecordSource.record_id == orig.id)
                    .limit(1)
                )
            ).scalar_one_or_none()

            # Embed LLM annotations in raw_data for provenance
            raw = dict(rs_orig.raw_data) if rs_orig else {}
            raw["_llm_screening"] = {
                "run_id": str(run_id),
                "model": run.model,
                "ta_decision": result.ta_decision,
                "ta_reason": result.ta_reason,
                "ft_decision": result.ft_decision,
                "ft_reason": result.ft_reason,
                "matched_codes": result.matched_codes,
                "new_concepts": result.new_concepts,
            }

            # Copy record into child project
            new_rec = Record(
                project_id=child.id,
                normalized_doi=orig.normalized_doi,
                match_key=orig.match_key,
                match_basis=orig.match_basis,
                title=orig.title,
                abstract=orig.abstract,
                authors=orig.authors,
                year=orig.year,
                journal=orig.journal,
                volume=orig.volume,
                issue=orig.issue,
                pages=orig.pages,
                doi=orig.doi,
                issn=orig.issn,
                keywords=orig.keywords,
                source_format=orig.source_format,
            )
            db.add(new_rec)
            await db.flush()

            db.add(RecordSource(
                record_id=new_rec.id,
                source_id=source.id,
                import_job_id=import_job.id,
                raw_data=raw,
                norm_title=rs_orig.norm_title if rs_orig else None,
                norm_first_author=rs_orig.norm_first_author if rs_orig else None,
                match_year=rs_orig.match_year if rs_orig else None,
                match_doi=rs_orig.match_doi if rs_orig else None,
            ))

            # Pre-populate TA decision (reviewer_id=NULL = LLM)
            if result.ta_decision in ("include", "exclude", "uncertain"):
                db.add(ScreeningDecision(
                    project_id=child.id,
                    record_id=new_rec.id,
                    cluster_id=None,
                    stage="TA",
                    decision=result.ta_decision,
                    reviewer_id=None,
                ))

            # Pre-populate FT decision if present
            if result.ft_decision in ("include", "exclude", "uncertain"):
                db.add(ScreeningDecision(
                    project_id=child.id,
                    record_id=new_rec.id,
                    cluster_id=None,
                    stage="FT",
                    decision=result.ft_decision,
                    reviewer_id=None,
                ))

            # Pre-populate extraction if available
            if result.extracted_json:
                db.add(ExtractionRecord(
                    project_id=child.id,
                    record_id=new_rec.id,
                    cluster_id=None,
                    extracted_json=result.extracted_json,
                    reviewer_id=None,
                ))

            imported += 1

    await db.commit()
    return {
        "project_id": str(child.id),
        "project_name": child.name,
        "imported_count": imported,
        "corpora_created": len([c for c in categories if by_category.get(c)]),
    }


# ---------------------------------------------------------------------------
# Background execution
# ---------------------------------------------------------------------------


async def _execute_run(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Background task: screen every record in the project using the LLM (PRISMA mode)."""
    async with SessionLocal() as db:
        try:
            await _do_execute_run(db, project_id, run_id, model, anthropic_api_key, openrouter_api_key, pipeline)
        except Exception as exc:
            logger.exception("LLM screening run %s failed", run_id)
            async with SessionLocal() as err_db:
                await err_db.execute(
                    update(LlmScreeningRun)
                    .where(LlmScreeningRun.id == run_id)
                    .values(
                        status="failed",
                        error_message=str(exc),
                        completed_at=datetime.now(tz=timezone.utc),
                    )
                )
                await err_db.commit()


async def _execute_run_saturation(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    source_id: Optional[uuid.UUID],
    seed: Optional[int],
    saturation_threshold: int,
    include_extraction: bool,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Background task: screen a single corpus sequentially, stopping at saturation."""
    async with SessionLocal() as db:
        try:
            await _do_execute_run_saturation(
                db,
                project_id,
                run_id,
                model,
                source_id,
                seed,
                saturation_threshold,
                include_extraction,
                anthropic_api_key,
                openrouter_api_key,
                pipeline,
            )
        except Exception as exc:
            logger.exception("LLM saturation run %s failed", run_id)
            async with SessionLocal() as err_db:
                await err_db.execute(
                    update(LlmScreeningRun)
                    .where(LlmScreeningRun.id == run_id)
                    .values(
                        status="failed",
                        error_message=str(exc),
                        completed_at=datetime.now(tz=timezone.utc),
                    )
                )
                await err_db.commit()


async def _restore_run_state(
    db: AsyncSession,
    run_id: uuid.UUID,
    in_price: float,
    out_price: float,
) -> dict:
    """Load already-processed results for a run to support resume.

    Returns a dict with processed_ids and all accumulator values so each
    _do_execute_run* function can skip done records and seed its counters.
    """
    existing = (
        await db.execute(
            select(LlmScreeningResult)
            .where(LlmScreeningResult.run_id == run_id)
            .order_by(LlmScreeningResult.created_at)
        )
    ).scalars().all()

    processed_ids: set[uuid.UUID] = {r.record_id for r in existing if r.record_id is not None}
    input_tok_total = sum(r.input_tokens or 0 for r in existing)
    output_tok_total = sum(r.output_tokens or 0 for r in existing)

    consecutive_no_new = 0
    for r in reversed(existing):
        if r.ta_decision != "include":
            continue
        if r.new_concepts and isinstance(r.new_concepts, list) and len(r.new_concepts) > 0:
            break
        consecutive_no_new += 1

    return {
        "processed_ids": processed_ids,
        "ta_included": sum(1 for r in existing if r.ta_decision == "include"),
        "ta_excluded": sum(1 for r in existing if r.ta_decision == "exclude"),
        "ta_uncertain": sum(1 for r in existing if r.ta_decision == "uncertain"),
        "ft_included": sum(1 for r in existing if r.ft_decision == "include"),
        "ft_excluded": sum(1 for r in existing if r.ft_decision == "exclude"),
        "ft_uncertain": sum(1 for r in existing if r.ft_decision == "uncertain"),
        "abstract_only_count": sum(
            1 for r in existing if r.full_text_source == "abstract_only" and r.ft_decision is None
        ),
        "new_concepts_total": sum(
            len(r.new_concepts) if r.new_concepts and isinstance(r.new_concepts, list) else 0
            for r in existing
        ),
        "input_tok_total": input_tok_total,
        "output_tok_total": output_tok_total,
        "actual_cost": input_tok_total * in_price + output_tok_total * out_price,
        "consecutive_no_new": consecutive_no_new,
    }


async def _do_execute_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    # Mark as running
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(status="running", started_at=datetime.now(tz=timezone.utc))
    )
    await db.commit()

    # Load records
    records = (
        await db.execute(
            select(Record).where(Record.project_id == project_id)
        )
    ).scalars().all()

    total = len(records)

    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(total_records=total)
    )
    await db.commit()

    # Load project criteria, llm_config, extraction_template
    project: Optional[Project] = await db.get(Project, project_id)
    criteria: dict = {}
    llm_config: Optional[dict] = None
    extraction_template: Optional[dict] = None
    include_extraction: bool = True
    if project:
        if project.criteria:
            criteria = project.criteria
        llm_config = project.llm_config
        extraction_template = project.extraction_template
    # Check whether the run wants extraction
    run_row: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, run_id)
    if run_row is not None:
        include_extraction = run_row.include_extraction

    # Load thematic framework (themes + codes)
    framework_nodes = (
        await db.execute(
            select(OntologyNode)
            .where(
                OntologyNode.project_id == project_id,
                OntologyNode.namespace.in_(["theme", "code"]),
            )
            .order_by(OntologyNode.namespace.desc(), OntologyNode.position)
        )
    ).scalars().all()

    # Resolve agent mode from run row
    agent_mode: str = "single"
    effective_pipeline: list[dict] = pipeline or []
    triggered_by_id: Optional[uuid.UUID] = None
    if run_row is not None:
        agent_mode = run_row.agent_mode or "single"
        if not effective_pipeline and run_row.agent_pipeline:
            effective_pipeline = run_row.agent_pipeline
        triggered_by_id = run_row.triggered_by

    # Load OneDrive token for full-text fetching (may refresh automatically)
    onedrive_token: Optional[str] = await _load_onedrive_token(db, triggered_by_id)

    in_price, out_price = _cost_per_token(model)

    # Resume: skip already-processed records and restore accumulators
    _state = await _restore_run_state(db, run_id, in_price, out_price)
    if _state["processed_ids"]:
        logger.info("Resuming run %s: skipping %d already-processed records", run_id, len(_state["processed_ids"]))
        records = [r for r in records if r.id not in _state["processed_ids"]]
    included = _state["ta_included"]
    excluded = _state["ta_excluded"]
    uncertain = _state["ta_uncertain"]
    new_concepts_total = _state["new_concepts_total"]
    input_tok_total = _state["input_tok_total"]
    output_tok_total = _state["output_tok_total"]
    actual_cost = _state["actual_cost"]

    semaphore = asyncio.Semaphore(CONCURRENT_REQUESTS)

    async def _process(record: Record) -> None:
        nonlocal included, excluded, uncertain, new_concepts_total
        nonlocal input_tok_total, output_tok_total, actual_cost

        async with semaphore:
            # Each task gets its own session to avoid concurrent session corruption.
            # Sharing a single AsyncSession across concurrent coroutines causes
            # interleaved flush/commit/rollback calls that corrupt session state.
            async with SessionLocal() as task_db:
                try:
                    if agent_mode == "multi" and effective_pipeline:
                        full_text, full_text_source = await _fetch_fulltext_for_record(
                            record, project_id, task_db, onedrive_token=onedrive_token
                        )
                        result = await _run_multi_agent_pipeline(
                            record=record,
                            full_text=full_text,
                            full_text_source=full_text_source,
                            pipeline=effective_pipeline,
                            criteria=criteria,
                            framework=framework_nodes,
                            project_id=project_id,
                            run_id=run_id,
                            db=task_db,
                            extraction_template=extraction_template,
                            include_extraction=include_extraction,
                            llm_config=llm_config,
                            anthropic_api_key=anthropic_api_key,
                            openrouter_api_key=openrouter_api_key,
                        )
                    else:
                        result = await _screen_one_record(
                            record=record,
                            project_id=project_id,
                            run_id=run_id,
                            model=model,
                            criteria=criteria,
                            framework=framework_nodes,
                            db=task_db,
                            anthropic_api_key=anthropic_api_key,
                            openrouter_api_key=openrouter_api_key,
                            llm_config=llm_config,
                            extraction_template=extraction_template,
                            include_extraction=include_extraction,
                            onedrive_token=onedrive_token,
                        )
                    if result is None:
                        return

                    task_db.add(result)
                    await task_db.flush()

                    # Mirror extraction into shared extraction_records table so the
                    # Extraction Library and saturation counter see LLM extractions
                    # alongside manual ones.
                    if result.extracted_json:
                        await _sync_extraction_to_shared_table(task_db, result, triggered_by_id)

                    # Update counters (asyncio is single-threaded; += between awaits is safe)
                    if result.ta_decision == "include":
                        included += 1
                    elif result.ta_decision == "exclude":
                        excluded += 1
                    elif result.ta_decision == "uncertain":
                        uncertain += 1

                    if result.new_concepts:
                        if isinstance(result.new_concepts, list):
                            new_concepts_total += len(result.new_concepts)

                    itok = result.input_tokens or 0
                    otok = result.output_tokens or 0
                    input_tok_total += itok
                    output_tok_total += otok
                    actual_cost += itok * in_price + otok * out_price

                    # Persist incremental progress
                    await task_db.execute(
                        update(LlmScreeningRun)
                        .where(LlmScreeningRun.id == run_id)
                        .values(
                            processed_records=LlmScreeningRun.processed_records + 1,
                            included_count=included,
                            excluded_count=excluded,
                            uncertain_count=uncertain,
                            new_concepts_count=new_concepts_total,
                            input_tokens=input_tok_total,
                            output_tokens=output_tok_total,
                        )
                    )
                    await task_db.commit()

                except Exception:
                    logger.exception("Error screening record %s", record.id)
                    # No explicit rollback — async with SessionLocal() close() handles it

    tasks = [_process(record) for record in records]
    await asyncio.gather(*tasks)

    # Final update
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(
            status="completed",
            completed_at=datetime.now(tz=timezone.utc),
            actual_cost_usd=Decimal(str(round(actual_cost, 6))),
            included_count=included,
            excluded_count=excluded,
            uncertain_count=uncertain,
            new_concepts_count=new_concepts_total,
            input_tokens=input_tok_total,
            output_tokens=output_tok_total,
        )
    )
    await db.commit()


async def _load_onedrive_token(
    db: AsyncSession,
    user_id: Optional[uuid.UUID],
) -> Optional[str]:
    """Return the OneDrive access token for a user, refreshing if a refresh token is stored.

    Returns None if the user has no OneDrive connection or on any error.
    """
    if user_id is None:
        return None
    user: Optional[User] = await db.get(User, user_id)
    if user is None or not user.api_keys:
        return None
    keys: dict = user.api_keys or {}
    access_token: Optional[str] = keys.get("onedrive_access")
    refresh_token: Optional[str] = keys.get("onedrive_refresh")

    if not access_token and not refresh_token:
        return None

    # If we have only a refresh token (or want to proactively refresh), do so
    if refresh_token and not access_token:
        client_id = os.environ.get("MICROSOFT_CLIENT_ID", "")
        client_secret = os.environ.get("MICROSOFT_CLIENT_SECRET", "")
        if client_id and client_secret:
            from app.utils.onedrive_fetcher import refresh_onedrive_token  # lazy import
            new_tokens = await refresh_onedrive_token(refresh_token, client_id, client_secret)
            if new_tokens:
                access_token = new_tokens.get("access_token")
                # Persist the refreshed tokens back to the user row
                updated_keys = dict(keys)
                updated_keys["onedrive_access"] = access_token
                if new_tokens.get("refresh_token"):
                    updated_keys["onedrive_refresh"] = new_tokens["refresh_token"]
                user.api_keys = updated_keys
                await db.flush()

    return access_token


async def _resolve_queue_order(
    db: AsyncSession,
    project_id: uuid.UUID,
    source_id: uuid.UUID,
    seed: Optional[int],
) -> list[uuid.UUID]:
    """Return ordered record IDs for saturation mode.

    Prefers an existing human screening queue for the source (most recent).
    Falls back to a seeded shuffle of all records in the source.
    """
    source_id_str = str(source_id)
    queue_row = (
        await db.execute(
            select(ScreeningQueue)
            .where(
                ScreeningQueue.project_id == project_id,
                ScreeningQueue.source_id == source_id_str,
            )
            .order_by(ScreeningQueue.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if queue_row is not None and queue_row.slots:
        # Extract record IDs from the queue in slot order
        record_ids = [
            uuid.UUID(slot["id"])
            for slot in queue_row.slots
            if slot.get("type") == "record"
        ]
        return record_ids

    # No queue found — load all records for the source and shuffle deterministically
    rows = (
        await db.execute(
            select(Record.id)
            .join(RecordSource, RecordSource.record_id == Record.id)
            .where(
                Record.project_id == project_id,
                RecordSource.source_id == source_id,
            )
            .order_by(Record.id)  # stable base order before shuffle
        )
    ).scalars().all()

    record_ids = [r for r in rows]
    rng = random.Random(seed if seed is not None else 0)
    rng.shuffle(record_ids)
    return record_ids


async def _do_execute_run_saturation(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    source_id: Optional[uuid.UUID],
    seed: Optional[int],
    saturation_threshold: int,
    include_extraction: bool,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Screen a corpus sequentially, stopping when saturation is reached.

    Saturation = saturation_threshold consecutive records with no new concepts.
    Processes records in queue order (or seeded order) — NOT parallel.
    """
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(status="running", started_at=datetime.now(tz=timezone.utc))
    )
    await db.commit()

    project: Optional[Project] = await db.get(Project, project_id)
    criteria: dict = {}
    llm_config: Optional[dict] = None
    extraction_template: Optional[dict] = None
    if project:
        if project.criteria:
            criteria = project.criteria
        llm_config = project.llm_config
        extraction_template = project.extraction_template

    framework_nodes = (
        await db.execute(
            select(OntologyNode)
            .where(
                OntologyNode.project_id == project_id,
                OntologyNode.namespace.in_(["theme", "code"]),
            )
            .order_by(OntologyNode.namespace.desc(), OntologyNode.position)
        )
    ).scalars().all()

    record_ids = []
    if source_id is not None:
        record_ids = await _resolve_queue_order(db, project_id, source_id, seed)

    total = len(record_ids)
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(total_records=total)
    )
    await db.commit()

    # Resolve agent mode from run row
    run_row_sat: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, run_id)
    agent_mode_sat: str = "single"
    effective_pipeline_sat: list[dict] = pipeline or []
    triggered_by_id_sat: Optional[uuid.UUID] = None
    if run_row_sat is not None:
        agent_mode_sat = run_row_sat.agent_mode or "single"
        if not effective_pipeline_sat and run_row_sat.agent_pipeline:
            effective_pipeline_sat = run_row_sat.agent_pipeline
        triggered_by_id_sat = run_row_sat.triggered_by

    # Load OneDrive token for full-text fetching
    onedrive_token_sat: Optional[str] = await _load_onedrive_token(db, triggered_by_id_sat)

    in_price, out_price = _cost_per_token(model)

    # Resume: skip already-processed records and restore accumulators
    _state = await _restore_run_state(db, run_id, in_price, out_price)
    if _state["processed_ids"]:
        logger.info("Resuming saturation run %s: skipping %d records", run_id, len(_state["processed_ids"]))
        record_ids = [rid for rid in record_ids if rid not in _state["processed_ids"]]
    included = _state["ta_included"]
    excluded = _state["ta_excluded"]
    uncertain = _state["ta_uncertain"]
    new_concepts_total = _state["new_concepts_total"]
    input_tok_total = _state["input_tok_total"]
    output_tok_total = _state["output_tok_total"]
    actual_cost = _state["actual_cost"]
    consecutive_no_new = _state["consecutive_no_new"]
    stopped_early = False

    for record_id in record_ids:
        record: Optional[Record] = await db.get(Record, record_id)
        if record is None:
            continue

        try:
            if agent_mode_sat == "multi" and effective_pipeline_sat:
                full_text, full_text_source = await _fetch_fulltext_for_record(
                    record, project_id, db, onedrive_token=onedrive_token_sat
                )
                result = await _run_multi_agent_pipeline(
                    record=record,
                    full_text=full_text,
                    full_text_source=full_text_source,
                    pipeline=effective_pipeline_sat,
                    criteria=criteria,
                    framework=framework_nodes,
                    project_id=project_id,
                    run_id=run_id,
                    db=db,
                    extraction_template=extraction_template,
                    include_extraction=include_extraction,
                    llm_config=llm_config,
                    anthropic_api_key=anthropic_api_key,
                    openrouter_api_key=openrouter_api_key,
                )
            else:
                result = await _screen_one_record(
                    record=record,
                    project_id=project_id,
                    run_id=run_id,
                    model=model,
                    criteria=criteria,
                    framework=framework_nodes,
                    db=db,
                    anthropic_api_key=anthropic_api_key,
                    openrouter_api_key=openrouter_api_key,
                    llm_config=llm_config,
                    extraction_template=extraction_template,
                    include_extraction=include_extraction,
                    onedrive_token=onedrive_token_sat,
                )
        except Exception:
            logger.exception("Error screening record %s in saturation run", record_id)
            continue

        if result is None:
            continue

        db.add(result)
        await db.flush()

        if result.extracted_json:
            await _sync_extraction_to_shared_table(db, result, triggered_by_id_sat)

        if result.ta_decision == "include":
            included += 1
        elif result.ta_decision == "exclude":
            excluded += 1
        elif result.ta_decision == "uncertain":
            uncertain += 1

        # New-concepts total (display metric — counts all papers)
        if result.new_concepts and isinstance(result.new_concepts, list):
            new_concepts_total += len(result.new_concepts)

        # Saturation counter: mirrors human review — only included papers count.
        # Excluded/uncertain papers are skipped, exactly as framework_updated is
        # only set during extraction (which never happens for excluded papers).
        if result.ta_decision == "include":
            has_new_concepts = bool(result.new_concepts and len(result.new_concepts) > 0)
            if has_new_concepts:
                consecutive_no_new = 0
            else:
                consecutive_no_new += 1

        itok = result.input_tokens or 0
        otok = result.output_tokens or 0
        input_tok_total += itok
        output_tok_total += otok
        actual_cost += itok * in_price + otok * out_price

        await db.execute(
            update(LlmScreeningRun)
            .where(LlmScreeningRun.id == run_id)
            .values(
                processed_records=LlmScreeningRun.processed_records + 1,
                included_count=included,
                excluded_count=excluded,
                uncertain_count=uncertain,
                new_concepts_count=new_concepts_total,
                input_tokens=input_tok_total,
                output_tokens=output_tok_total,
            )
        )
        await db.commit()

        if consecutive_no_new >= saturation_threshold:
            stopped_early = True
            logger.info(
                "Saturation reached after %d consecutive records with no new concepts "
                "(run %s)",
                consecutive_no_new,
                run_id,
            )
            break

    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(
            status="completed",
            completed_at=datetime.now(tz=timezone.utc),
            actual_cost_usd=Decimal(str(round(actual_cost, 6))),
            included_count=included,
            excluded_count=excluded,
            uncertain_count=uncertain,
            new_concepts_count=new_concepts_total,
            input_tokens=input_tok_total,
            output_tokens=output_tok_total,
            stopped_at_saturation=stopped_early,
        )
    )
    await db.commit()


async def _sync_extraction_to_shared_table(
    db: AsyncSession,
    result: LlmScreeningResult,
    triggered_by: Optional[uuid.UUID],
) -> None:
    """Upsert LLM extraction into the shared extraction_records table.

    This keeps manual-screening and LLM-screening extractions in the same
    table so the Extraction Library, saturation counter, and any other consumer
    see a unified view regardless of how the extraction was produced.

    Uses a simple SELECT-then-INSERT/UPDATE pattern (no ON CONFLICT) because
    reviewer_id is NULL for LLM runs, making the unique key (project_id,
    record_id, reviewer_id) ambiguous — we just replace the most recent LLM
    extraction for this record.
    """
    if not result.extracted_json:
        return

    from sqlalchemy import select as _select

    existing = (
        await db.execute(
            _select(ExtractionRecord).where(
                ExtractionRecord.project_id == result.project_id,
                ExtractionRecord.record_id == result.record_id,
                ExtractionRecord.cluster_id.is_(None),
                ExtractionRecord.reviewer_id == triggered_by,
            ).limit(1)
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.extracted_json = result.extracted_json
    else:
        db.add(
            ExtractionRecord(
                project_id=result.project_id,
                record_id=result.record_id,
                cluster_id=None,
                extracted_json=result.extracted_json,
                reviewer_id=triggered_by,
            )
        )
    await db.flush()


async def _fetch_fulltext_for_record(
    record: Record,
    project_id: uuid.UUID,
    db: AsyncSession,
    onedrive_token: Optional[str] = None,
) -> tuple[Optional[str], str]:
    """Fetch full text and source label for a record. Shared by single and multi-agent paths."""
    rs_row = (
        await db.execute(
            select(RecordSource).where(RecordSource.record_id == record.id).limit(1)
        )
    ).scalar_one_or_none()

    pmid: Optional[str] = None
    pmcid: Optional[str] = None
    if rs_row and rs_row.raw_data:
        raw = rs_row.raw_data
        pmid = raw.get("pmid") or raw.get("accession_number") or raw.get("pubmed_id")
        lid = raw.get("LID") or raw.get("lid") or ""
        if isinstance(lid, list):
            for entry in lid:
                if isinstance(entry, str) and "[pmc]" in entry.lower():
                    pmcid = entry.split()[0]
                    break
        elif isinstance(lid, str) and "[pmc]" in lid.lower():
            pmcid = lid.split()[0]
        if not pmcid:
            pmcid = raw.get("pmcid") or raw.get("pmc")

    return await get_full_text(
        record_id=record.id,
        project_id=project_id,
        doi=record.doi,
        pmid=str(pmid) if pmid else None,
        pmcid=str(pmcid) if pmcid else None,
        db=db,
        onedrive_token=onedrive_token,
        title=record.title,
    )


async def _screen_one_record(
    record: Record,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    criteria: dict,
    framework: list,
    db: AsyncSession,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    llm_config: Optional[dict] = None,
    extraction_template: Optional[dict] = None,
    include_extraction: bool = False,
    onedrive_token: Optional[str] = None,
) -> Optional[LlmScreeningResult]:
    """Screen a single record: fetch full text, call LLM, return result row."""
    full_text, full_text_source = await _fetch_fulltext_for_record(
        record, project_id, db, onedrive_token=onedrive_token
    )

    prompt = _build_prompt(
        record,
        full_text,
        full_text_source,
        criteria,
        framework,
        llm_config=llm_config,
        extraction_template=extraction_template,
        include_extraction=include_extraction,
    )

    # Build system prompt, allowing custom additions or full override
    system_prompt: Optional[str] = None
    if llm_config:
        if llm_config.get("use_full_override") and llm_config.get("full_override_prompt"):
            system_prompt = llm_config["full_override_prompt"]
        elif llm_config.get("custom_system_additions"):
            system_prompt = (
                llm_config["custom_system_additions"] + "\n\n" + _SYSTEM_PROMPT
            )

    try:
        llm_output = await _call_llm(
            model,
            prompt,
            anthropic_api_key,
            openrouter_api_key,
            system_prompt_override=system_prompt,
        )
    except Exception:
        logger.exception("LLM call failed for record %s", record.id)
        return None

    # Optionally do a second extraction call for FT-included records
    extracted_json: Optional[dict] = None
    if (
        include_extraction
        and extraction_template
        and extraction_template.get("rows")
        and llm_output.get("ft_decision") == "include"
    ):
        try:
            extracted_json = await _extract_one_record(
                record=record,
                full_text=full_text,
                extraction_template=extraction_template,
                llm_config=llm_config,
                model=model,
                anthropic_api_key=anthropic_api_key,
                openrouter_api_key=openrouter_api_key,
                system_prompt_override=system_prompt,
            )
        except Exception:
            logger.exception("LLM extraction failed for record %s", record.id)

    return LlmScreeningResult(
        run_id=run_id,
        project_id=project_id,
        record_id=record.id,
        cluster_id=None,
        ta_decision=_norm_decision(llm_output.get("ta_decision")),
        ta_reason=llm_output.get("ta_reason"),
        ft_decision=_norm_decision(llm_output.get("ft_decision")),
        ft_reason=llm_output.get("ft_reason"),
        matched_codes=llm_output.get("matched_codes") or [],
        new_concepts=llm_output.get("new_concepts") or [],
        full_text_source=full_text_source,
        input_tokens=llm_output.get("_input_tokens"),
        output_tokens=llm_output.get("_output_tokens"),
        model=model,
        extracted_json=extracted_json,
    )


# ---------------------------------------------------------------------------
# TA-only screening (Phase 1 of two-phase interactive workflow)
# ---------------------------------------------------------------------------


async def _execute_run_ta_only(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Background task: TA-only screening — no full-text fetch, no FT decision."""
    async with SessionLocal() as db:
        try:
            await _do_execute_run_ta_only(db, project_id, run_id, model, anthropic_api_key, openrouter_api_key, pipeline)
        except Exception as exc:
            logger.exception("LLM ta_only run %s failed", run_id)
            async with SessionLocal() as err_db:
                await err_db.execute(
                    update(LlmScreeningRun)
                    .where(LlmScreeningRun.id == run_id)
                    .values(
                        status="failed",
                        error_message=str(exc),
                        completed_at=datetime.now(tz=timezone.utc),
                    )
                )
                await err_db.commit()


async def _do_execute_run_ta_only(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Screen every record by title/abstract only — no full-text fetch.

    Produces ta_decision for every record.  ft_decision is always null.
    full_text_source is always 'abstract_only'.
    On completion, status = 'awaiting_fulltext' so the UI can prompt the user
    to supply PDFs before triggering the FT phase.
    """
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(status="running", started_at=datetime.now(tz=timezone.utc))
    )
    await db.commit()

    records = (
        await db.execute(select(Record).where(Record.project_id == project_id))
    ).scalars().all()
    total = len(records)

    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(total_records=total)
    )
    await db.commit()

    project: Optional[Project] = await db.get(Project, project_id)
    criteria: dict = {}
    llm_config: Optional[dict] = None
    if project:
        criteria = project.criteria or {}
        llm_config = project.llm_config

    framework_nodes = (
        await db.execute(
            select(OntologyNode)
            .where(
                OntologyNode.project_id == project_id,
                OntologyNode.namespace.in_(["theme", "code"]),
            )
            .order_by(OntologyNode.namespace.desc(), OntologyNode.position)
        )
    ).scalars().all()

    run_row: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, run_id)
    agent_mode: str = "single"
    effective_pipeline: list[dict] = pipeline or []
    triggered_by_id: Optional[uuid.UUID] = None
    if run_row is not None:
        agent_mode = run_row.agent_mode or "single"
        if not effective_pipeline and run_row.agent_pipeline:
            effective_pipeline = run_row.agent_pipeline
        triggered_by_id = run_row.triggered_by

    in_price, out_price = _cost_per_token(model)

    # Resume: skip already-processed records and restore accumulators
    _state = await _restore_run_state(db, run_id, in_price, out_price)
    if _state["processed_ids"]:
        logger.info("Resuming ta_only run %s: skipping %d records", run_id, len(_state["processed_ids"]))
        records = [r for r in records if r.id not in _state["processed_ids"]]
    included = _state["ta_included"]
    excluded = _state["ta_excluded"]
    uncertain = _state["ta_uncertain"]
    new_concepts_total = _state["new_concepts_total"]
    input_tok_total = _state["input_tok_total"]
    output_tok_total = _state["output_tok_total"]
    actual_cost = _state["actual_cost"]
    # total is the original full count (set before filtering above)
    abstract_only_total = total

    semaphore = asyncio.Semaphore(CONCURRENT_REQUESTS)

    async def _process_ta(record: Record) -> None:
        nonlocal included, excluded, uncertain, new_concepts_total
        nonlocal input_tok_total, output_tok_total, actual_cost

        async with semaphore:
            async with SessionLocal() as task_db:
                try:
                    # Build prompt with abstract only (pass full_text=None explicitly)
                    system_prompt: Optional[str] = None
                    if llm_config:
                        if llm_config.get("use_full_override") and llm_config.get("full_override_prompt"):
                            system_prompt = llm_config["full_override_prompt"]
                        elif llm_config.get("custom_system_additions"):
                            system_prompt = llm_config["custom_system_additions"] + "\n\n" + _SYSTEM_PROMPT

                    prompt = _build_prompt(
                        record,
                        full_text=None,
                        full_text_source="abstract_only",
                        criteria=criteria,
                        framework=framework_nodes,
                        llm_config=llm_config,
                        extraction_template=None,
                        include_extraction=False,
                    )

                    try:
                        llm_output = await _call_llm(
                            model, prompt,
                            anthropic_api_key, openrouter_api_key,
                            system_prompt_override=system_prompt,
                        )
                    except Exception:
                        logger.exception("LLM call failed for record %s (ta_only)", record.id)
                        return

                    result = LlmScreeningResult(
                        run_id=run_id,
                        project_id=project_id,
                        record_id=record.id,
                        cluster_id=None,
                        ta_decision=_norm_decision(llm_output.get("ta_decision")),
                        ta_reason=llm_output.get("ta_reason"),
                        ft_decision=None,
                        ft_reason=None,
                        matched_codes=llm_output.get("matched_codes") or [],
                        new_concepts=llm_output.get("new_concepts") or [],
                        full_text_source="abstract_only",
                        input_tokens=llm_output.get("_input_tokens"),
                        output_tokens=llm_output.get("_output_tokens"),
                        model=model,
                        extracted_json=None,
                    )

                    task_db.add(result)
                    await task_db.flush()

                    if result.ta_decision == "include":
                        included += 1
                    elif result.ta_decision == "exclude":
                        excluded += 1
                    elif result.ta_decision == "uncertain":
                        uncertain += 1
                    if result.new_concepts and isinstance(result.new_concepts, list):
                        new_concepts_total += len(result.new_concepts)

                    itok = result.input_tokens or 0
                    otok = result.output_tokens or 0
                    input_tok_total += itok
                    output_tok_total += otok
                    actual_cost += itok * in_price + otok * out_price

                    await task_db.execute(
                        update(LlmScreeningRun)
                        .where(LlmScreeningRun.id == run_id)
                        .values(
                            processed_records=LlmScreeningRun.processed_records + 1,
                            included_count=included,
                            excluded_count=excluded,
                            uncertain_count=uncertain,
                            new_concepts_count=new_concepts_total,
                            input_tokens=input_tok_total,
                            output_tokens=output_tok_total,
                        )
                    )
                    await task_db.commit()

                except Exception:
                    logger.exception("Error in ta_only task for record %s", record.id)
                    # No explicit rollback — async with SessionLocal() close() handles it

    tasks = [_process_ta(record) for record in records]
    await asyncio.gather(*tasks)

    # TA phase done — mark completed; the UI will show the FT Queue panel as
    # an optional next step if the user wants to proceed to full-text screening.
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(
            status="completed",
            completed_at=datetime.now(tz=timezone.utc),
            actual_cost_usd=Decimal(str(round(actual_cost, 6))),
            included_count=included,
            excluded_count=excluded,
            uncertain_count=uncertain,
            new_concepts_count=new_concepts_total,
            input_tokens=input_tok_total,
            output_tokens=output_tok_total,
            abstract_only_count=abstract_only_total,
        )
    )
    await db.commit()


# ---------------------------------------------------------------------------
# FT-only screening (Phase 2 of two-phase interactive workflow)
# ---------------------------------------------------------------------------


async def _execute_run_ft_only(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    source_run_id: Optional[uuid.UUID],
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Background task: FT screening for records that passed TA in source_run_id."""
    async with SessionLocal() as db:
        try:
            await _do_execute_run_ft_only(
                db, project_id, run_id, model, source_run_id,
                anthropic_api_key, openrouter_api_key, pipeline,
            )
        except Exception as exc:
            logger.exception("LLM ft_only run %s failed", run_id)
            async with SessionLocal() as err_db:
                await err_db.execute(
                    update(LlmScreeningRun)
                    .where(LlmScreeningRun.id == run_id)
                    .values(
                        status="failed",
                        error_message=str(exc),
                        completed_at=datetime.now(tz=timezone.utc),
                    )
                )
                await err_db.commit()


async def _do_execute_run_ft_only(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    source_run_id: Optional[uuid.UUID],
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    pipeline: Optional[list] = None,
) -> None:
    """Screen at the full-text stage records that were TA-included in source_run_id.

    For each record:
      - Attempts full-text fetch (uploaded PDF → OneDrive → Unpaywall → PMC).
      - If full text found: makes FT include/exclude decision + runs extraction.
      - If still abstract_only: leaves ft_decision=null, increments abstract_only_count.
    """
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(status="running", started_at=datetime.now(tz=timezone.utc))
    )
    await db.commit()

    # Load records that were TA-included in the source (ta_only) run
    if source_run_id is None:
        logger.error("ft_only run %s has no source_run_id", run_id)
        await db.execute(
            update(LlmScreeningRun).where(LlmScreeningRun.id == run_id)
            .values(status="failed", error_message="No source_run_id provided",
                    completed_at=datetime.now(tz=timezone.utc))
        )
        await db.commit()
        return

    included_record_ids: list[uuid.UUID] = [
        row.record_id
        for row in (
            await db.execute(
                select(LlmScreeningResult.record_id)
                .where(
                    LlmScreeningResult.run_id == source_run_id,
                    LlmScreeningResult.ta_decision == "include",
                    LlmScreeningResult.record_id.isnot(None),
                )
            )
        ).all()
    ]

    total = len(included_record_ids)
    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(total_records=total)
    )
    await db.commit()

    project: Optional[Project] = await db.get(Project, project_id)
    criteria: dict = {}
    llm_config: Optional[dict] = None
    extraction_template: Optional[dict] = None
    if project:
        criteria = project.criteria or {}
        llm_config = project.llm_config
        extraction_template = project.extraction_template

    framework_nodes = (
        await db.execute(
            select(OntologyNode)
            .where(
                OntologyNode.project_id == project_id,
                OntologyNode.namespace.in_(["theme", "code"]),
            )
            .order_by(OntologyNode.namespace.desc(), OntologyNode.position)
        )
    ).scalars().all()

    run_row: Optional[LlmScreeningRun] = await db.get(LlmScreeningRun, run_id)
    include_extraction: bool = True
    triggered_by_id: Optional[uuid.UUID] = None
    effective_pipeline: list[dict] = pipeline or []
    if run_row is not None:
        include_extraction = run_row.include_extraction
        triggered_by_id = run_row.triggered_by
        if not effective_pipeline and run_row.agent_pipeline:
            effective_pipeline = run_row.agent_pipeline

    onedrive_token: Optional[str] = await _load_onedrive_token(db, triggered_by_id)

    in_price, out_price = _cost_per_token(model)

    # Resume: skip already-processed records and restore accumulators
    _state = await _restore_run_state(db, run_id, in_price, out_price)
    if _state["processed_ids"]:
        logger.info("Resuming ft_only run %s: skipping %d records", run_id, len(_state["processed_ids"]))
        included_record_ids = [rid for rid in included_record_ids if rid not in _state["processed_ids"]]
    ft_included = _state["ft_included"]
    ft_excluded = _state["ft_excluded"]
    ft_uncertain = _state["ft_uncertain"]
    new_concepts_total = _state["new_concepts_total"]
    input_tok_total = _state["input_tok_total"]
    output_tok_total = _state["output_tok_total"]
    actual_cost = _state["actual_cost"]
    abstract_only_count = _state["abstract_only_count"]

    semaphore = asyncio.Semaphore(CONCURRENT_REQUESTS)

    async def _process_ft(record_id: uuid.UUID) -> None:
        nonlocal ft_included, ft_excluded, ft_uncertain, new_concepts_total
        nonlocal input_tok_total, output_tok_total, actual_cost, abstract_only_count

        async with semaphore:
            async with SessionLocal() as task_db:
                try:
                    record: Optional[Record] = await task_db.get(Record, record_id)
                    if record is None:
                        return

                    full_text, full_text_source = await _fetch_fulltext_for_record(
                        record, project_id, task_db, onedrive_token=onedrive_token
                    )

                    if full_text_source == "abstract_only":
                        # Still no full text even after user had a chance to upload.
                        # Record the gap and move on without an FT decision.
                        abstract_only_count += 1
                        await task_db.execute(
                            update(LlmScreeningRun)
                            .where(LlmScreeningRun.id == run_id)
                            .values(
                                processed_records=LlmScreeningRun.processed_records + 1,
                                abstract_only_count=LlmScreeningRun.abstract_only_count + 1,
                            )
                        )
                        await task_db.commit()
                        return

                    system_prompt: Optional[str] = None
                    if llm_config:
                        if llm_config.get("use_full_override") and llm_config.get("full_override_prompt"):
                            system_prompt = llm_config["full_override_prompt"]
                        elif llm_config.get("custom_system_additions"):
                            system_prompt = llm_config["custom_system_additions"] + "\n\n" + _SYSTEM_PROMPT

                    prompt = _build_prompt(
                        record,
                        full_text=full_text,
                        full_text_source=full_text_source,
                        criteria=criteria,
                        framework=framework_nodes,
                        llm_config=llm_config,
                        extraction_template=extraction_template,
                        include_extraction=include_extraction,
                    )

                    try:
                        llm_output = await _call_llm(
                            model, prompt,
                            anthropic_api_key, openrouter_api_key,
                            system_prompt_override=system_prompt,
                        )
                    except Exception:
                        logger.exception("LLM call failed for record %s (ft_only)", record.id)
                        return

                    extracted_json: Optional[dict] = None
                    if (
                        include_extraction
                        and extraction_template
                        and extraction_template.get("rows")
                        and llm_output.get("ft_decision") == "include"
                    ):
                        try:
                            extracted_json = await _extract_one_record(
                                record=record,
                                full_text=full_text,
                                extraction_template=extraction_template,
                                llm_config=llm_config,
                                model=model,
                                anthropic_api_key=anthropic_api_key,
                                openrouter_api_key=openrouter_api_key,
                                system_prompt_override=system_prompt,
                            )
                        except Exception:
                            logger.exception("Extraction failed for record %s (ft_only)", record.id)

                    result = LlmScreeningResult(
                        run_id=run_id,
                        project_id=project_id,
                        record_id=record.id,
                        cluster_id=None,
                        ta_decision="include",  # carried from phase 1
                        ta_reason=None,
                        ft_decision=llm_output.get("ft_decision"),
                        ft_reason=llm_output.get("ft_reason"),
                        matched_codes=llm_output.get("matched_codes") or [],
                        new_concepts=llm_output.get("new_concepts") or [],
                        full_text_source=full_text_source,
                        input_tokens=llm_output.get("_input_tokens"),
                        output_tokens=llm_output.get("_output_tokens"),
                        model=model,
                        extracted_json=extracted_json,
                    )

                    task_db.add(result)
                    await task_db.flush()

                    if result.extracted_json:
                        await _sync_extraction_to_shared_table(task_db, result, triggered_by_id)

                    ft_dec = result.ft_decision
                    if ft_dec == "include":
                        ft_included += 1
                    elif ft_dec == "exclude":
                        ft_excluded += 1
                    elif ft_dec == "uncertain":
                        ft_uncertain += 1
                    if result.new_concepts and isinstance(result.new_concepts, list):
                        new_concepts_total += len(result.new_concepts)

                    itok = result.input_tokens or 0
                    otok = result.output_tokens or 0
                    input_tok_total += itok
                    output_tok_total += otok
                    actual_cost += itok * in_price + otok * out_price

                    await task_db.execute(
                        update(LlmScreeningRun)
                        .where(LlmScreeningRun.id == run_id)
                        .values(
                            processed_records=LlmScreeningRun.processed_records + 1,
                            included_count=ft_included,
                            excluded_count=ft_excluded,
                            uncertain_count=ft_uncertain,
                            new_concepts_count=new_concepts_total,
                            input_tokens=input_tok_total,
                            output_tokens=output_tok_total,
                        )
                    )
                    await task_db.commit()

                except Exception:
                    logger.exception("Error in ft_only task for record %s", record_id)
                    # No explicit rollback — async with SessionLocal() close() handles it

    tasks = [_process_ft(rid) for rid in included_record_ids]
    await asyncio.gather(*tasks)

    await db.execute(
        update(LlmScreeningRun)
        .where(LlmScreeningRun.id == run_id)
        .values(
            status="completed",
            completed_at=datetime.now(tz=timezone.utc),
            actual_cost_usd=Decimal(str(round(actual_cost, 6))),
            included_count=ft_included,
            excluded_count=ft_excluded,
            uncertain_count=ft_uncertain,
            new_concepts_count=new_concepts_total,
            input_tokens=input_tok_total,
            output_tokens=output_tok_total,
            abstract_only_count=abstract_only_count,
        )
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------


def _build_prompt(
    record: Record,
    full_text: Optional[str],
    full_text_source: str,
    criteria: dict,
    framework: list,
    llm_config: Optional[dict] = None,
    extraction_template: Optional[dict] = None,
    include_extraction: bool = False,
) -> str:
    """Build the structured screening prompt for the LLM."""
    lines: list[str] = []

    # ── Research question (from llm_config) ───────────────────────────────
    if llm_config and llm_config.get("research_question"):
        lines.append("## Research Question\n")
        lines.append(llm_config["research_question"])
        lines.append("")

    # ── Criteria ──────────────────────────────────────────────────────────
    lines.append("## Inclusion / Exclusion Criteria\n")
    inclusion_items = criteria.get("inclusion") or []
    exclusion_items = criteria.get("exclusion") or []

    if inclusion_items:
        lines.append("**Inclusion criteria** (paper must meet ALL):")
        for item in inclusion_items:
            text = item.get("text", "") if isinstance(item, dict) else str(item)
            lines.append(f"  - {text}")
    else:
        lines.append("**Inclusion criteria**: (none specified)")

    lines.append("")

    if exclusion_items:
        lines.append("**Exclusion criteria** (paper is excluded if it meets ANY):")
        for item in exclusion_items:
            text = item.get("text", "") if isinstance(item, dict) else str(item)
            lines.append(f"  - {text}")
    else:
        lines.append("**Exclusion criteria**: (none specified)")

    lines.append("")

    # ── Thematic framework ────────────────────────────────────────────────
    lines.append("## Thematic Framework\n")
    if framework:
        # Group codes under their parent themes
        themes = [n for n in framework if n.namespace == "theme"]
        codes = [n for n in framework if n.namespace == "code"]
        theme_map = {t.id: t for t in themes}
        theme_codes: dict[uuid.UUID, list] = {t.id: [] for t in themes}
        ungrouped: list = []
        for code in codes:
            if code.parent_id and code.parent_id in theme_map:
                theme_codes[code.parent_id].append(code)
            else:
                ungrouped.append(code)

        for theme in themes:
            lines.append(f"**Theme: {theme.name}**")
            if theme.description:
                lines.append(f"  {theme.description}")
            for code in theme_codes.get(theme.id, []):
                desc = f" — {code.description}" if code.description else ""
                lines.append(f"  - Code [{code.id}]: {code.name}{desc}")
            lines.append("")

        if ungrouped:
            lines.append("**Ungrouped codes:**")
            for code in ungrouped:
                desc = f" — {code.description}" if code.description else ""
                lines.append(f"  - Code [{code.id}]: {code.name}{desc}")
            lines.append("")
    else:
        lines.append("(No thematic framework defined yet)\n")

    # ── Paper metadata ─────────────────────────────────────────────────────
    lines.append("## Paper Metadata\n")
    lines.append(f"**Title**: {record.title or '(no title)'}")
    if record.year:
        lines.append(f"**Year**: {record.year}")
    if record.authors:
        authors_str = "; ".join(record.authors[:5])
        if len(record.authors) > 5:
            authors_str += f" ... (+{len(record.authors) - 5} more)"
        lines.append(f"**Authors**: {authors_str}")
    if record.journal:
        lines.append(f"**Journal**: {record.journal}")
    if record.doi:
        lines.append(f"**DOI**: {record.doi}")

    lines.append("")
    lines.append(f"**Abstract**:")
    lines.append(record.abstract or "(no abstract)")
    lines.append("")

    # ── Full text ─────────────────────────────────────────────────────────
    if full_text and full_text_source != "abstract_only":
        lines.append(f"## Full Text (source: {full_text_source})\n")
        lines.append(full_text)
        lines.append("")
    else:
        lines.append("## Full Text\n")
        lines.append("(Full text not available — screening based on title/abstract only)")
        lines.append("")

    # ── Concept instructions (from llm_config) ───────────────────────────
    if llm_config and llm_config.get("concept_instructions"):
        lines.append("## Concepts and Extraction Guidance\n")
        lines.append(llm_config["concept_instructions"])
        lines.append("")

    # ── Extraction template (when extraction is enabled) ──────────────────
    if include_extraction and extraction_template and extraction_template.get("rows"):
        lines.append("## Extraction Template\n")
        lines.append(
            "If this paper is included at the full-text stage, also provide structured "
            "extraction data using the `submit_extraction` tool with these fields:"
        )
        for row in extraction_template["rows"]:
            domain = row.get("domain", "")
            item = row.get("item", "")
            row_type = row.get("type", "string")
            options = row.get("options") or []
            field_label = f"  - **{domain}: {item}**" if domain else f"  - **{item}**"
            if options:
                field_label += f" ({row_type}: {', '.join(str(o) for o in options)})"
            else:
                field_label += f" ({row_type})"
            lines.append(field_label)
        if llm_config and llm_config.get("extraction_instructions"):
            lines.append("")
            lines.append("**Additional extraction instructions:**")
            lines.append(llm_config["extraction_instructions"])
        lines.append("")

    # ── Instructions ──────────────────────────────────────────────────────
    lines.append("## Instructions\n")
    lines.append(
        "Use the `submit_screening_result` tool to provide your screening decision.\n"
        "\n"
        "For `ta_decision`: evaluate the title and abstract against the criteria above.\n"
        "For `ft_decision`: if full text is available, provide a full-text decision; "
        "otherwise leave it null.\n"
        "For `matched_codes`: list every thematic code that this paper provides evidence for. "
        "Use the exact code_id values from the framework above.\n"
        "For `new_concepts`: list any important concepts in the paper that are NOT captured "
        "by any existing code and may warrant adding a new code.\n"
    )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# LLM caller with retry
# ---------------------------------------------------------------------------

_TOOL_SCHEMA = [
    {
        "name": "submit_screening_result",
        "description": "Submit the screening decision and concept extraction for this paper",
        "input_schema": {
            "type": "object",
            "properties": {
                "ta_decision": {
                    "type": "string",
                    "enum": ["include", "exclude", "uncertain"],
                    "description": "Title/abstract screening decision",
                },
                "ta_reason": {
                    "type": "string",
                    "description": "1-2 sentence explanation for TA decision",
                },
                "ft_decision": {
                    "type": ["string", "null"],
                    "enum": ["include", "exclude", "uncertain", None],
                    "description": "Full-text screening decision, null if no full text",
                },
                "ft_reason": {
                    "type": ["string", "null"],
                    "description": "Explanation for FT decision, null if no full text",
                },
                "matched_codes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "code_id": {"type": "string"},
                            "code_name": {"type": "string"},
                            "snippet": {
                                "type": "string",
                                "description": "Relevant excerpt supporting this code",
                            },
                            "confidence": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1,
                            },
                        },
                        "required": ["code_id", "code_name", "confidence"],
                    },
                },
                "new_concepts": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "category_suggestion": {
                                "type": "string",
                                "description": (
                                    "Which existing category this might belong to, "
                                    "or 'New category needed'"
                                ),
                            },
                            "snippet": {"type": "string"},
                            "rationale": {"type": "string"},
                        },
                        "required": ["name", "category_suggestion", "rationale"],
                    },
                },
            },
            "required": ["ta_decision", "ta_reason"],
        },
    }
]

_SYSTEM_PROMPT = (
    "You are an expert systematic review researcher. "
    "Your task is to screen academic papers for inclusion in an evidence synthesis. "
    "You MUST use the submit_screening_result tool to return your answer — "
    "do not produce any other output."
)

_RETRY_DELAYS = [0.5, 2.0, 8.0]

# OpenAI-format tools (used for OpenRouter)
_OAI_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": _TOOL_SCHEMA[0]["name"],
            "description": _TOOL_SCHEMA[0]["description"],
            "parameters": _TOOL_SCHEMA[0]["input_schema"],
        },
    }
]


# ---------------------------------------------------------------------------
# Per-stage tool schemas for multi-agent mode
# ---------------------------------------------------------------------------

_CODE_MATCH_ITEMS = {
    "type": "object",
    "properties": {
        "code_id":    {"type": "string"},
        "code_name":  {"type": "string"},
        "snippet":    {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["code_id", "code_name", "confidence"],
}
_NEW_CONCEPT_ITEMS = {
    "type": "object",
    "properties": {
        "name":                {"type": "string"},
        "category_suggestion": {"type": "string"},
        "snippet":             {"type": "string"},
        "rationale":           {"type": "string"},
    },
    "required": ["name", "category_suggestion", "rationale"],
}

_TA_TOOL_SCHEMA: list[dict] = [
    {
        "name": "submit_ta_decision",
        "description": "Submit your title/abstract screening decision.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ta_decision": {
                    "type": "string",
                    "enum": ["include", "exclude", "uncertain"],
                    "description": "include=passes TA; exclude=does not meet criteria; uncertain=borderline",
                },
                "ta_reason":    {"type": "string", "description": "1-2 sentence justification"},
                "matched_codes": {"type": "array", "items": _CODE_MATCH_ITEMS},
                "new_concepts":  {"type": "array", "items": _NEW_CONCEPT_ITEMS},
            },
            "required": ["ta_decision", "ta_reason"],
        },
    }
]

_FT_TOOL_SCHEMA: list[dict] = [
    {
        "name": "submit_ft_decision",
        "description": "Submit your full-text screening decision.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ft_decision": {
                    "type": "string",
                    "enum": ["include", "exclude", "uncertain"],
                    "description": "include=confirmed included; exclude=excluded after full review",
                },
                "ft_reason":    {"type": "string", "description": "1-2 sentence justification"},
                "matched_codes": {"type": "array", "items": _CODE_MATCH_ITEMS},
                "new_concepts":  {"type": "array", "items": _NEW_CONCEPT_ITEMS},
            },
            "required": ["ft_decision", "ft_reason"],
        },
    }
]

_VERIFY_TOOL_SCHEMA: list[dict] = [
    {
        "name": "submit_verification",
        "description": "Review and verify the screening decisions made by the screening agents.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ta_assessment": {
                    "type": "string",
                    "enum": ["agree", "disagree", "uncertain"],
                    "description": "Do you agree with the TA decision?",
                },
                "ft_assessment": {
                    "type": "string",
                    "enum": ["agree", "disagree", "uncertain", "not_applicable"],
                    "description": "Do you agree with the FT decision? Use not_applicable if no FT screening was done.",
                },
                "override_recommendation": {
                    "type": "string",
                    "enum": ["include", "exclude", "uncertain", "no_change"],
                    "description": "If you disagree, what decision do you recommend? Use no_change if you agree.",
                },
                "verification_notes": {
                    "type": "string",
                    "description": "Reasoning for your assessment.",
                },
            },
            "required": ["ta_assessment", "ft_assessment", "override_recommendation", "verification_notes"],
        },
    }
]

_SYSTEM_PROMPT_TA = (
    "You are an expert systematic review researcher performing title/abstract screening. "
    "Evaluate ONLY the title and abstract — do NOT make full-text decisions. "
    "You MUST use the submit_ta_decision tool to return your answer — do not produce any other output."
)

_SYSTEM_PROMPT_FT = (
    "You are an expert systematic review researcher performing full-text screening. "
    "The paper passed title/abstract screening. Evaluate the full text to make a final decision. "
    "You MUST use the submit_ft_decision tool to return your answer — do not produce any other output."
)

_SYSTEM_PROMPT_VERIFY = (
    "You are an expert systematic review methodologist performing quality control. "
    "Your task is to independently verify screening decisions made by other reviewers. "
    "Review the record and the decisions provided, then give your assessment. "
    "You MUST use the submit_verification tool to return your answer — do not produce any other output."
)


def _build_ta_prompt(record: "Record", criteria: dict, framework: list, llm_config: Optional[dict] = None) -> str:
    """Build a TA-only screening prompt (abstract only, no full text)."""
    lines: list[str] = []

    if llm_config and llm_config.get("research_question"):
        lines += ["## Research Question\n", llm_config["research_question"], ""]

    lines.append("## Inclusion / Exclusion Criteria\n")
    for item in (criteria.get("inclusion") or []):
        text = item.get("text", "") if isinstance(item, dict) else str(item)
        lines.append(f"  - (include) {text}")
    for item in (criteria.get("exclusion") or []):
        text = item.get("text", "") if isinstance(item, dict) else str(item)
        lines.append(f"  - (exclude) {text}")
    lines.append("")

    if framework:
        themes = [n for n in framework if n.namespace == "theme"]
        codes  = [n for n in framework if n.namespace == "code"]
        lines.append("## Thematic Framework\n")
        for theme in themes:
            lines.append(f"**{theme.name}**")
            for code in codes:
                if code.parent_id == theme.id:
                    lines.append(f"  - [{code.id}] {code.name}")
            lines.append("")

    if llm_config and llm_config.get("concept_instructions"):
        lines += ["## Concepts and Extraction Guidance\n", llm_config["concept_instructions"], ""]

    lines += [
        "## Paper\n",
        f"**Title**: {record.title or '(no title)'}",
    ]
    if record.year:    lines.append(f"**Year**: {record.year}")
    if record.authors: lines.append(f"**Authors**: {'; '.join((record.authors or [])[:5])}")
    if record.journal: lines.append(f"**Journal**: {record.journal}")
    lines += ["", "**Abstract**:", record.abstract or "(no abstract)", ""]
    lines += ["## Task\n", "Use submit_ta_decision based on the title and abstract only."]
    return "\n".join(lines)


def _build_ft_prompt(
    record: "Record",
    full_text: Optional[str],
    full_text_source: str,
    criteria: dict,
    framework: list,
    ta_decision: str,
    ta_reason: str,
    llm_config: Optional[dict] = None,
) -> str:
    """Build a FT-only screening prompt, including context from TA decision."""
    lines: list[str] = []

    if llm_config and llm_config.get("research_question"):
        lines += ["## Research Question\n", llm_config["research_question"], ""]

    lines.append("## Inclusion / Exclusion Criteria\n")
    for item in (criteria.get("inclusion") or []):
        text = item.get("text", "") if isinstance(item, dict) else str(item)
        lines.append(f"  - (include) {text}")
    for item in (criteria.get("exclusion") or []):
        text = item.get("text", "") if isinstance(item, dict) else str(item)
        lines.append(f"  - (exclude) {text}")
    lines.append("")

    if llm_config and llm_config.get("concept_instructions"):
        lines += ["## Concepts and Extraction Guidance\n", llm_config["concept_instructions"], ""]

    lines += [
        "## Previous TA Decision\n",
        f"The title/abstract screener marked this paper as **{ta_decision}**.",
        f"Reason: {ta_reason}",
        "",
        "## Paper Metadata\n",
        f"**Title**: {record.title or '(no title)'}",
    ]
    if record.year:    lines.append(f"**Year**: {record.year}")
    if record.authors: lines.append(f"**Authors**: {'; '.join((record.authors or [])[:5])}")
    lines.append("")

    if full_text and full_text_source != "abstract_only":
        lines += [f"## Full Text (source: {full_text_source})\n", full_text, ""]
    else:
        lines += ["## Full Text\n", "(Not available — screening based on abstract only)", ""]

    lines.append("Use submit_ft_decision to give your final inclusion decision.")
    return "\n".join(lines)


def _build_verify_prompt(
    record: "Record",
    ta_decision: str,
    ta_reason: str,
    ft_decision: Optional[str],
    ft_reason: Optional[str],
    criteria: dict,
    llm_config: Optional[dict] = None,
) -> str:
    """Build a verification prompt summarising previous agent decisions."""
    lines: list[str] = []

    if llm_config and llm_config.get("research_question"):
        lines += ["## Research Question\n", llm_config["research_question"], ""]

    lines.append("## Criteria (summary)\n")
    for item in (criteria.get("inclusion") or []):
        text = item.get("text", "") if isinstance(item, dict) else str(item)
        lines.append(f"  - (include) {text}")
    for item in (criteria.get("exclusion") or []):
        text = item.get("text", "") if isinstance(item, dict) else str(item)
        lines.append(f"  - (exclude) {text}")
    lines.append("")

    lines += [
        "## Record\n",
        f"**Title**: {record.title or '(no title)'}",
        f"**Abstract**: {record.abstract or '(no abstract)'}",
        "",
        "## Decisions to Verify\n",
        f"**TA decision**: {ta_decision} — {ta_reason}",
    ]
    if ft_decision:
        lines.append(f"**FT decision**: {ft_decision} — {ft_reason or ''}")
    lines.append("")
    lines.append("Use submit_verification to give your independent assessment.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Multi-agent pipeline runner
# ---------------------------------------------------------------------------


async def _run_multi_agent_pipeline(
    record: "Record",
    full_text: Optional[str],
    full_text_source: str,
    pipeline: list[dict],
    criteria: dict,
    framework: list,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    db: AsyncSession,
    extraction_template: Optional[dict],
    include_extraction: bool,
    llm_config: Optional[dict],
    anthropic_api_key: Optional[str],
    openrouter_api_key: Optional[str],
) -> Optional[LlmScreeningResult]:
    """Run a record through the multi-agent pipeline.

    Agents run in pipeline order. Each agent's model/prompt is used for its stage.
    Conditional logic: FT screener only runs if TA includes; extractor only runs if FT includes.
    Verifier runs after TA+FT (if enabled).
    """
    agent_outputs: dict = {}
    ta_decision:   Optional[str] = None
    ta_reason:     Optional[str] = None
    ft_decision:   Optional[str] = None
    ft_reason:     Optional[str] = None
    matched_codes: list = []
    new_concepts:  list = []
    total_input:   int = 0
    total_output:  int = 0
    extracted_json: Optional[dict] = None
    primary_model  = pipeline[0]["model"] if pipeline else _DEFAULT_MODEL

    for agent in pipeline:
        if not agent.get("enabled", True):
            continue

        role   = agent["role"]
        model  = agent.get("model") or _DEFAULT_MODEL
        sys_add = agent.get("system_prompt_additions")
        sys_ovr = agent.get("system_prompt_override")

        try:
            if role == "ta_screener":
                prompt = _build_ta_prompt(record, criteria, framework, llm_config)
                system = sys_ovr or (_SYSTEM_PROMPT_TA if not sys_add else sys_add + "\n\n" + _SYSTEM_PROMPT_TA)
                out = await _call_llm(model, prompt, anthropic_api_key, openrouter_api_key,
                                      system_prompt_override=system, tool_schema_override=_TA_TOOL_SCHEMA)
                ta_decision   = out.get("ta_decision")
                ta_reason     = out.get("ta_reason")
                matched_codes = out.get("matched_codes") or []
                new_concepts  = out.get("new_concepts") or []
                total_input  += out.get("_input_tokens") or 0
                total_output += out.get("_output_tokens") or 0
                primary_model = model
                agent_outputs["ta"] = {
                    "decision": ta_decision, "reason": ta_reason,
                    "model": model, "tokens_in": out.get("_input_tokens"), "tokens_out": out.get("_output_tokens"),
                }
                # Stop early if excluded
                if ta_decision == "exclude":
                    break

            elif role == "ft_screener":
                if ta_decision != "include":
                    continue  # skip FT unless TA included
                prompt = _build_ft_prompt(record, full_text, full_text_source, criteria, framework,
                                          ta_decision, ta_reason or "", llm_config)
                system = sys_ovr or (_SYSTEM_PROMPT_FT if not sys_add else sys_add + "\n\n" + _SYSTEM_PROMPT_FT)
                out = await _call_llm(model, prompt, anthropic_api_key, openrouter_api_key,
                                      system_prompt_override=system, tool_schema_override=_FT_TOOL_SCHEMA)
                ft_decision   = out.get("ft_decision")
                ft_reason     = out.get("ft_reason")
                # merge codes/concepts from FT agent
                matched_codes = matched_codes + (out.get("matched_codes") or [])
                new_concepts  = new_concepts  + (out.get("new_concepts") or [])
                total_input  += out.get("_input_tokens") or 0
                total_output += out.get("_output_tokens") or 0
                agent_outputs["ft"] = {
                    "decision": ft_decision, "reason": ft_reason,
                    "model": model, "tokens_in": out.get("_input_tokens"), "tokens_out": out.get("_output_tokens"),
                }

            elif role == "extractor":
                if ft_decision != "include":
                    continue
                if not include_extraction or not extraction_template or not extraction_template.get("rows"):
                    continue
                try:
                    extracted_json = await _extract_one_record(
                        record=record, full_text=full_text,
                        extraction_template=extraction_template, llm_config=llm_config,
                        model=model, anthropic_api_key=anthropic_api_key,
                        openrouter_api_key=openrouter_api_key,
                    )
                    agent_outputs["extract"] = {"model": model, "fields": list((extracted_json or {}).keys())}
                except Exception:
                    logger.exception("Multi-agent extraction failed for record %s", record.id)

            elif role == "verifier":
                prompt = _build_verify_prompt(record, ta_decision or "uncertain", ta_reason or "",
                                              ft_decision, ft_reason, criteria, llm_config)
                system = sys_ovr or (_SYSTEM_PROMPT_VERIFY if not sys_add else sys_add + "\n\n" + _SYSTEM_PROMPT_VERIFY)
                out = await _call_llm(model, prompt, anthropic_api_key, openrouter_api_key,
                                      system_prompt_override=system, tool_schema_override=_VERIFY_TOOL_SCHEMA)
                total_input  += out.get("_input_tokens") or 0
                total_output += out.get("_output_tokens") or 0
                agent_outputs["verify"] = {
                    "ta_assessment":           out.get("ta_assessment"),
                    "ft_assessment":           out.get("ft_assessment"),
                    "override_recommendation": out.get("override_recommendation"),
                    "verification_notes":      out.get("verification_notes"),
                    "model": model,
                }

            elif role == "custom":
                # Custom agent: runs after all standard stages; receives full context
                agent_id = agent.get("id", "custom")
                prompt = _build_prompt(record, full_text, full_text_source, criteria, framework, llm_config)
                system = sys_ovr or (sys_add + "\n\n" + _SYSTEM_PROMPT if sys_add else None)
                out = await _call_llm(model, prompt, anthropic_api_key, openrouter_api_key,
                                      system_prompt_override=system)
                total_input  += out.get("_input_tokens") or 0
                total_output += out.get("_output_tokens") or 0
                agent_outputs[agent_id] = {
                    "model": model, "tokens_in": out.get("_input_tokens"), "tokens_out": out.get("_output_tokens"),
                    "ta_decision": out.get("ta_decision"), "ft_decision": out.get("ft_decision"),
                }

        except Exception:
            logger.exception("Agent %s (%s) failed for record %s", agent.get("id"), role, record.id)

    if ta_decision is None:
        return None  # No TA screener ran successfully

    return LlmScreeningResult(
        run_id=run_id,
        project_id=project_id,
        record_id=record.id,
        cluster_id=None,
        ta_decision=ta_decision,
        ta_reason=ta_reason,
        ft_decision=ft_decision,
        ft_reason=ft_reason,
        matched_codes=matched_codes or [],
        new_concepts=new_concepts or [],
        full_text_source=full_text_source,
        input_tokens=total_input,
        output_tokens=total_output,
        model=primary_model,
        extracted_json=extracted_json,
        agent_outputs=agent_outputs if agent_outputs else None,
    )


# ---------------------------------------------------------------------------
# Adaptive cost estimation helper
# ---------------------------------------------------------------------------


def estimate_pipeline_cost(
    total_records: int,
    agent_mode: str,
    pipeline: list[dict],
    avg_ta_tokens: Optional[int] = None,
    effective_ft_tokens: Optional[int] = None,
    include_extraction: bool = True,
) -> dict[str, Any]:
    """Compute stage-by-stage cost estimate for a given pipeline.

    When avg_ta_tokens / effective_ft_tokens are provided (from actual record data),
    they override the hardcoded _STAGE_AVG_INPUT defaults for more accurate estimates.
    Returns a dict with total cost, per-stage breakdown, and estimated minutes.
    """
    stages: list[dict] = []
    total_cost = 0.0
    total_minutes = 0.0
    total_input_toks = 0
    total_output_toks = 0

    # Use caller-supplied token estimates when available; fall back to table defaults
    ta_input = avg_ta_tokens if avg_ta_tokens is not None else _STAGE_AVG_INPUT["ta"]
    ft_input = effective_ft_tokens if effective_ft_tokens is not None else _STAGE_AVG_INPUT["ft"]

    if agent_mode == "single":
        # Single agent: one model for all stages
        model = pipeline[0]["model"] if pipeline else _DEFAULT_MODEL
        in_p, out_p = _cost_per_token(model)
        mins_p = _MINUTES_PER_RECORD.get(model, 0.015)

        # TA pass: all records
        ta_in  = total_records * ta_input
        ta_out = total_records * _STAGE_AVG_OUTPUT["ta"]
        # FT pass: ~30% of records
        ft_n   = int(total_records * _STAGE_REACH["ft"])
        ft_in  = ft_n * ft_input
        ft_out = ft_n * _STAGE_AVG_OUTPUT["ft"]
        # Extraction: ~15% of records (only if requested)
        ex_n   = int(total_records * _STAGE_REACH["extract"]) if include_extraction else 0
        ex_in  = ex_n * _STAGE_AVG_INPUT["extract"]
        ex_out = ex_n * _STAGE_AVG_OUTPUT["extract"]

        stage_rows = [
            ("Screening (TA)", total_records, ta_in, ta_out),
            ("Screening (FT)", ft_n, ft_in, ft_out),
        ]
        if include_extraction:
            stage_rows.append(("Extraction", ex_n, ex_in, ex_out))

        for label, n, i_toks, o_toks in stage_rows:
            cost  = i_toks * in_p + o_toks * out_p
            mins  = n * mins_p
            reach_pct = round((n / total_records * 100) if total_records > 0 else 0.0, 1)
            stages.append({
                "stage": label,
                "role": label,
                "records": n,
                "model": model,
                "input_tokens": i_toks,
                "output_tokens": o_toks,
                "cost_usd": round(cost, 5),
                "minutes": round(mins, 1),
                "reach_pct": reach_pct,
            })
            total_cost    += cost
            total_minutes += mins
            total_input_toks  += i_toks
            total_output_toks += o_toks

    else:  # multi-agent
        # Map role → (stage_key, input_tokens_per_record)
        role_reach = {"ta_screener": "ta", "ft_screener": "ft", "extractor": "extract", "verifier": "verify"}
        role_input_override = {"ta_screener": ta_input, "ft_screener": ft_input}
        for agent in pipeline:
            if not agent.get("enabled", True):
                continue
            role   = agent.get("role", "single")
            # Skip extractor stage if extraction not requested
            if role == "extractor" and not include_extraction:
                continue
            model  = agent.get("model") or _DEFAULT_MODEL
            stage_key = role_reach.get(role, "single")
            reach_frac = _STAGE_REACH.get(stage_key, 1.0)
            n_records  = int(total_records * reach_frac)
            # Use empirical token override for TA/FT stages when available
            per_record_input = role_input_override.get(role, _STAGE_AVG_INPUT.get(stage_key, _AVG_INPUT_TOKENS))
            i_toks = n_records * per_record_input
            o_toks = n_records * _STAGE_AVG_OUTPUT.get(stage_key, _AVG_OUTPUT_TOKENS)
            in_p, out_p = _cost_per_token(model)
            mins_p      = _MINUTES_PER_RECORD.get(model, 0.015)
            cost        = i_toks * in_p + o_toks * out_p
            mins        = n_records * mins_p
            stages.append({
                "stage": agent.get("name", role),
                "role": role,
                "agent_id": agent.get("id"),
                "records": n_records,
                "model": model,
                "input_tokens": i_toks,
                "output_tokens": o_toks,
                "reach_pct": round(reach_frac * 100, 1),
                "cost_usd": round(cost, 5),
                "minutes": round(mins, 1),
            })
            total_cost    += cost
            total_minutes += mins
            total_input_toks  += i_toks
            total_output_toks += o_toks

    # Parallelism discount for minutes (multi-agent stages can overlap somewhat)
    if agent_mode == "multi":
        total_minutes = max(total_minutes * 0.7, 5.0)
    else:
        total_minutes = max(total_minutes, 5.0)

    return {
        "total_records":           total_records,
        "estimated_input_tokens":  total_input_toks,
        "estimated_output_tokens": total_output_toks,
        "estimated_cost_usd":      round(total_cost, 4),
        "estimated_minutes":       round(total_minutes, 1),
        "stages":                  stages,
    }


async def _call_llm(
    model: str,
    prompt: str,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    system_prompt_override: Optional[str] = None,
    tool_schema_override: Optional[list] = None,
) -> dict[str, Any]:
    """Dispatch to the correct provider backend based on model name + env keys.

    Returns the tool input dict plus '_input_tokens' / '_output_tokens' keys.
    system_prompt_override replaces _SYSTEM_PROMPT when provided.
    tool_schema_override replaces _TOOL_SCHEMA/_OAI_TOOLS when provided.
    """
    provider = _detect_provider(model)
    if provider == "anthropic":
        return await _call_anthropic(
            model,
            prompt,
            api_key=anthropic_api_key,
            system_prompt_override=system_prompt_override,
            tool_schema_override=tool_schema_override,
        )
    return await _call_openrouter(
        model,
        prompt,
        api_key=openrouter_api_key,
        system_prompt_override=system_prompt_override,
        tool_schema_override=tool_schema_override,
    )


async def _call_anthropic(
    model: str,
    prompt: str,
    api_key: Optional[str] = None,
    system_prompt_override: Optional[str] = None,
    tool_schema_override: Optional[list] = None,
) -> dict[str, Any]:
    """Call Anthropic API directly using native tool_use."""
    import anthropic  # type: ignore

    client = anthropic.AsyncAnthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))
    effective_system = system_prompt_override or _SYSTEM_PROMPT
    effective_tools = tool_schema_override or _TOOL_SCHEMA
    tool_name = effective_tools[0]["name"]

    last_exc: Optional[Exception] = None
    for attempt, delay in enumerate([0.0] + _RETRY_DELAYS):
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=1024,
                system=effective_system,
                tools=effective_tools,  # type: ignore[arg-type]
                tool_choice={"type": "any"},
                messages=[{"role": "user", "content": prompt}],
            )
            result: dict[str, Any] = {}
            for block in response.content:
                if block.type == "tool_use" and block.name == tool_name:
                    result = dict(block.input)
                    break
            result["_input_tokens"] = response.usage.input_tokens
            result["_output_tokens"] = response.usage.output_tokens
            return result

        except anthropic.RateLimitError as exc:
            last_exc = exc
            logger.warning(
                "Anthropic rate limit on attempt %d, retrying in %.1fs",
                attempt + 1,
                _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)],
            )
            continue
        except Exception:
            raise

    raise RuntimeError(f"Anthropic API rate-limit exceeded after retries: {last_exc}")


async def _call_openrouter(
    model: str,
    prompt: str,
    api_key: Optional[str] = None,
    system_prompt_override: Optional[str] = None,
    tool_schema_override: Optional[list] = None,
) -> dict[str, Any]:
    """Call any model via OpenRouter using the OpenAI-compatible function-calling API.

    OpenRouter docs: https://openrouter.ai/docs
    Set OPENROUTER_API_KEY in the environment, or pass api_key directly.
    """
    from openai import AsyncOpenAI, RateLimitError  # type: ignore

    resolved_key = api_key or os.environ.get("OPENROUTER_API_KEY")
    if not resolved_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. "
            "Get a key at https://openrouter.ai/keys and add it to your environment."
        )

    effective_system = system_prompt_override or _SYSTEM_PROMPT
    # Convert Anthropic-format tools to OpenAI format if custom schema provided
    if tool_schema_override:
        effective_oai_tools = [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                },
            }
            for t in tool_schema_override
        ]
    else:
        effective_oai_tools = _OAI_TOOLS
    tool_name = effective_oai_tools[0]["function"]["name"]

    client = AsyncOpenAI(
        api_key=resolved_key,
        base_url="https://openrouter.ai/api/v1",
        default_headers={
            "HTTP-Referer": "https://evidence-platform",
            "X-Title": "EvidencePlatform",
        },
    )

    last_exc: Optional[Exception] = None
    for attempt, delay in enumerate([0.0] + _RETRY_DELAYS):
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            response = await client.chat.completions.create(
                model=model,
                max_tokens=1024,
                messages=[
                    {"role": "system", "content": effective_system},
                    {"role": "user", "content": prompt},
                ],
                tools=effective_oai_tools,  # type: ignore[arg-type]
                tool_choice={
                    "type": "function",
                    "function": {"name": tool_name},
                },
            )
            result: dict[str, Any] = {}
            choice = response.choices[0]
            if choice.message.tool_calls:
                raw = choice.message.tool_calls[0].function.arguments
                result = json.loads(raw) if isinstance(raw, str) else dict(raw)

            usage = response.usage
            result["_input_tokens"] = getattr(usage, "prompt_tokens", 0) or 0
            result["_output_tokens"] = getattr(usage, "completion_tokens", 0) or 0
            return result

        except RateLimitError as exc:
            last_exc = exc
            logger.warning(
                "OpenRouter rate limit on attempt %d, retrying in %.1fs",
                attempt + 1,
                _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)],
            )
            continue
        except Exception:
            raise

    raise RuntimeError(f"OpenRouter rate-limit exceeded after retries: {last_exc}")


# ---------------------------------------------------------------------------
# Prompt preview (public helper for the preview endpoint)
# ---------------------------------------------------------------------------


async def build_prompt_preview(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID] = None,
) -> dict[str, Any]:
    """Return the resolved system + user prompts for a sample record.

    Uses the first record in the project if record_id is not specified.
    """
    project: Optional[Project] = await db.get(Project, project_id)
    criteria: dict = {}
    llm_config: Optional[dict] = None
    extraction_template: Optional[dict] = None
    if project:
        criteria = project.criteria or {}
        llm_config = project.llm_config
        extraction_template = project.extraction_template

    framework_nodes = (
        await db.execute(
            select(OntologyNode)
            .where(
                OntologyNode.project_id == project_id,
                OntologyNode.namespace.in_(["theme", "code"]),
            )
            .order_by(OntologyNode.namespace.desc(), OntologyNode.position)
        )
    ).scalars().all()

    if record_id is not None:
        record: Optional[Record] = await db.get(Record, record_id)
    else:
        record = (
            await db.execute(
                select(Record)
                .where(Record.project_id == project_id)
                .order_by(Record.created_at)
                .limit(1)
            )
        ).scalar_one_or_none()

    if record is None:
        return {"system_prompt": _SYSTEM_PROMPT, "user_prompt": "(No records in project)"}

    include_extraction = bool(
        extraction_template and extraction_template.get("rows")
    )
    user_prompt = _build_prompt(
        record,
        None,
        "abstract_only",
        criteria,
        framework_nodes,
        llm_config=llm_config,
        extraction_template=extraction_template,
        include_extraction=include_extraction,
    )

    system_prompt = _SYSTEM_PROMPT
    if llm_config:
        if llm_config.get("use_full_override") and llm_config.get("full_override_prompt"):
            system_prompt = llm_config["full_override_prompt"]
        elif llm_config.get("custom_system_additions"):
            system_prompt = llm_config["custom_system_additions"] + "\n\n" + _SYSTEM_PROMPT

    return {"system_prompt": system_prompt, "user_prompt": user_prompt}


# ---------------------------------------------------------------------------
# Structured extraction helpers
# ---------------------------------------------------------------------------


def _build_extraction_tool_schema(template: dict) -> list:
    """Build an Anthropic-format tool schema from the project's extraction_template."""
    rows = template.get("rows") or []
    properties: dict[str, Any] = {}
    required: list[str] = []

    for row in rows:
        row_id = row.get("id", "")
        if not row_id:
            continue
        domain = row.get("domain", "")
        item = row.get("item", "")
        row_type = row.get("type", "string")
        options = row.get("options") or []
        description = f"{domain}: {item}" if domain else item

        prop: dict[str, Any] = {"description": description}
        if row_type in ("single_select",) and options:
            prop["type"] = "string"
            prop["enum"] = [str(o) for o in options]
        elif row_type == "multi_select" and options:
            prop["type"] = "array"
            prop["items"] = {"type": "string", "enum": [str(o) for o in options]}
        else:
            prop["type"] = "string"

        properties[row_id] = prop
        required.append(row_id)

    return [
        {
            "name": "submit_extraction",
            "description": "Submit structured data extraction for this paper",
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        }
    ]


async def _extract_one_record(
    record: Record,
    full_text: Optional[str],
    extraction_template: dict,
    llm_config: Optional[dict],
    model: str,
    anthropic_api_key: Optional[str] = None,
    openrouter_api_key: Optional[str] = None,
    system_prompt_override: Optional[str] = None,
) -> Optional[dict]:
    """Second LLM call: structured extraction for an FT-included record.

    Returns a dict keyed by extraction_template row id, or None on failure.
    """
    rows = extraction_template.get("rows") or []
    if not rows:
        return None

    tool_schema = _build_extraction_tool_schema(extraction_template)

    # Build a focused extraction prompt
    lines: list[str] = []
    lines.append("## Paper\n")
    lines.append(f"**Title**: {record.title or '(no title)'}")
    if record.abstract:
        lines.append(f"\n**Abstract**: {record.abstract}")
    if full_text:
        lines.append(f"\n## Full Text\n{full_text[:8000]}")  # cap at 8k chars
    lines.append("")
    lines.append("## Extraction Fields\n")
    for row in rows:
        domain = row.get("domain", "")
        item = row.get("item", "")
        label = f"{domain}: {item}" if domain else item
        lines.append(f"- **{label}**")
    if llm_config and llm_config.get("extraction_instructions"):
        lines.append(f"\n**Instructions**: {llm_config['extraction_instructions']}")
    lines.append(
        "\nUse the `submit_extraction` tool to return the extracted values for each field."
    )

    extraction_system = (
        system_prompt_override
        or (
            "You are an expert evidence synthesis researcher performing structured data extraction. "
            "Extract only what is explicitly stated in the paper. "
            "You MUST use the submit_extraction tool to return your answer."
        )
    )

    try:
        result = await _call_llm(
            model,
            "\n".join(lines),
            anthropic_api_key=anthropic_api_key,
            openrouter_api_key=openrouter_api_key,
            system_prompt_override=extraction_system,
            tool_schema_override=tool_schema,
        )
        # Remove internal token-counting keys
        result.pop("_input_tokens", None)
        result.pop("_output_tokens", None)
        if not result:
            return None

        # Wrap in the ExtractionJson envelope so format matches human extractions.
        # Human extractions store cell values under extracted_json.table[row_id].
        # The LLM tool returns a flat dict keyed by row_id — move that under "table".
        return {
            "table": result,
            "free_note": "",
            "framework_updated": False,
            "framework_update_note": "",
            "levels": [],
            "dimensions": [],
            "snippets": [],
        }
    except Exception:
        logger.exception("Extraction LLM call failed for record %s", record.id)
        return None
