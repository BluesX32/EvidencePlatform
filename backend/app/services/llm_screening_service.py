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
from app.models.llm_screening import LlmScreeningResult, LlmScreeningRun
from app.models.ontology_node import OntologyNode
from app.models.project import Project
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_queue import ScreeningQueue
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
# Fraction of records expected to reach each stage (rough priors)
_STAGE_REACH: dict[str, float] = {
    "ta":      1.00,   # all records go through TA
    "ft":      0.30,   # ~30% pass TA
    "extract": 0.15,   # ~50% of FT-included get extracted → 15% total
    "verify":  1.00,   # verifier sees all (or all TA-included)
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
) -> dict[str, Any]:
    """Return adaptive cost/time preview for a screening run. No DB side effects.

    When agent_mode='single', uses a flat per-record estimate.
    When agent_mode='multi', uses stage-by-stage estimates per enabled agent.
    When source_id is provided, counts only records from that source.
    """
    if source_id is not None:
        total_result = await db.execute(
            select(func.count())
            .select_from(Record)
            .join(RecordSource, RecordSource.record_id == Record.id)
            .where(
                Record.project_id == project_id,
                RecordSource.source_id == source_id,
            )
        )
    else:
        total_result = await db.execute(
            select(func.count()).select_from(Record).where(Record.project_id == project_id)
        )
    total: int = total_result.scalar_one()

    # Resolve effective pipeline
    if agent_mode == "multi":
        effective_pipeline: list[dict] = pipeline or DEFAULT_MULTI_PIPELINE
    else:
        effective_pipeline = pipeline or [{"id": "main", "role": "single", "model": model, "enabled": True}]
        # Ensure model is set on single-agent pipeline
        if effective_pipeline and effective_pipeline[0].get("role") == "single":
            effective_pipeline[0]["model"] = model

    pipeline_estimate = estimate_pipeline_cost(total, agent_mode, effective_pipeline)

    # Per-model cost comparison using same stage logic as the selected agent_mode
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
        est = estimate_pipeline_cost(total, "single", single_pl)
        cost_breakdown[m] = est["estimated_cost_usd"]

    return {
        "total_records":           total,
        "estimated_input_tokens":  pipeline_estimate["estimated_input_tokens"],
        "estimated_output_tokens": pipeline_estimate["estimated_output_tokens"],
        "estimated_cost_usd":      pipeline_estimate["estimated_cost_usd"],
        "estimated_minutes":       pipeline_estimate["estimated_minutes"],
        "cost_breakdown":          cost_breakdown,
        "stages":                  pipeline_estimate["stages"],
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
    else:
        background_tasks.add_task(
            _execute_run, project_id, run_id, model,
            anthropic_api_key, openrouter_api_key, effective_pipeline,
        )
    return run


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
    if run_row is not None:
        agent_mode = run_row.agent_mode or "single"
        if not effective_pipeline and run_row.agent_pipeline:
            effective_pipeline = run_row.agent_pipeline

    # Accumulate counters
    included = excluded = uncertain = new_concepts_total = 0
    input_tok_total = output_tok_total = 0
    actual_cost = 0.0
    in_price, out_price = _cost_per_token(model)

    semaphore = asyncio.Semaphore(CONCURRENT_REQUESTS)

    async def _process(record: Record) -> None:
        nonlocal included, excluded, uncertain, new_concepts_total
        nonlocal input_tok_total, output_tok_total, actual_cost

        async with semaphore:
            try:
                if agent_mode == "multi" and effective_pipeline:
                    full_text, full_text_source = await _fetch_fulltext_for_record(
                        record, project_id, db
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
                    )
                if result is None:
                    return

                db.add(result)
                await db.flush()

                # Update counters
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

            except Exception:
                logger.exception("Error screening record %s", record.id)
                await db.rollback()

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
    if run_row_sat is not None:
        agent_mode_sat = run_row_sat.agent_mode or "single"
        if not effective_pipeline_sat and run_row_sat.agent_pipeline:
            effective_pipeline_sat = run_row_sat.agent_pipeline

    included = excluded = uncertain = new_concepts_total = 0
    input_tok_total = output_tok_total = 0
    actual_cost = 0.0
    in_price, out_price = _cost_per_token(model)
    consecutive_no_new = 0
    stopped_early = False

    for record_id in record_ids:
        record: Optional[Record] = await db.get(Record, record_id)
        if record is None:
            continue

        try:
            if agent_mode_sat == "multi" and effective_pipeline_sat:
                full_text, full_text_source = await _fetch_fulltext_for_record(
                    record, project_id, db
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
                )
        except Exception:
            logger.exception("Error screening record %s in saturation run", record_id)
            continue

        if result is None:
            continue

        db.add(result)
        await db.flush()

        if result.ta_decision == "include":
            included += 1
        elif result.ta_decision == "exclude":
            excluded += 1
        elif result.ta_decision == "uncertain":
            uncertain += 1

        # Saturation counter: track consecutive records with no new concepts
        has_new_concepts = bool(result.new_concepts and len(result.new_concepts) > 0)
        if has_new_concepts:
            new_concepts_total += len(result.new_concepts)  # type: ignore[arg-type]
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


async def _fetch_fulltext_for_record(
    record: Record,
    project_id: uuid.UUID,
    db: AsyncSession,
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
) -> Optional[LlmScreeningResult]:
    """Screen a single record: fetch full text, call LLM, return result row."""
    full_text, full_text_source = await _fetch_fulltext_for_record(record, project_id, db)

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
        ta_decision=llm_output.get("ta_decision"),
        ta_reason=llm_output.get("ta_reason"),
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
) -> dict[str, Any]:
    """Compute stage-by-stage cost estimate for a given pipeline.

    Returns a dict with total cost, per-stage breakdown, and estimated minutes.
    """
    stages: list[dict] = []
    total_cost = 0.0
    total_minutes = 0.0
    total_input_toks = 0
    total_output_toks = 0

    if agent_mode == "single":
        # Single agent: one model for all stages
        model = pipeline[0]["model"] if pipeline else _DEFAULT_MODEL
        in_p, out_p = _cost_per_token(model)
        mins_p = _MINUTES_PER_RECORD.get(model, 0.015)

        # TA pass: all records
        ta_in  = total_records * _STAGE_AVG_INPUT["ta"]
        ta_out = total_records * _STAGE_AVG_OUTPUT["ta"]
        # FT pass: ~30% of records
        ft_n   = int(total_records * _STAGE_REACH["ft"])
        ft_in  = ft_n * _STAGE_AVG_INPUT["ft"]
        ft_out = ft_n * _STAGE_AVG_OUTPUT["ft"]
        # Extraction: ~15% of records
        ex_n   = int(total_records * _STAGE_REACH["extract"])
        ex_in  = ex_n * _STAGE_AVG_INPUT["extract"]
        ex_out = ex_n * _STAGE_AVG_OUTPUT["extract"]

        for label, n, i_toks, o_toks in [
            ("Screening (TA)", total_records, ta_in, ta_out),
            ("Screening (FT)", ft_n, ft_in, ft_out),
            ("Extraction",     ex_n, ex_in, ex_out),
        ]:
            cost  = i_toks * in_p + o_toks * out_p
            mins  = n * mins_p
            stages.append({"stage": label, "records": n, "model": model, "cost_usd": round(cost, 5), "minutes": round(mins, 1)})
            total_cost    += cost
            total_minutes += mins
            total_input_toks  += i_toks
            total_output_toks += o_toks

    else:  # multi-agent
        # Map role → reach fraction (relative to total)
        role_reach = {"ta_screener": "ta", "ft_screener": "ft", "extractor": "extract", "verifier": "verify"}
        for agent in pipeline:
            if not agent.get("enabled", True):
                continue
            role   = agent.get("role", "single")
            model  = agent.get("model") or _DEFAULT_MODEL
            stage_key = role_reach.get(role, "single")
            reach_frac = _STAGE_REACH.get(stage_key, 1.0)
            n_records  = int(total_records * reach_frac)
            i_toks = n_records * _STAGE_AVG_INPUT.get(stage_key, _AVG_INPUT_TOKENS)
            o_toks = n_records * _STAGE_AVG_OUTPUT.get(stage_key, _AVG_OUTPUT_TOKENS)
            in_p, out_p = _cost_per_token(model)
            mins_p      = _MINUTES_PER_RECORD.get(model, 0.015)
            cost        = i_toks * in_p + o_toks * out_p
            mins        = n_records * mins_p
            stages.append({
                "stage": agent.get("name", role),
                "agent_id": agent.get("id"),
                "records": n_records,
                "model": model,
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
        # Remove token-counting keys
        result.pop("_input_tokens", None)
        result.pop("_output_tokens", None)
        return result if result else None
    except Exception:
        logger.exception("Extraction LLM call failed for record %s", record.id)
        return None
