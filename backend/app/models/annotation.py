"""SQLAlchemy model for record_annotations (anchored comments, migration 012+020)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Annotation(Base):
    """Anchored text comment for a record or cluster, scoped to a project."""

    __tablename__ = "record_annotations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Exactly one of record_id / cluster_id must be non-null (enforced by CHECK constraint).
    record_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("records.id", ondelete="CASCADE"),
        nullable=True,
    )
    cluster_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("overlap_clusters.id", ondelete="CASCADE"),
        nullable=True,
    )
    selected_text: Mapped[str] = mapped_column(Text, nullable=False)
    comment: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    page_num: Mapped[Optional[int]] = mapped_column(Integer(), nullable=True)
    highlight_rects: Mapped[Optional[Any]] = mapped_column(JSONB(), nullable=True)
    reviewer_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_ann_exactly_one",
        ),
    )
