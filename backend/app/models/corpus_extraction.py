"""SQLAlchemy model for corpus_extractions.

One extraction row per (corpus, canonical_key). UNIQUE constraint enforced
at DB level. Upserted on re-extraction. novelty_flag and novelty_notes are
top-level columns for efficient saturation queries; full payload is in
extracted_json.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CorpusExtraction(Base):
    __tablename__ = "corpus_extractions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    corpus_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("corpora.id", ondelete="CASCADE"),
        nullable=False,
    )
    canonical_key: Mapped[str] = mapped_column(String(100), nullable=False)
    # Full extraction payload (v0 schema: severity/framework/relationship/context)
    extracted_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    novelty_flag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    novelty_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    reviewer_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
