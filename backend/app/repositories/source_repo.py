import uuid
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.source import Source


class SourceRepo:
    @staticmethod
    async def create(db: AsyncSession, project_id: uuid.UUID, name: str) -> Source:
        source = Source(project_id=project_id, name=name)
        db.add(source)
        await db.commit()
        await db.refresh(source)
        return source

    @staticmethod
    async def list_by_project(db: AsyncSession, project_id: uuid.UUID) -> list[Source]:
        result = await db.execute(
            select(Source)
            .where(Source.project_id == project_id)
            .order_by(Source.created_at.asc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_by_id(
        db: AsyncSession, project_id: uuid.UUID, source_id: uuid.UUID
    ) -> Optional[Source]:
        result = await db.execute(
            select(Source).where(
                Source.id == source_id,
                Source.project_id == project_id,
            )
        )
        return result.scalar_one_or_none()
