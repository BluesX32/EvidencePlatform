"""Repository for dedup_jobs CRUD."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dedup_job import DedupJob
from app.models.match_strategy import MatchStrategy


class DedupJobRepo:
    @staticmethod
    async def create(
        db: AsyncSession,
        project_id: uuid.UUID,
        strategy_id: uuid.UUID,
        created_by: uuid.UUID,
    ) -> DedupJob:
        job = DedupJob(
            project_id=project_id,
            strategy_id=strategy_id,
            created_by=created_by,
            status="pending",
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job

    @staticmethod
    async def get_by_id(
        db: AsyncSession, project_id: uuid.UUID, job_id: uuid.UUID
    ) -> Optional[DedupJob]:
        result = await db.execute(
            select(DedupJob).where(
                DedupJob.id == job_id,
                DedupJob.project_id == project_id,
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def list_by_project(
        db: AsyncSession, project_id: uuid.UUID
    ) -> list[DedupJob]:
        result = await db.execute(
            select(DedupJob)
            .where(DedupJob.project_id == project_id)
            .order_by(DedupJob.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_running(
        db: AsyncSession, project_id: uuid.UUID
    ) -> Optional[DedupJob]:
        """Return any job in 'pending' or 'running' state for this project."""
        result = await db.execute(
            select(DedupJob).where(
                DedupJob.project_id == project_id,
                DedupJob.status.in_(["pending", "running"]),
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def set_running(db: AsyncSession, job_id: uuid.UUID) -> None:
        await db.execute(
            update(DedupJob)
            .where(DedupJob.id == job_id)
            .values(status="running")
        )
        await db.commit()

    @staticmethod
    async def set_completed(
        db: AsyncSession,
        job_id: uuid.UUID,
        records_before: int,
        records_after: int,
        merges: int,
        clusters_created: int,
        clusters_deleted: int,
    ) -> None:
        await db.execute(
            update(DedupJob)
            .where(DedupJob.id == job_id)
            .values(
                status="completed",
                records_before=records_before,
                records_after=records_after,
                merges=merges,
                clusters_created=clusters_created,
                clusters_deleted=clusters_deleted,
                completed_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()

    @staticmethod
    async def set_failed(
        db: AsyncSession, job_id: uuid.UUID, error_msg: str
    ) -> None:
        await db.execute(
            update(DedupJob)
            .where(DedupJob.id == job_id)
            .values(
                status="failed",
                error_msg=error_msg,
                completed_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()
