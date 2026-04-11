import logging
import os

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Annotated, Optional

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


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


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("New password must be at least 8 characters")
        return v


class UpdateProfileRequest(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Name cannot be empty")
        return v.strip()


class UpdateApiKeysRequest(BaseModel):
    anthropic: Optional[str] = None   # None = no change; "" = clear; value = set
    openrouter: Optional[str] = None


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    try:
        user = await AuthService.register(db, email=body.email, password=body.password, name=body.name)
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )
    except Exception:
        logger.exception("Unexpected error during registration for email=%s", body.email)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Registration failed unexpectedly — please try again",
        )
    token = AuthService.create_access_token(str(user.id))
    return RegisterResponse(user_id=str(user.id), access_token=token)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await AuthService.login(db, email=body.email, password=body.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = AuthService.create_access_token(str(user.id))
    return TokenResponse(access_token=token)


def _api_key_hint(key: Optional[str]) -> Optional[str]:
    """Return the first 8 characters of a key for display, or None if unset."""
    if not key:
        return None
    return key[:8] + "…"


def _user_response(user: User) -> dict:
    keys = user.api_keys or {}
    return {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "anthropic_key_hint": _api_key_hint(keys.get("anthropic")),
        "openrouter_key_hint": _api_key_hint(keys.get("openrouter")),
        "onedrive_connected": bool(keys.get("onedrive_access") or keys.get("onedrive_refresh")),
    }


@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    """Return the authenticated user's profile."""
    return _user_response(current_user)


@router.patch("/me")
async def update_profile(
    body: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the authenticated user's display name."""
    current_user.name = body.name
    db.add(current_user)
    await db.commit()
    return _user_response(current_user)


@router.patch("/me/api-keys", status_code=200)
async def update_api_keys(
    body: UpdateApiKeysRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Save or clear LLM API keys on the user's profile.

    Pass an empty string to clear a key. Pass None to leave it unchanged.
    Keys are stored in plaintext in the users.api_keys JSONB column.
    """
    keys: dict = dict(current_user.api_keys or {})
    if body.anthropic is not None:
        if body.anthropic.strip():
            keys["anthropic"] = body.anthropic.strip()
        else:
            keys.pop("anthropic", None)
    if body.openrouter is not None:
        if body.openrouter.strip():
            keys["openrouter"] = body.openrouter.strip()
        else:
            keys.pop("openrouter", None)
    current_user.api_keys = keys
    db.add(current_user)
    await db.commit()
    return _user_response(current_user)


@router.patch("/me/password", status_code=204)
async def change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change the authenticated user's password."""
    if not AuthService.verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.password_hash = AuthService.hash_password(body.new_password)
    db.add(current_user)
    await db.commit()


# ---------------------------------------------------------------------------
# OneDrive OAuth
# ---------------------------------------------------------------------------

_ONEDRIVE_SCOPES = "files.read offline_access"


@router.get("/onedrive/connect-url")
async def onedrive_connect_url(
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return the Microsoft OAuth2 authorization URL the frontend should open.

    Requires MICROSOFT_CLIENT_ID and ONEDRIVE_REDIRECT_URI env vars.
    """
    client_id = os.environ.get("MICROSOFT_CLIENT_ID", "")
    redirect_uri = os.environ.get("ONEDRIVE_REDIRECT_URI", "")
    if not client_id or not redirect_uri:
        raise HTTPException(503, "OneDrive integration is not configured on this server")
    import urllib.parse
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": _ONEDRIVE_SCOPES,
        "response_mode": "query",
        "state": str(current_user.id),
    }
    url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + urllib.parse.urlencode(params)
    return {"url": url}


class OneDriveExchangeRequest(BaseModel):
    code: str


@router.post("/onedrive/exchange")
async def onedrive_exchange(
    body: OneDriveExchangeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Exchange an OAuth2 authorization code for OneDrive access + refresh tokens.

    Stores both tokens in user.api_keys and returns the updated profile.
    """
    client_id = os.environ.get("MICROSOFT_CLIENT_ID", "")
    client_secret = os.environ.get("MICROSOFT_CLIENT_SECRET", "")
    redirect_uri = os.environ.get("ONEDRIVE_REDIRECT_URI", "")
    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(503, "OneDrive integration is not configured on this server")

    import httpx
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": body.code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "scope": _ONEDRIVE_SCOPES,
            },
        )
    if resp.status_code != 200:
        logger.warning("OneDrive code exchange failed: %s %s", resp.status_code, resp.text[:200])
        raise HTTPException(400, "OneDrive authorization failed — please try connecting again")

    data = resp.json()
    access_token = data.get("access_token")
    refresh_token = data.get("refresh_token")
    if not access_token:
        raise HTTPException(400, "OneDrive did not return an access token")

    keys: dict = dict(current_user.api_keys or {})
    keys["onedrive_access"] = access_token
    if refresh_token:
        keys["onedrive_refresh"] = refresh_token
    current_user.api_keys = keys
    db.add(current_user)
    await db.commit()
    return _user_response(current_user)


@router.delete("/onedrive/disconnect", status_code=204)
async def onedrive_disconnect(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove stored OneDrive tokens from the user's profile."""
    keys: dict = dict(current_user.api_keys or {})
    keys.pop("onedrive_access", None)
    keys.pop("onedrive_refresh", None)
    current_user.api_keys = keys
    db.add(current_user)
    await db.commit()
