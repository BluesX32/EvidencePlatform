import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MatchLog(Base):
    __tablename__ = "match_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dedup_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dedup_jobs.id", ondelete="CASCADE"), nullable=False)
    record_src_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("record_sources.id"), nullable=False)
    old_record_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id", ondelete="SET NULL"), nullable=True)
    new_record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"), nullable=False)
    match_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    match_basis: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    # unchanged | merged | split | created
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
