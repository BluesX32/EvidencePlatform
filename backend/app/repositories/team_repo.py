"""Repository for project membership and invitation operations."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_member import ProjectMember
from app.models.project_invitation import ProjectInvitation
from app.models.user import User

# Valid roles (ascending privilege)
ROLES = ("observer", "reviewer", "admin")
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}


class TeamRepo:
    # ── Membership ────────────────────────────────────────────────────────────

    @staticmethod
    async def get_member(
        db: AsyncSession, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> Optional[ProjectMember]:
        row = await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
                ProjectMember.status == "active",
            )
        )
        return row.scalar_one_or_none()

    @staticmethod
    async def list_members(db: AsyncSession, project_id: uuid.UUID) -> list[dict]:
        """Return members with basic user info."""
        rows = await db.execute(
            select(ProjectMember, User.email, User.name)
            .join(User, User.id == ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id, ProjectMember.status == "active")
            .order_by(ProjectMember.created_at)
        )
        result = []
        for member, email, name in rows:
            result.append({
                "id": str(member.id),
                "user_id": str(member.user_id),
                "email": email,
                "name": name,
                "role": member.role,
                "joined_at": member.created_at.isoformat(),
            })
        return result

    @staticmethod
    async def add_member(
        db: AsyncSession,
        project_id: uuid.UUID,
        user_id: uuid.UUID,
        role: str,
        invited_by: Optional[uuid.UUID] = None,
    ) -> ProjectMember:
        member = ProjectMember(
            project_id=project_id,
            user_id=user_id,
            role=role,
            status="active",
            invited_by=invited_by,
        )
        db.add(member)
        await db.flush()
        await db.refresh(member)
        return member

    @staticmethod
    async def update_member_role(
        db: AsyncSession, project_id: uuid.UUID, user_id: uuid.UUID, new_role: str
    ) -> Optional[ProjectMember]:
        await db.execute(
            update(ProjectMember)
            .where(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id)
            .values(role=new_role)
        )
        await db.flush()
        return await TeamRepo.get_member(db, project_id, user_id)

    @staticmethod
    async def remove_member(
        db: AsyncSession, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> None:
        await db.execute(
            delete(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
        await db.flush()

    @staticmethod
    async def list_project_ids_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Return project_ids where user is an active member (not owner)."""
        rows = await db.execute(
            select(ProjectMember.project_id).where(
                ProjectMember.user_id == user_id,
                ProjectMember.status == "active",
            )
        )
        return list(rows.scalars().all())

    # ── Invitations ───────────────────────────────────────────────────────────

    @staticmethod
    async def create_invitation(
        db: AsyncSession,
        project_id: uuid.UUID,
        email: str,
        role: str,
        invited_by: uuid.UUID,
    ) -> ProjectInvitation:
        token = str(uuid.uuid4())
        inv = ProjectInvitation(
            project_id=project_id,
            invited_by=invited_by,
            email=email.lower().strip(),
            role=role,
            token=token,
            status="pending",
        )
        db.add(inv)
        await db.flush()
        await db.refresh(inv)
        return inv

    @staticmethod
    async def get_invitation_by_token(
        db: AsyncSession, token: str
    ) -> Optional[ProjectInvitation]:
        row = await db.execute(
            select(ProjectInvitation).where(ProjectInvitation.token == token)
        )
        return row.scalar_one_or_none()

    @staticmethod
    async def list_invitations(
        db: AsyncSession, project_id: uuid.UUID
    ) -> list[ProjectInvitation]:
        rows = await db.execute(
            select(ProjectInvitation)
            .where(ProjectInvitation.project_id == project_id)
            .order_by(ProjectInvitation.created_at.desc())
        )
        return list(rows.scalars().all())

    @staticmethod
    async def accept_invitation(
        db: AsyncSession, invitation: ProjectInvitation, user_id: uuid.UUID
    ) -> ProjectMember:
        invitation.status = "accepted"
        invitation.accepted_at = datetime.now(timezone.utc)
        await db.flush()
        # Create or update member row
        existing = await TeamRepo.get_member(db, invitation.project_id, user_id)
        if existing:
            existing.role = invitation.role
            await db.flush()
            return existing
        return await TeamRepo.add_member(
            db,
            project_id=invitation.project_id,
            user_id=user_id,
            role=invitation.role,
            invited_by=invitation.invited_by,
        )

    @staticmethod
    async def revoke_invitation(
        db: AsyncSession, invitation: ProjectInvitation
    ) -> None:
        invitation.status = "revoked"
        await db.flush()