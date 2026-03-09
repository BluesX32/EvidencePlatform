"""SQLAlchemy model for thematic_history (migration 015).

Immutable audit trail of every thematic analysis action:
code created, assigned to theme, moved between themes, renamed, etc.
Survives code deletion (code_id SET NULL on delete).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ThematicHistory(Base):
    __tablename__ = "thematic_history"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # SET NULL so the history entry survives code deletion
    code_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ontology_nodes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Snapshot of the code name at time of action (survives rename)
    code_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # create_code | create_theme | assign_theme | remove_theme | rename_code | rename_theme
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    old_theme_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    old_theme_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    new_theme_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    new_theme_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    changed_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )