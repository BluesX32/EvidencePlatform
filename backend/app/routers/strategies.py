"""Match-strategy management endpoints.

POST /projects/{project_id}/strategies          — create a new named strategy
GET  /projects/{project_id}/strategies          — list all strategies
GET  /projects/{project_id}/strategies/active   — get the active strategy
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.strategy_repo import StrategyRepo, VALID_PRESETS

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
    preset: str
    activate: bool = False


class StrategyResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    preset: str
    preset_label: str
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
        strategy = await StrategyRepo.create(db, project_id, body.name.strip(), body.preset)
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
