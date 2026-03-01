import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class OverlapStrategyRun(Base):
    """One row per cross-source overlap detection run."""

    __tablename__ = "overlap_strategy_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    strategy_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("match_strategies.id", ondelete="SET NULL"),
        nullable=True,
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # running | completed | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="running")
    # manual | auto
    triggered_by: Mapped[str] = mapped_column(
        String(10), nullable=False, default="manual"
    )
    # Result counts (NULL until the run finishes)
    within_source_groups: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    within_source_records: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    cross_source_groups: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    cross_source_records: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    sources_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Exact config used at run time (so history is stable even if strategy changes later)
    params_snapshot: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
