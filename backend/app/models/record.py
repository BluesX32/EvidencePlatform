import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Record(Base):
    """
    Canonical deduplicated record.  One row per unique article per project.

    Dedup key (Slice 3+): (project_id, match_key) — partial unique index, NULL excluded.
    match_key is strategy-agnostic (e.g. "doi:10.1234/...", "tay:title|author|year").
    normalized_doi is kept for backwards compat and auditing.
    Source membership is tracked in record_sources (join table).
    """
    __tablename__ = "records"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    # Legacy dedup key (Slice 2); kept for auditing. Not used for conflict detection in Slice 3+.
    normalized_doi: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Slice 3 dedup key — strategy-agnostic. NULL = record stays isolated.
    match_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Which fields were used to form match_key: 'doi' | 'title_author_year' | 'title_year' | 'title_author' | 'none'
    match_basis: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    abstract: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    authors: Mapped[Optional[list]] = mapped_column(ARRAY(Text), nullable=True)
    year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    journal: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    volume: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    issue: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pages: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    doi: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    issn: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    keywords: Mapped[Optional[list]] = mapped_column(ARRAY(Text), nullable=True)
    source_format: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
