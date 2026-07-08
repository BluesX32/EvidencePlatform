"""SQLAlchemy model for ai_jobs (migration 048).

Persistent run history for AI Pilot batch jobs (bulk extraction, bulk
concept extraction). Replaces the old in-memory job tracker, so progress
and history survive server restarts and are visible to every worker.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from typing import Any, Dict

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AiJob(Base):
    __tablename__ = "ai_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # extract | concepts | resolve_conflicts | suggest_themes | draft_setup
    job_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # running / done / failed / stopped
    status: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default="running"
    )
    # Cooperative stop signal (migration 053): the running loop checks this
    # (via an in-memory mirror set for immediate effect — see app/routers/ai_pilot.py)
    # and breaks early, leaving remaining work for the next "start" call to pick up.
    stop_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    # Persisted output for one-shot jobs (suggest_themes, draft_setup) that
    # don't create their own rows elsewhere — keeps the result viewable
    # after the original request/response cycle ends.
    result_json: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    total: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    done: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    errors: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    triggered_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Heartbeat: bumped on every progress write. A "running" job whose
    # heartbeat is stale was interrupted (e.g. server restart).
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
