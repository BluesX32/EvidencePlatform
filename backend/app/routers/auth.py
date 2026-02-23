from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Annotated

from app.database import get_db
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Name cannot be empty")
        return v.strip()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RegisterResponse(BaseModel):
    user_id: str
    access_token: str
    token_type: str = "bearer"


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    try:
        user = await AuthService.register(db, email=body.email, password=body.password, name=body.name)
    except IntegrityError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    token = AuthService.create_access_token(str(user.id))
    return RegisterResponse(user_id=str(user.id), access_token=token)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await AuthService.login(db, email=body.email, password=body.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = AuthService.create_access_token(str(user.id))
    return TokenResponse(access_token=token)
