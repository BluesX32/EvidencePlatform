"""
Stub models for tables used in later slices and phases.

These exist in the schema from day one (per roadmap Phase 0 requirement —
schema decisions made now cannot be cheaply undone). They have no API surface
in Slice 1. They will be fleshed out when their phase begins.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base



class Protocol(Base):
    """PICO criteria, immutable versioned JSONB snapshots. Active in Phase 2."""
    __tablename__ = "protocols"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # Immutable snapshot of protocol fields at this version.
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class DedupPair(Base):
    """Deduplication decisions, every one logged with rationale. Active in Slice 2."""
    __tablename__ = "dedup_pairs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    source_a_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("record_sources.id"), nullable=False)
    source_b_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("record_sources.id"), nullable=False)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # 'duplicate' | 'not_duplicate' | 'pending'
    decision: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    # 'exact_doi' | 'fuzzy_title_author' | 'manual'
    method: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    decided_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


