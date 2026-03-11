"""LLM screening service.

Orchestrates parallel Anthropic API calls to screen all records in a project,
map concepts to the existing thematic framework, and surface new concepts.

Workflow:
  1. estimate_run() → cost/time preview (no DB side effects)
  2. create_and_launch_run() → creates LlmScreeningRun row, fires background task
  3. _execute_run() → background task: iterates all records, screens each,
                       stores LlmScreeningResult

LLM call structure (tool_use for guaranteed JSON):
  - System: role + JSON-only instruction
  - User: criteria + thematic framework + paper metadata
  - Tool schema: ta_decision, ta_reason, ft_decision, ft_reason,
                 matched_codes, new_concepts

Rate limiting: asyncio.Semaphore(CONCURRENT_REQUESTS = 8)
Retry: exponential backoff on anthropic.RateLimitError (max 3 retries)
"""
from __future__ import annotations

import asyncio
import logging
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
from app.utils.fulltext_fetcher import get_full_text

logger = logging.getLogger(__name__)

CONCURRENT_REQUESTS = 8

# ---------------------------------------------------------------------------
# Pricing table (USD per token)
# ---------------------------------------------------------------------------

_PRICING: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5-20251001": (0.80 / 1_000_000, 4.00 / 1_000_000),
    "claude-sonnet-4-6": (3.00 / 1_000_000, 15.00 / 1_000_000),
    "claude-opus-4-6": (15.00 / 1_000_000, 75.00 / 1_000_000),
}

_MINUTES_PER_RECORD: dict[str, float] = {
    "claude-haiku-4-5-20251001": 0.008,
    "claude-sonnet-4-6": 0.015,
    "claude-opus-4-6": 0.02,
}

# Estimated tokens per record (abstract-only baseline)
_AVG_INPUT_TOKENS = 1500
_AVG_OUTPUT_TOKENS = 400


def _cost_per_token(model: str) -> tuple[float, float]:
    """Return (input_price_per_token, output_price_per_token) in USD."""
    return _PRICING.get(model, _PRICING["claude-sonnet-4-6"])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def estimate_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    model: str,
) -> dict[str, Any]:
    """Return cost/time preview for a screening run. No DB side effects."""
    total: int = (
        await db.execute(
            select(func.count()).select_from(Record).where(Record.project_id == project_id)
        )
    ).scalar_one()

    in_price, out_price = _cost_per_token(model)
    estimated_input_tokens = total * _AVG_INPUT_TOKENS
    estimated_output_tokens = total * _AVG_OUTPUT_TOKENS
    cost = estimated_input_tokens * in_price + estimated_output_tokens * out_price

    mins_per = _MINUTES_PER_RECORD.get(model, 0.015)
    estimated_minutes = max(5.0, total * mins_per)

    # Build per-model cost breakdown for reference
    cost_breakdown: dict[str, float] = {}
    for m, (ip, op) in _PRICING.items():
        cost_breakdown[m] = round(
            estimated_input_tokens * ip + estimated_output_tokens * op, 4
        )

    return {
        "total_records": total,
        "estimated_input_tokens": estimated_input_tokens,
        "estimated_output_tokens": estimated_output_tokens,
        "estimated_cost_usd": round(cost, 4),
        "estimated_minutes": round(estimated_minutes, 1),
        "cost_breakdown": cost_breakdown,
    }


async def create_and_launch_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    model: str,
    triggered_by: Optional[uuid.UUID],
    background_tasks: BackgroundTasks,
) -> LlmScreeningRun:
    """Create an LlmScreeningRun row and enqueue the background execution."""
    estimate = await estimate_run(db, project_id, model)

    run = LlmScreeningRun(
        project_id=project_id,
        status="queued",
        model=model,
        total_records=estimate["total_records"],
        estimated_cost_usd=Decimal(str(estimate["estimated_cost_usd"])),
        triggered_by=triggered_by,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    run_id = run.id
    background_tasks.add_task(_execute_run, project_id, run_id, model)
    return run


# ---------------------------------------------------------------------------
# Background execution
# ---------------------------------------------------------------------------


async def _execute_run(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
) -> None:
    """Background task: screen every record in the project using the LLM."""
    async with SessionLocal() as db:
        try:
            await _do_execute_run(db, project_id, run_id, model)
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


async def _do_execute_run(
    db: AsyncSession,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
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

    # Load project criteria
    project: Optional[Project] = await db.get(Project, project_id)
    criteria: dict = {}
    if project and project.criteria:
        criteria = project.criteria

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
                result = await _screen_one_record(
                    record=record,
                    project_id=project_id,
                    run_id=run_id,
                    model=model,
                    criteria=criteria,
                    framework=framework_nodes,
                    db=db,
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


async def _screen_one_record(
    record: Record,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    model: str,
    criteria: dict,
    framework: list,
    db: AsyncSession,
) -> Optional[LlmScreeningResult]:
    """Screen a single record: fetch full text, call LLM, return result row."""
    # Extract pmid / pmcid from the first record_source for this record
    rs_row = (
        await db.execute(
            select(RecordSource).where(RecordSource.record_id == record.id).limit(1)
        )
    ).scalar_one_or_none()

    pmid: Optional[str] = None
    pmcid: Optional[str] = None
    if rs_row and rs_row.raw_data:
        raw = rs_row.raw_data
        pmid = (
            raw.get("pmid")
            or raw.get("accession_number")
            or raw.get("pubmed_id")
        )
        # PMCID may be a LID list entry containing "[pmc]"
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

    full_text, full_text_source = await get_full_text(
        record_id=record.id,
        project_id=project_id,
        doi=record.doi,
        pmid=str(pmid) if pmid else None,
        pmcid=str(pmcid) if pmcid else None,
        db=db,
    )

    prompt = _build_prompt(record, full_text, full_text_source, criteria, framework)

    try:
        llm_output = await _call_llm(model, prompt)
    except Exception:
        logger.exception("LLM call failed for record %s", record.id)
        return None

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
) -> str:
    """Build the structured screening prompt for the LLM."""
    lines: list[str] = []

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


async def _call_llm(model: str, prompt: str) -> dict[str, Any]:
    """Call Anthropic API with tool_use, retry on RateLimitError.

    Returns the tool input dict plus '_input_tokens' and '_output_tokens' keys.
    """
    import anthropic  # type: ignore

    client = anthropic.AsyncAnthropic()

    last_exc: Optional[Exception] = None
    for attempt, delay in enumerate([0.0] + _RETRY_DELAYS):
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=1024,
                system=_SYSTEM_PROMPT,
                tools=_TOOL_SCHEMA,  # type: ignore[arg-type]
                tool_choice={"type": "any"},
                messages=[{"role": "user", "content": prompt}],
            )
            # Extract tool_use block
            result: dict[str, Any] = {}
            for block in response.content:
                if block.type == "tool_use" and block.name == "submit_screening_result":
                    result = dict(block.input)
                    break

            result["_input_tokens"] = response.usage.input_tokens
            result["_output_tokens"] = response.usage.output_tokens
            return result

        except anthropic.RateLimitError as exc:
            last_exc = exc
            logger.warning("Anthropic rate limit on attempt %d, retrying in %.1fs", attempt + 1, _RETRY_DELAYS[attempt] if attempt < len(_RETRY_DELAYS) else _RETRY_DELAYS[-1])
            continue
        except Exception:
            raise

    raise RuntimeError(f"Anthropic API rate-limit exceeded after retries: {last_exc}")
