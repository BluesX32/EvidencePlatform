import uuid
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.record_source import RecordSource


class ProjectRepo:
    @staticmethod
    async def create(db: AsyncSession, name: str, description: Optional[str], user_id: uuid.UUID) -> Project:
        project = Project(name=name, description=description, created_by=user_id)
        db.add(project)
        await db.commit()
        await db.refresh(project)
        return project

    @staticmethod
    async def get_by_id(db: AsyncSession, project_id: uuid.UUID) -> Optional[Project]:
        result = await db.execute(select(Project).where(Project.id == project_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def list_by_user(db: AsyncSession, user_id: uuid.UUID) -> list[Project]:
        result = await db.execute(
            select(Project).where(Project.created_by == user_id).order_by(Project.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def count_records(db: AsyncSession, project_id: uuid.UUID) -> int:
        result = await db.execute(
            select(func.count()).where(RecordSource.project_id == project_id)
        )
        return result.scalar_one()
