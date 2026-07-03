"""LLM usage & audit endpoints — read views over the llm_calls table.

GET /projects/{id}/llm-usage            → aggregate tokens/cost by feature and model
GET /projects/{id}/llm-calls            → paginated call log (no prompt bodies)
GET /projects/{id}/llm-calls/{call_id}  → single call with full prompt/response
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE
from app.models.llm_call import LlmCall
from app.models.user import User

router = APIRouter(prefix="/projects", tags=["llm-usage"])


def _since(days: Optional[int]) -> Optional[datetime]:
    if days is None:
        return None
    return datetime.now(tz=timezone.utc) - timedelta(days=days)


@router.get("/{project_id}/llm-usage")
async def get_llm_usage(
    project_id: uuid.UUID,
    days: Optional[int] = Query(default=None, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Aggregate LLM resource usage for a project: totals plus per-feature and per-model breakdowns."""
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)

    filters = [LlmCall.project_id == project_id]
    since = _since(days)
    if since is not None:
        filters.append(LlmCall.created_at >= since)

    agg_cols = [
        func.count(LlmCall.id).label("calls"),
        func.count(LlmCall.id).filter(LlmCall.status == "error").label("errors"),
        func.coalesce(func.sum(LlmCall.input_tokens), 0).label("input_tokens"),
        func.coalesce(func.sum(LlmCall.output_tokens), 0).label("output_tokens"),
        func.coalesce(func.sum(LlmCall.cost_usd), 0).label("cost_usd"),
    ]

    def _row_dict(row) -> dict[str, Any]:
        return {
            "calls": row.calls,
            "errors": row.errors,
            "input_tokens": int(row.input_tokens),
            "output_tokens": int(row.output_tokens),
            "cost_usd": float(row.cost_usd),
        }

    totals_row = (await db.execute(select(*agg_cols).where(*filters))).one()

    by_feature = [
        {"feature": row.feature, **_row_dict(row)}
        for row in (await db.execute(
            select(LlmCall.feature, *agg_cols)
            .where(*filters)
            .group_by(LlmCall.feature)
            .order_by(func.coalesce(func.sum(LlmCall.cost_usd), 0).desc())
        )).all()
    ]
    by_model = [
        {"model": row.model, "provider": row.provider, **_row_dict(row)}
        for row in (await db.execute(
            select(LlmCall.model, LlmCall.provider, *agg_cols)
            .where(*filters)
            .group_by(LlmCall.model, LlmCall.provider)
            .order_by(func.coalesce(func.sum(LlmCall.cost_usd), 0).desc())
        )).all()
    ]

    return {
        "days": days,
        "totals": _row_dict(totals_row),
        "by_feature": by_feature,
        "by_model": by_model,
    }


def _call_summary(c: LlmCall) -> dict[str, Any]:
    return {
        "id": str(c.id),
        "feature": c.feature,
        "provider": c.provider,
        "model": c.model,
        "status": c.status,
        "error_message": c.error_message,
        "input_tokens": c.input_tokens,
        "output_tokens": c.output_tokens,
        "cost_usd": float(c.cost_usd) if c.cost_usd is not None else None,
        "latency_ms": c.latency_ms,
        "run_id": str(c.run_id) if c.run_id else None,
        "user_id": str(c.user_id) if c.user_id else None,
        "created_at": c.created_at.isoformat(),
    }


@router.get("/{project_id}/llm-calls")
async def list_llm_calls(
    project_id: uuid.UUID,
    feature: Optional[str] = Query(default=None),
    run_id: Optional[uuid.UUID] = Query(default=None),
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Paginated LLM call log, newest first. Prompt/response bodies are in the detail endpoint."""
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)

    filters = [LlmCall.project_id == project_id]
    if feature:
        filters.append(LlmCall.feature == feature)
    if run_id:
        filters.append(LlmCall.run_id == run_id)
    if status:
        filters.append(LlmCall.status == status)

    total = (await db.execute(
        select(func.count(LlmCall.id)).where(*filters)
    )).scalar_one()
    calls = (await db.execute(
        select(LlmCall)
        .where(*filters)
        .order_by(LlmCall.created_at.desc())
        .limit(limit)
        .offset(offset)
    )).scalars().all()

    return {"total": total, "calls": [_call_summary(c) for c in calls]}


@router.get("/{project_id}/llm-calls/{call_id}")
async def get_llm_call(
    project_id: uuid.UUID,
    call_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Full audit record for one LLM call, including prompts and response."""
    await require_project_role(db, project_id, user.id, allowed=REVIEWER_ROLE)

    call = (await db.execute(
        select(LlmCall).where(LlmCall.id == call_id, LlmCall.project_id == project_id)
    )).scalar_one_or_none()
    if call is None:
        raise HTTPException(404, "LLM call not found")

    return {
        **_call_summary(call),
        "system_prompt": call.system_prompt,
        "prompt": call.prompt,
        "response": call.response,
    }
