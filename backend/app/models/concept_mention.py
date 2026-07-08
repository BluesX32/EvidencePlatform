"""SQLAlchemy model for concept_mentions (migration 050).

A concept_mention is one raw extracted value from a concept_extractions row,
promoted to a stable, first-class object: passage-grounded (source_quote,
locator), origin/AI-call/AI-job linked, and mappable onto a canonical
concept_taxonomy_node. concept_extractions.extracted_json remains the
form-shaped record the UI reads/writes; mentions are the provenance/discovery
layer synced from it (see app.services.concept_mention_service).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ConceptMention(Base):
    __tablename__ = "concept_mentions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    concept_extraction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("concept_extractions.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    field_id: Mapped[str] = mapped_column(Text, nullable=False)
    field_type: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    source_quote: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # {"page": int, "section": str, "char_start": int, "char_end": int}
    locator: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    # 'human' | 'ai'
    origin: Mapped[str] = mapped_column(String(12), nullable=False, server_default="human")
    reviewer_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    ai_job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_jobs.id", ondelete="SET NULL"), nullable=True
    )
    llm_call_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("llm_calls.id", ondelete="SET NULL"), nullable=True
    )
    canonical_node_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("concept_taxonomy_nodes.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # Frozen review-order position (from the reviewer's screening queue), when known.
    sequence_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Which screening_queue sequence_index is relative to (migration 051) — two
    # different corpus queues can independently produce the same position
    # number, so discovery analysis must never compare positions across queues.
    screening_queue_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("screening_queues.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("origin IN ('human', 'ai')", name="chk_cm_origin"),
    )
