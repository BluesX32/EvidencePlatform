import uuid
from typing import Annotated, FrozenSet

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.services.auth_service import AuthService

_bearer = HTTPBearer()

# ── Auth ──────────────────────────────────────────────────────────────────────

async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(_bearer)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Single auth enforcement point. Injected into every protected route."""
    user = await AuthService.verify_token(db, credentials.credentials)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    return user


# ── Project access helper ─────────────────────────────────────────────────────

# Role sets for convenience
ANY_ROLE: FrozenSet[str] = frozenset({"owner", "admin", "reviewer", "observer"})
REVIEWER_ROLE: FrozenSet[str] = frozenset({"owner", "admin", "reviewer"})
ADMIN_ROLE: FrozenSet[str] = frozenset({"owner", "admin"})


async def require_project_role(
    db: AsyncSession,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    allowed: FrozenSet[str] = ANY_ROLE,
) -> str:
    """Return the user's effective role, or raise 404/403.

    Replaces the old `if project.created_by != current_user.id: raise 403` pattern.
    Returns the role string ('owner', 'admin', 'reviewer', 'observer').
    """
    # Import here to avoid circular dependency at module load time
    from app.repositories.project_repo import ProjectRepo

    role = await ProjectRepo.user_role(db, project_id, user_id)
    if role is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if role not in allowed:
        raise HTTPException(status_code=403, detail="Access denied")
    return role