import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RecordSource(Base):
    __tablename__ = "record_sources"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    import_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("import_jobs.id"), nullable=False)
    title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    abstract: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    authors: Mapped[Optional[list]] = mapped_column(ARRAY(String), nullable=True)
    year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    journal: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    volume: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    issue: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pages: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    doi: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    issn: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    keywords: Mapped[Optional[list]] = mapped_column(ARRAY(String), nullable=True)
    source_format: Mapped[str] = mapped_column(String, nullable=False)
    # Original parsed fields verbatim — never mutated after insert.
    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("project_id", "doi", name="unique_doi_per_project"),
    )
