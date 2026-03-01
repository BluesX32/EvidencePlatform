"""SQLAlchemy model for the corpora table.

A Corpus is a named subset of project record-sources that a reviewer
screens in deterministic-random order.  Saturation state is tracked here.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Corpus(Base):
    __tablename__ = "corpora"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # List of source UUIDs in scope for this corpus
    source_ids: Mapped[list] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, default=list
    )
    saturation_threshold: Mapped[int] = mapped_column(
        Integer, nullable=False, default=10
    )
    # Rolling count of consecutive papers with novelty_flag=False
    consecutive_no_novelty: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    total_extracted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Set when consecutive_no_novelty >= saturation_threshold
    stopped_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Stored seed for deterministic queue reproducibility
    queue_seed: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    queue_generated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    queue_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
