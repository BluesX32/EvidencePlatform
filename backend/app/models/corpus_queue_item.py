"""SQLAlchemy model for corpus_queue_items.

Each row is one slot in the shuffled screening queue for a corpus.
canonical_key is either "pg:{cluster_id}" or "rec:{record_id}".

status tracks where in the workflow this item is:
  pending   — not yet reviewed in this corpus
  skipped   — reviewer explicitly skipped (not useful now)
  decided   — TA decision submitted (include/exclude/borderline)
  extracted — extraction completed (implies include)
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CorpusQueueItem(Base):
    __tablename__ = "corpus_queue_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    corpus_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("corpora.id", ondelete="CASCADE"),
        nullable=False,
    )
    # "pg:{uuid}" | "rec:{uuid}"
    canonical_key: Mapped[str] = mapped_column(String(100), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False)
    # "pending" | "skipped" | "decided" | "extracted"
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
