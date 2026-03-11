"""SQLAlchemy models for LLM screening infrastructure (migration 017).

Two tables:
  llm_screening_runs    — one row per batch screening run
  llm_screening_results — one row per record screened within a run
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class LlmScreeningRun(Base):
    """One LLM screening batch run for a project."""

    __tablename__ = "llm_screening_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # queued / running / completed / failed
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="queued"
    )
    model: Mapped[str] = mapped_column(String(80), nullable=False)
    total_records: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    processed_records: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    included_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    excluded_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    uncertain_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    new_concepts_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    input_tokens: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    output_tokens: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    estimated_cost_usd: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(10, 6), nullable=True
    )
    actual_cost_usd: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(10, 6), nullable=True
    )
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    triggered_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class LlmScreeningResult(Base):
    """One LLM screening result for a single record or cluster within a run."""

    __tablename__ = "llm_screening_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("llm_screening_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    record_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("records.id", ondelete="CASCADE"),
        nullable=True,
    )
    cluster_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("overlap_clusters.id", ondelete="CASCADE"),
        nullable=True,
    )
    # Decisions: include / exclude / uncertain
    ta_decision: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    ta_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ft_decision: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    ft_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Theme mapping
    matched_codes: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    new_concepts: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    # Provenance
    full_text_source: Mapped[Optional[str]] = mapped_column(
        String(30), nullable=True
    )  # uploaded_pdf / unpaywall / europe_pmc / pubmed_central / abstract_only
    input_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    # Human review
    reviewed_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_action: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )  # accepted / rejected / merged
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="ck_llm_results_item",
        ),
    )
