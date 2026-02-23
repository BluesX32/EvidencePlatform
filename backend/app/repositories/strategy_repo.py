"""Repository for match_strategies CRUD."""
import uuid
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.match_strategy import MatchStrategy

VALID_PRESETS = frozenset(
    {"doi_first_strict", "doi_first_medium", "strict", "medium", "loose"}
)


class StrategyRepo:
    @staticmethod
    async def list_by_project(db: AsyncSession, project_id: uuid.UUID) -> list[MatchStrategy]:
        result = await db.execute(
            select(MatchStrategy)
            .where(MatchStrategy.project_id == project_id)
            .order_by(MatchStrategy.created_at.asc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_by_id(
        db: AsyncSession, project_id: uuid.UUID, strategy_id: uuid.UUID
    ) -> Optional[MatchStrategy]:
        result = await db.execute(
            select(MatchStrategy).where(
                MatchStrategy.id == strategy_id,
                MatchStrategy.project_id == project_id,
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def get_active(
        db: AsyncSession, project_id: uuid.UUID
    ) -> Optional[MatchStrategy]:
        result = await db.execute(
            select(MatchStrategy).where(
                MatchStrategy.project_id == project_id,
                MatchStrategy.is_active == True,  # noqa: E712
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def create(
        db: AsyncSession, project_id: uuid.UUID, name: str, preset: str
    ) -> MatchStrategy:
        strategy = MatchStrategy(
            project_id=project_id,
            name=name,
            preset=preset,
            is_active=False,
        )
        db.add(strategy)
        await db.commit()
        await db.refresh(strategy)
        return strategy

    @staticmethod
    async def set_active(
        db: AsyncSession, project_id: uuid.UUID, strategy_id: uuid.UUID
    ) -> None:
        """Mark strategy_id as active; deactivate all others for the project."""
        await db.execute(
            update(MatchStrategy)
            .where(MatchStrategy.project_id == project_id)
            .values(is_active=False)
        )
        await db.execute(
            update(MatchStrategy)
            .where(
                MatchStrategy.id == strategy_id,
                MatchStrategy.project_id == project_id,
            )
            .values(is_active=True)
        )
        await db.commit()
