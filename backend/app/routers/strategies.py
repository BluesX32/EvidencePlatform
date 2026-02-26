"""Match-strategy management endpoints.

POST  /projects/{project_id}/strategies                — create a new named strategy
GET   /projects/{project_id}/strategies                — list all strategies
GET   /projects/{project_id}/strategies/active         — get the active strategy
GET   /projects/{project_id}/strategies/preview        — preview dedup without writing
PATCH /projects/{project_id}/strategies/{id}/activate  — set strategy as active
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.strategy_repo import StrategyRepo, VALID_PRESETS
from app.utils.match_keys import StrategyConfig
from app.utils.cluster_builder import TieredClusterBuilder, SourceRecord

router = APIRouter(prefix="/projects/{project_id}/strategies", tags=["strategies"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

PRESET_LABELS = {
    "doi_first_strict": "DOI + Strict fallback (title + author + year)",
    "doi_first_medium": "DOI + Medium fallback (title + year)",
    "strict": "Strict (title + author + year, ignores DOI)",
    "medium": "Medium (title + year)",
    "loose": "Loose (title + first author)",
}


class StrategyCreate(BaseModel):
    name: str
    # preset='custom' when using the field-chip builder with an explicit config dict
    preset: str = "doi_first_strict"
    # Direct StrategyConfig dict from the builder UI (overrides preset's defaults)
    config: Optional[dict] = None
    # Ordered list of fields used by this strategy (for UI display)
    selected_fields: Optional[list] = None
    activate: bool = False


class StrategyResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    preset: str
    preset_label: str
    config: dict
    selected_fields: Optional[list]
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True


def _to_response(s) -> StrategyResponse:
    return StrategyResponse(
        id=s.id,
        project_id=s.project_id,
        name=s.name,
        preset=s.preset,
        preset_label=PRESET_LABELS.get(s.preset, s.preset),
        config=s.config or {},
        selected_fields=s.selected_fields,
        is_active=s.is_active,
        created_at=s.created_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _require_project_access(
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


def _build_sources_from_rows(rs_rows) -> list[SourceRecord]:
    """Convert DB rows into SourceRecord objects for the cluster builder."""
    sources = []
    for row in rs_rows:
        raw = row.raw_data or {}
        pmid = raw.get("pmid") or raw.get("source_record_id")
        authors = raw.get("authors")
        sources.append(SourceRecord(
            id=row.id,
            old_record_id=row.record_id,
            norm_title=row.norm_title,
            norm_first_author=row.norm_first_author,
            match_year=row.match_year,
            match_doi=row.match_doi,
            pmid=str(pmid) if pmid else None,
            authors=authors if isinstance(authors, list) else None,
            raw_data=raw,
        ))
    return sources


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("", status_code=status.HTTP_201_CREATED, response_model=StrategyResponse)
async def create_strategy(
    project_id: uuid.UUID,
    body: StrategyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _require_project_access(project_id, current_user, db)

    if body.preset not in VALID_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid preset. Valid values: {sorted(VALID_PRESETS)}",
        )
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name must not be empty")

    try:
        strategy = await StrategyRepo.create(
            db,
            project_id,
            body.name.strip(),
            body.preset,
            config=body.config,
            selected_fields=body.selected_fields,
        )
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A strategy named '{body.name}' already exists for this project",
        )
    if body.activate:
        await StrategyRepo.set_active(db, project_id, strategy.id)
        await db.refresh(strategy)
    return _to_response(strategy)


@router.get("", response_model=list[StrategyResponse])
async def list_strategies(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _require_project_access(project_id, current_user, db)
    strategies = await StrategyRepo.list_by_project(db, project_id)
    return [_to_response(s) for s in strategies]


@router.get("/active", response_model=Optional[StrategyResponse])
async def get_active_strategy(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _require_project_access(project_id, current_user, db)
    strategy = await StrategyRepo.get_active(db, project_id)
    return _to_response(strategy) if strategy else None


@router.get("/preview")
async def preview_dedup(
    project_id: uuid.UUID,
    strategy_id: uuid.UUID = Query(..., description="ID of the strategy to preview"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Synchronously compute what a dedup run would do for this strategy, without
    writing any changes to the database.

    Returns the set of duplicate clusters that would be merged, plus summary
    statistics (would_merge, would_remain, tier breakdown).
    """
    await _require_project_access(project_id, current_user, db)

    strategy = await StrategyRepo.get_by_id(db, project_id, strategy_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")

    # Resolve StrategyConfig from JSONB or preset
    config_dict = strategy.config or {}
    config = StrategyConfig.from_dict(config_dict) if config_dict else StrategyConfig.from_preset(strategy.preset)

    # Fetch all record_sources for this project (read-only)
    rs_rows = (
        await db.execute(
            select(
                RecordSource.id,
                RecordSource.record_id,
                RecordSource.norm_title,
                RecordSource.norm_first_author,
                RecordSource.match_year,
                RecordSource.match_doi,
                RecordSource.raw_data,
            )
            .join(Record, Record.id == RecordSource.record_id)
            .where(Record.project_id == project_id)
        )
    ).all()

    sources = _build_sources_from_rows(rs_rows)

    builder = TieredClusterBuilder(config)
    preview = builder.preview(sources)

    return {
        "strategy_id": str(strategy.id),
        "strategy_name": strategy.name,
        "config": config.to_dict(),
        "would_merge": preview.would_merge,
        "would_remain": preview.would_remain,
        "isolated": len(preview.isolated),
        "tier1_count": preview.tier1_count,
        "tier2_count": preview.tier2_count,
        "tier3_count": preview.tier3_count,
        "clusters": [
            {
                "match_tier": c.match_tier,
                "match_basis": c.match_basis,
                "match_reason": c.match_reason,
                "similarity_score": c.similarity_score,
                "record_source_ids": [str(m.id) for m in c.members],
                "titles": [m.raw_data.get("title") for m in c.members],
                "dois": [m.match_doi for m in c.members],
            }
            for c in preview.clusters
        ],
    }


@router.patch("/{strategy_id}/activate", response_model=StrategyResponse)
async def activate_strategy(
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set this strategy as active and deactivate all others for the project."""
    await _require_project_access(project_id, current_user, db)
    strategy = await StrategyRepo.get_by_id(db, project_id, strategy_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    await StrategyRepo.set_active(db, project_id, strategy_id)
    await db.refresh(strategy)
    return _to_response(strategy)
