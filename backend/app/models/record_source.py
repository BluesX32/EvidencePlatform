import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, func
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
    """
    __tablename__ = "record_sources"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"), nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sources.id"), nullable=False)
    import_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("import_jobs.id"), nullable=False)
    # Original parsed fields verbatim — never mutated after insert.
    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
