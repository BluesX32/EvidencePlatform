"""SQLAlchemy model for citation_candidates (migration 028)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CitationCandidate(Base):
    """A single paper discovered via backward or forward citation sourcing."""

    __tablename__ = "citation_candidates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    search_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("citation_searches.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # backward | forward
    direction: Mapped[str] = mapped_column(String(20), nullable=False)
    # Which extracted paper's reference/citation list surfaced this candidate
    source_record_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("records.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Semantic Scholar paper ID — last-resort dedup key
    s2_paper_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    abstract: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    authors: Mapped[Optional[list]] = mapped_column(ARRAY(Text), nullable=True)
    year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    doi: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    pmid: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    journal: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # True when the candidate already exists in the project (auto-detected)
    in_project: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # FK to the matching record when in_project=True
    project_record_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("records.id", ondelete="SET NULL"),
        nullable=True,
    )
    # NULL | include | exclude | already_screened
    decision: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    decided_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    decided_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Set after successful import of this candidate
    import_job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("import_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
