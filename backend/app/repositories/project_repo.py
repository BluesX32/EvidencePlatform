import uuid
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.record import Record


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
    async def user_role(db: AsyncSession, project_id: uuid.UUID, user_id: uuid.UUID) -> Optional[str]:
        """Return the effective role of user_id for project_id, or None if no access.

        Returns 'owner' for the project creator, the member role for active members,
        or None if the user has no access.
        """
        project = await ProjectRepo.get_by_id(db, project_id)
        if project is None:
            return None
        if project.created_by == user_id:
            return "owner"
        row = await db.execute(
            select(ProjectMember.role).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
                ProjectMember.status == "active",
            )
        )
        return row.scalar_one_or_none()

    @staticmethod
    async def list_by_user(db: AsyncSession, user_id: uuid.UUID) -> list[Project]:
        """Return all projects accessible to user_id (owned or active member)."""
        owned = select(Project.id).where(Project.created_by == user_id)
        member_of = select(ProjectMember.project_id).where(
            ProjectMember.user_id == user_id,
            ProjectMember.status == "active",
        )
        result = await db.execute(
            select(Project)
            .where(or_(Project.id.in_(owned), Project.id.in_(member_of)))
            .order_by(Project.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def count_records(db: AsyncSession, project_id: uuid.UUID) -> int:
        """Count canonical records (unique deduplicated records) for a project."""
        result = await db.execute(
            select(func.count()).where(Record.project_id == project_id)
        )
        return result.scalar_one()

    @staticmethod
    async def update_criteria(
        db: AsyncSession,
        project_id: uuid.UUID,
        criteria: dict,
    ) -> Optional[Project]:
        project = await ProjectRepo.get_by_id(db, project_id)
        if project is None:
            return None
        project.criteria = criteria
        await db.flush()
        await db.refresh(project)
        return project