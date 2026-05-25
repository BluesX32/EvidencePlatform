from __future__ import annotations

import secrets
import string
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invite_code import InviteCode

_CODE_ALPHABET = string.ascii_uppercase + string.digits


def generate_invite_code() -> str:
    """Return a cryptographically random code in EVP-XXXX-XXXX format."""
    parts = ["".join(secrets.choice(_CODE_ALPHABET) for _ in range(4)) for _ in range(2)]
    return f"EVP-{'-'.join(parts)}"


class InviteCodeRepo:
    @staticmethod
    async def acquire(db: AsyncSession, code: str) -> InviteCode:
        """Validate and atomically increment used_count for *code*.

        Locks the row with SELECT FOR UPDATE so concurrent registrations with
        the same code cannot both succeed when max_uses == 1.

        Raises ValueError("invalid") when the code does not exist, is inactive,
        is expired, or has reached max_uses. The caller converts this to the
        generic HTTP 400 message so we never leak which condition failed.

        Does NOT commit. The caller must commit after creating the user so that
        both mutations land in the same transaction.
        """
        now = datetime.now(timezone.utc)
        result = await db.execute(
            select(InviteCode)
            .where(
                InviteCode.code == code.upper().strip(),
                InviteCode.is_active.is_(True),
                or_(InviteCode.expires_at.is_(None), InviteCode.expires_at > now),
                InviteCode.used_count < InviteCode.max_uses,
            )
            .with_for_update()
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise ValueError("invalid")
        row.used_count += 1
        db.add(row)
        return row

    # ── Admin helpers ─────────────────────────────────────────────────────────

    @staticmethod
    async def create(
        db: AsyncSession,
        *,
        label: Optional[str],
        max_uses: int,
        expires_at: Optional[datetime],
        created_by_user_id: Optional[uuid.UUID],
    ) -> InviteCode:
        row = InviteCode(
            id=uuid.uuid4(),
            code=generate_invite_code(),
            label=label,
            max_uses=max_uses,
            used_count=0,
            expires_at=expires_at,
            is_active=True,
            created_by_user_id=created_by_user_id,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row

    @staticmethod
    async def list_all(db: AsyncSession) -> list[InviteCode]:
        result = await db.execute(
            select(InviteCode).order_by(InviteCode.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def set_active(db: AsyncSession, code_id: uuid.UUID, active: bool) -> Optional[InviteCode]:
        result = await db.execute(select(InviteCode).where(InviteCode.id == code_id))
        row = result.scalar_one_or_none()
        if row is None:
            return None
        row.is_active = active
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row
