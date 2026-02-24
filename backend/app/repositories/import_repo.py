import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.import_job import ImportJob


class ImportRepo:
    @staticmethod
    async def get_running(
        db: AsyncSession, project_id: uuid.UUID
    ) -> Optional[ImportJob]:
        """Return any import job in 'pending' or 'processing' state for this project."""
        result = await db.execute(
            select(ImportJob).where(
                ImportJob.project_id == project_id,
                ImportJob.status.in_(["pending", "processing"]),
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def create(
        db: AsyncSession,
        project_id: uuid.UUID,
        user_id: uuid.UUID,
        filename: str,
        file_format: str,
        source_id: Optional[uuid.UUID] = None,
    ) -> ImportJob:
        job = ImportJob(
            project_id=project_id,
            created_by=user_id,
            filename=filename,
            file_format=file_format,
            status="pending",
            source_id=source_id,
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job

    @staticmethod
    async def get_by_id(db: AsyncSession, job_id: uuid.UUID) -> Optional[ImportJob]:
        result = await db.execute(select(ImportJob).where(ImportJob.id == job_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def list_by_project(db: AsyncSession, project_id: uuid.UUID) -> list[ImportJob]:
        result = await db.execute(
            select(ImportJob)
            .where(ImportJob.project_id == project_id)
            .order_by(ImportJob.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def count_completed(db: AsyncSession, project_id: uuid.UUID) -> int:
        """Count import jobs with status 'completed' for a project."""
        from sqlalchemy import func
        result = await db.execute(
            select(func.count()).where(
                ImportJob.project_id == project_id,
                ImportJob.status == "completed",
            )
        )
        return result.scalar_one()

    @staticmethod
    async def set_processing(db: AsyncSession, job_id: uuid.UUID) -> None:
        job = await ImportRepo.get_by_id(db, job_id)
        if job:
            job.status = "processing"
            await db.commit()

    @staticmethod
    async def set_completed(db: AsyncSession, job_id: uuid.UUID, record_count: int) -> None:
        job = await ImportRepo.get_by_id(db, job_id)
        if job:
            job.status = "completed"
            job.record_count = record_count
            job.completed_at = datetime.now(timezone.utc)
            await db.commit()

    @staticmethod
    async def set_failed(db: AsyncSession, job_id: uuid.UUID, error_msg: str) -> None:
        job = await ImportRepo.get_by_id(db, job_id)
        if job:
            job.status = "failed"
            job.error_msg = error_msg
            job.completed_at = datetime.now(timezone.utc)
            await db.commit()
