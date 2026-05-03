from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ProjectSample(Base):
    """
    Records how a sub-project was created from a parent via random sampling.

    One row per child project (enforced by UNIQUE on child_project_id).
    sampled_record_ids stores {source_name: [parent_record_source_id, ...]}
    for full reproducibility — re-running with the same seed on the same
    parent will always yield the same sample.
    """

    __tablename__ = "project_samples"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parent_project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    child_project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    n_per_corpus: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # {source_name: [str(record_source_id), ...]}
    sampled_record_ids: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
