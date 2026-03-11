"""SQLAlchemy model for consensus_decisions (adjudication, migration 018)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ConsensusDecision(Base):
    """Adjudicated final decision when reviewers disagree.

    Written by an admin/owner after reviewing the conflict. Overrides individual
    screening_decisions for the purposes of the final synthesis.
    """

    __tablename__ = "consensus_decisions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    record_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("records.id", ondelete="CASCADE"), nullable=True
    )
    cluster_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("overlap_clusters.id", ondelete="CASCADE"), nullable=True
    )
    stage: Mapped[str] = mapped_column(String(10), nullable=False)       # TA | FT
    decision: Mapped[str] = mapped_column(String(20), nullable=False)    # include | exclude
    reason_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    adjudicator_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="ck_consensus_exactly_one",
        ),
    )