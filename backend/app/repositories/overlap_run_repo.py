"""
Repository for OverlapStrategyRun rows.

Each row represents one cross-source overlap detection run:
  create()        — called at the start (status=running)
  set_completed() — called on success with result counts
  set_failed()    — called on exception
  list_for_project() — paginated history (most recent first)
  get_by_id()        — full detail including params_snapshot
  get_last_for_strategy() — latest completed run for one strategy
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.overlap_strategy_run import OverlapStrategyRun


class OverlapRunRepo:

    @staticmethod
    async def create(
        db: AsyncSession,
        project_id: uuid.UUID,
        strategy_id: Optional[uuid.UUID],
        triggered_by: str,
        params_snapshot: Optional[dict],
    ) -> OverlapStrategyRun:
        run = OverlapStrategyRun(
            project_id=project_id,
            strategy_id=strategy_id,
            status="running",
            triggered_by=triggered_by,
            params_snapshot=params_snapshot,
        )
        db.add(run)
        await db.flush()
        return run

    @staticmethod
    async def set_completed(
        db: AsyncSession,
        run_id: uuid.UUID,
        within_source_groups: int,
        within_source_records: int,
        cross_source_groups: int,
        cross_source_records: int,
        sources_count: int,
    ) -> None:
        await db.execute(
            update(OverlapStrategyRun)
            .where(OverlapStrategyRun.id == run_id)
            .values(
                status="completed",
                finished_at=func.now(),
                within_source_groups=within_source_groups,
                within_source_records=within_source_records,
                cross_source_groups=cross_source_groups,
                cross_source_records=cross_source_records,
                sources_count=sources_count,
            )
        )

    @staticmethod
    async def set_failed(
        db: AsyncSession,
        run_id: uuid.UUID,
        error_message: str,
    ) -> None:
        await db.execute(
            update(OverlapStrategyRun)
            .where(OverlapStrategyRun.id == run_id)
            .values(
                status="failed",
                finished_at=func.now(),
                error_message=error_message[:500],
            )
        )

    @staticmethod
    async def list_for_project(
        db: AsyncSession,
        project_id: uuid.UUID,
        page: int = 1,
        page_size: int = 25,
    ) -> tuple:
        """Return (rows, total_count) ordered by started_at DESC."""
        total = (
            await db.execute(
                select(func.count(OverlapStrategyRun.id)).where(
                    OverlapStrategyRun.project_id == project_id
                )
            )
        ).scalar_one()

        rows = (
            await db.execute(
                select(OverlapStrategyRun)
                .where(OverlapStrategyRun.project_id == project_id)
                .order_by(OverlapStrategyRun.started_at.desc())
                .limit(page_size)
                .offset((page - 1) * page_size)
            )
        ).scalars().all()

        return list(rows), total

    @staticmethod
    async def get_by_id(
        db: AsyncSession,
        run_id: uuid.UUID,
    ) -> Optional[OverlapStrategyRun]:
        return await db.get(OverlapStrategyRun, run_id)

    @staticmethod
    async def get_last_for_strategy(
        db: AsyncSession,
        project_id: uuid.UUID,
        strategy_id: uuid.UUID,
    ) -> Optional[OverlapStrategyRun]:
        result = await db.execute(
            select(OverlapStrategyRun)
            .where(
                OverlapStrategyRun.project_id == project_id,
                OverlapStrategyRun.strategy_id == strategy_id,
                OverlapStrategyRun.status == "completed",
            )
            .order_by(OverlapStrategyRun.started_at.desc())
            .limit(1)
        )
        return result.scalars().first()
