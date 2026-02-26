"""Repository for match_strategies CRUD.

Strategies can be created from:
  - A named preset (doi_first_strict, doi_first_medium, strict, medium, loose)
    The preset's StrategyConfig is serialised to the config JSONB column.
  - A custom config dict (preset='custom')
    Used by the field-chip builder UI when users configure rules manually.
"""
import uuid
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.match_strategy import MatchStrategy
from app.utils.match_keys import StrategyConfig

VALID_PRESETS = frozenset(
    {"doi_first_strict", "doi_first_medium", "strict", "medium", "loose", "custom"}
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
        db: AsyncSession,
        project_id: uuid.UUID,
        name: str,
        preset: str,
        config: Optional[dict] = None,
        selected_fields: Optional[list] = None,
    ) -> MatchStrategy:
        """
        Create a new match strategy.

        If `config` is provided (custom field-chip builder strategy), it is stored
        directly in the config JSONB.  Otherwise, the config is derived from the
        preset name using StrategyConfig.from_preset().

        For custom strategies, use preset='custom'.
        """
        if config is not None:
            resolved_config = config
        else:
            resolved_config = StrategyConfig.from_preset(preset).to_dict()

        strategy = MatchStrategy(
            project_id=project_id,
            name=name,
            preset=preset,
            config=resolved_config,
            selected_fields=selected_fields,
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
