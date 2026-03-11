"""SQLAlchemy model for project_invitations (migration 018)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ProjectInvitation(Base):
    """Token-based invitation to join a project.

    Flow:
      1. Admin/owner POSTs to /projects/{id}/team/invite with email + role
      2. Server creates row with status=pending and a random token
      3. UI shows the token; invitee visits /accept-invite?token=<token>
      4. Server creates ProjectMember row, marks invitation accepted
    """

    __tablename__ = "project_invitations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    invited_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    email: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="reviewer")
    token: Mapped[str] = mapped_column(Text, nullable=False, index=True, unique=True)
    # pending | accepted | revoked
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)