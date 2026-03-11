"""SQLAlchemy model for project_members (activated in migration 018)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ProjectMember(Base):
    """Reviewer membership for a project.

    Roles:
      admin    — can invite/remove, configure, adjudicate conflicts
      reviewer — can screen independently
      observer — read-only (cannot screen or configure)

    The project creator (created_by) is the implicit owner with full admin rights
    and is NOT stored here — the created_by FK on projects table is the source of truth.
    """

    __tablename__ = "project_members"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # admin | reviewer | observer
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="reviewer")
    # active | pending (pending = invited but not yet accepted)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    invited_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )