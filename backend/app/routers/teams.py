"""Team collaboration endpoints.

All endpoints are scoped under /projects/{project_id}/team.

GET  /members             — list team members (any member or owner)
POST /invite              — invite by email (admin/owner)
GET  /invitations         — list pending invitations (admin/owner)
DELETE /invitations/{inv_id} — revoke invitation (admin/owner)
PATCH /members/{user_id}  — change member role (admin/owner)
DELETE /members/{user_id} — remove member (admin/owner, or self-removal)
POST /accept              — accept an invitation (any authenticated user)
GET  /me                  — return current user's role in this project
"""
from __future__ import annotations

import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.team_repo import TeamRepo, ROLES
from app.repositories.user_repo import UserRepo

router = APIRouter(prefix="/projects/{project_id}/team", tags=["team"])

# ── Helpers ──────────────────────────────────────────────────────────────────

async def _get_project_or_404(db, project_id):
    p = await ProjectRepo.get_by_id(db, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return p


async def _require_admin(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    """Caller must be owner OR an active admin member."""
    project = await _get_project_or_404(db, project_id)
    if project.created_by == current_user.id:
        return project
    member = await TeamRepo.get_member(db, project_id, current_user.id)
    if member is None or member.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return project


async def _require_any_access(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    """Caller must be owner OR any active member."""
    project = await _get_project_or_404(db, project_id)
    if project.created_by == current_user.id:
        return project
    member = await TeamRepo.get_member(db, project_id, current_user.id)
    if member is None:
        raise HTTPException(status_code=403, detail="Not a project member")
    return project


# ── Schemas ───────────────────────────────────────────────────────────────────

class InviteRequest(BaseModel):
    email: str
    role: str = "reviewer"


class UpdateRoleRequest(BaseModel):
    role: str


class AcceptInviteRequest(BaseModel):
    token: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/me")
async def get_my_role(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Return current user's role in this project."""
    project = await _get_project_or_404(db, project_id)
    if project.created_by == current_user.id:
        return {"role": "owner", "is_owner": True, "user_id": str(current_user.id)}
    member = await TeamRepo.get_member(db, project_id, current_user.id)
    if member is None:
        raise HTTPException(status_code=403, detail="Not a project member")
    return {"role": member.role, "is_owner": False, "user_id": str(current_user.id)}


@router.get("/members")
async def list_members(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """List all active team members (any member can view)."""
    project = await _require_any_access(project_id, current_user, db)
    members = await TeamRepo.list_members(db, project_id)
    # Prepend the owner
    owner = await UserRepo.get_by_id(db, project.created_by)
    result = [{
        "user_id": str(project.created_by),
        "email": owner.email if owner else "",
        "name": owner.name if owner else "",
        "role": "owner",
        "joined_at": project.created_at.isoformat(),
        "is_owner": True,
    }]
    for m in members:
        result.append({**m, "is_owner": False})
    return result


@router.post("/invite", status_code=status.HTTP_201_CREATED)
async def invite_member(
    project_id: uuid.UUID,
    body: InviteRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Create a pending invitation. Returns the token to share with the invitee."""
    await _require_admin(project_id, current_user, db)

    if body.role not in ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {ROLES}")

    # Check for existing active member with same email
    invitee = await UserRepo.get_by_email(db, body.email.lower().strip())
    if invitee:
        existing = await TeamRepo.get_member(db, project_id, invitee.id)
        if existing:
            raise HTTPException(status_code=409, detail="User is already a member")

    invitation = await TeamRepo.create_invitation(
        db,
        project_id=project_id,
        email=body.email,
        role=body.role,
        invited_by=current_user.id,
    )
    await db.commit()
    return {
        "id": str(invitation.id),
        "email": invitation.email,
        "role": invitation.role,
        "token": invitation.token,
        "status": invitation.status,
        "created_at": invitation.created_at.isoformat(),
    }


@router.get("/invitations")
async def list_invitations(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """List invitations for this project (admin/owner only)."""
    await _require_admin(project_id, current_user, db)
    invitations = await TeamRepo.list_invitations(db, project_id)
    return [
        {
            "id": str(i.id),
            "email": i.email,
            "role": i.role,
            "token": i.token,
            "status": i.status,
            "created_at": i.created_at.isoformat(),
            "accepted_at": i.accepted_at.isoformat() if i.accepted_at else None,
        }
        for i in invitations
    ]


@router.delete("/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(
    project_id: uuid.UUID,
    invitation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Revoke a pending invitation."""
    await _require_admin(project_id, current_user, db)
    invitations = await TeamRepo.list_invitations(db, project_id)
    inv = next((i for i in invitations if i.id == invitation_id), None)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.status != "pending":
        raise HTTPException(status_code=409, detail="Invitation is not pending")
    await TeamRepo.revoke_invitation(db, inv)
    await db.commit()


@router.post("/accept", status_code=status.HTTP_200_OK)
async def accept_invitation(
    body: AcceptInviteRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Accept an invitation by token. The project_id in the URL is ignored here —
    we look up the project from the token itself."""
    invitation = await TeamRepo.get_invitation_by_token(db, body.token)
    if invitation is None or invitation.status != "pending":
        raise HTTPException(status_code=404, detail="Invalid or already used invitation token")

    member = await TeamRepo.accept_invitation(db, invitation, current_user.id)
    await db.commit()
    return {
        "project_id": str(invitation.project_id),
        "user_id": str(member.user_id),
        "role": member.role,
        "message": "Invitation accepted",
    }


@router.patch("/members/{target_user_id}")
async def update_member_role(
    project_id: uuid.UUID,
    target_user_id: uuid.UUID,
    body: UpdateRoleRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Change a member's role (admin/owner only)."""
    project = await _require_admin(project_id, current_user, db)

    if target_user_id == project.created_by:
        raise HTTPException(status_code=409, detail="Cannot change the owner's role")
    if body.role not in ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {ROLES}")

    member = await TeamRepo.update_member_role(db, project_id, target_user_id, body.role)
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    await db.commit()
    return {"user_id": str(member.user_id), "role": member.role}


@router.delete("/members/{target_user_id}", status_code=204)
async def remove_member(
    project_id: uuid.UUID,
    target_user_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Remove a member. Admins/owners can remove anyone; reviewers can remove themselves."""
    project = await _get_project_or_404(db, project_id)
    is_owner = project.created_by == current_user.id
    current_member = await TeamRepo.get_member(db, project_id, current_user.id)
    is_admin = current_member and current_member.role == "admin"
    is_self = target_user_id == current_user.id

    if not (is_owner or is_admin or is_self):
        raise HTTPException(status_code=403, detail="Not allowed to remove this member")
    if target_user_id == project.created_by:
        raise HTTPException(status_code=409, detail="Cannot remove the project owner")

    await TeamRepo.remove_member(db, project_id, target_user_id)
    await db.commit()