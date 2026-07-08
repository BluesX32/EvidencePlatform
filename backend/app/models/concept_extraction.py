from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ConceptExtraction(Base):
    __tablename__ = "concept_extractions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    record_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id", ondelete="CASCADE"), nullable=True)
    cluster_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("overlap_clusters.id", ondelete="CASCADE"), nullable=True)
    extracted_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    reviewer_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Structured provenance (migration 049): 'human' | 'ai'
    origin: Mapped[str] = mapped_column(String(12), nullable=False, server_default="human")
    # Migration 050: when a human edits an AI-authored row, the resulting human
    # row points here at the AI original instead of overwriting it in place.
    derived_from_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("concept_extractions.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR (record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_ce_exactly_one",
        ),
        UniqueConstraint(
            "project_id", "reviewer_id", "record_id", "cluster_id", "origin",
            name="uq_ce_reviewer_item_origin",
        ),
    )
