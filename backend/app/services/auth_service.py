from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.repositories.invite_code_repo import InviteCodeRepo
from app.repositories.user_repo import UserRepo

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
_ALGORITHM = "HS256"


class AuthService:
    @staticmethod
    def hash_password(password: str) -> str:
        return _pwd_context.hash(password)

    @staticmethod
    def verify_password(plain: str, hashed: str) -> bool:
        return _pwd_context.verify(plain, hashed)

    @staticmethod
    def create_access_token(user_id: str) -> str:
        expire = datetime.now(timezone.utc) + timedelta(hours=settings.access_token_expire_hours)
        payload = {"sub": user_id, "exp": expire}
        return jwt.encode(payload, settings.secret_key, algorithm=_ALGORITHM)

    @staticmethod
    async def verify_token(db: AsyncSession, token: str) -> Optional[User]:
        try:
            payload = jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])
            user_id: str = payload.get("sub")
            if user_id is None:
                return None
        except JWTError:
            return None
        return await UserRepo.get_by_id(db, user_id)

    @staticmethod
    async def register(
        db: AsyncSession,
        email: str,
        password: str,
        name: str,
        invite_code: Optional[str] = None,
    ) -> User:
        """Create a new user, optionally consuming an invite code.

        When settings.invite_required is True and no invite_code is supplied,
        raises ValueError("invite_required").

        When an invite_code is supplied it is validated and incremented
        atomically in the same transaction as the new user row — both changes
        land together or neither does.
        """
        invite_code_id: Optional[uuid.UUID] = None

        if settings.invite_required:
            if not invite_code:
                raise ValueError("invite_required")
            code_row = await InviteCodeRepo.acquire(db, invite_code)
            invite_code_id = code_row.id
        elif invite_code:
            # Invites not required but one was provided — validate and consume it anyway.
            code_row = await InviteCodeRepo.acquire(db, invite_code)
            invite_code_id = code_row.id

        password_hash = AuthService.hash_password(password)
        user = User(
            email=email,
            password_hash=password_hash,
            name=name,
            invite_code_id=invite_code_id,
        )
        db.add(user)
        # Single commit covers both the used_count increment and the new user row.
        await db.commit()
        await db.refresh(user)
        return user

    @staticmethod
    async def login(db: AsyncSession, email: str, password: str) -> Optional[User]:
        user = await UserRepo.get_by_email(db, email)
        if user is None or not AuthService.verify_password(password, user.password_hash):
            return None
        return user
