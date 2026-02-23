from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


class UserRepo:
    @staticmethod
    async def get_by_email(db: AsyncSession, email: str) -> Optional[User]:
        result = await db.execute(select(User).where(User.email == email))
        return result.scalar_one_or_none()

    @staticmethod
    async def get_by_id(db: AsyncSession, user_id) -> Optional[User]:
        result = await db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def create(db: AsyncSession, email: str, password_hash: str, name: str) -> User:
        user = User(email=email, password_hash=password_hash, name=name)
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user
