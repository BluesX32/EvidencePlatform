from __future__ import annotations
import uuid
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from app.database import Base


class ScreeningQueue(Base):
    __tablename__ = "screening_queues"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    reviewer_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source_id = Column(Text, nullable=False)   # "all" or UUID string
    stage = Column(String(20), nullable=False)
    seed = Column(Integer, nullable=False)
    slots = Column(JSONB, nullable=False)       # [{"type": "record"|"cluster", "id": "uuid-str"}]
    position = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("project_id", "reviewer_id", "source_id", "stage", name="uq_screening_queue"),
    )
