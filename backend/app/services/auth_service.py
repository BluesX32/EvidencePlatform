from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
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
    async def register(db: AsyncSession, email: str, password: str, name: str) -> User:
        password_hash = AuthService.hash_password(password)
        return await UserRepo.create(db, email=email, password_hash=password_hash, name=name)

    @staticmethod
    async def login(db: AsyncSession, email: str, password: str) -> Optional[User]:
        user = await UserRepo.get_by_email(db, email)
        if user is None or not AuthService.verify_password(password, user.password_hash):
            return None
        return user
