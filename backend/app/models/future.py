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


class ProjectMember(Base):
    """Reviewer roles per project. Active in Phase 2."""
    __tablename__ = "project_members"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    # 'admin' | 'reviewer' | 'observer'
    role: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


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


class Record(Base):
    """Canonical deduplicated records derived from record_sources. Active in Slice 2."""
    __tablename__ = "records"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    # The record_source chosen as canonical representative after dedup.
    primary_source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("record_sources.id"), nullable=False)
    # Extensible metadata for fields not in the fixed schema.
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, default=dict)
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


class ScreeningDecision(Base):
    """Per-reviewer per-record decisions. Record status is derived, never set directly. Active in Phase 2."""
    __tablename__ = "screening_decisions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"), nullable=False)
    reviewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    # 'title_abstract' | 'full_text'
    round: Mapped[str] = mapped_column(String, nullable=False)
    # 'include' | 'exclude' | 'uncertain'
    decision: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ExtractionForm(Base):
    """Form definition version-locked to a protocol. Active in Phase 3."""
    __tablename__ = "extraction_forms"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    protocol_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("protocols.id"), nullable=False)
    # Form schema as JSONB. Fixed schema in Phase 3; custom builder in Phase 6.
    schema: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ExtractedData(Base):
    """Append-only extraction records. Current value is the latest row. Active in Phase 3."""
    __tablename__ = "extracted_data"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"), nullable=False)
    extraction_form_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("extraction_forms.id"), nullable=False)
    reviewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    # Structured extracted values keyed by field name.
    values: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
