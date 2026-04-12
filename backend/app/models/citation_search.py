"""SQLAlchemy model for citation_searches (migrations 028 + 029)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CitationSearch(Base):
    """Tracks a single citation snowballing run for a project."""

    __tablename__ = "citation_searches"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    triggered_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # pending | running | completed | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    # backward | forward | both
    direction: Mapped[str] = mapped_column(String(20), nullable=False, default="both")
    # all | new | custom  (which set of extracted papers was used)
    scope: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, default="all")
    candidate_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    already_in_project_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Number of extracted source papers used for this search
    source_record_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # JSON array of record UUID strings that were used as source papers
    source_record_ids: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    error_msg: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
