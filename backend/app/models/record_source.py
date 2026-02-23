import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RecordSource(Base):
    """
    Join table: which bibliographic sources (databases) claim a canonical record.

    Each row represents one source database's assertion that it contains a record.
    UNIQUE(record_id, source_id) — re-importing the same DOI from the same source
    is idempotent (ON CONFLICT DO NOTHING).

    raw_data stores the original parsed fields from that source's file, including:
      - All rispy-parsed fields verbatim
      - "source_record_id": stable source-specific ID (PMID, EID, accession) or null

    Slice 3: precomputed norm fields (norm_title, norm_first_author, match_year,
    match_doi) stored at import time for re-matching without re-parsing raw_data.
    These columns are immutable after insert.
    """
    __tablename__ = "record_sources"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"), nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sources.id"), nullable=False)
    import_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("import_jobs.id"), nullable=False)
    # Original parsed fields verbatim — never mutated after insert.
    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # Precomputed normalized match fields (Slice 3) — set at import, never mutated.
    norm_title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    norm_first_author: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    match_year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    match_doi: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
