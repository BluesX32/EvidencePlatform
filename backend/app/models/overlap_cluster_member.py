"""SQLAlchemy model for the overlap_cluster_members join table.

Each row links one record_source to an overlap_cluster, along with a role:
  canonical — the representative record kept for this cluster
  duplicate — a record merged/linked to the canonical
"""
import uuid
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class OverlapClusterMember(Base):
    __tablename__ = "overlap_cluster_members"

    __table_args__ = (
        UniqueConstraint(
            "cluster_id", "record_source_id", name="uq_ocm_cluster_record_source"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    cluster_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("overlap_clusters.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    record_source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("record_sources.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sources.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 'canonical' | 'duplicate'
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    # 'auto' = detector added | 'user' = manually added
    added_by: Mapped[str] = mapped_column(String(10), nullable=False, server_default="auto")
    # Optional note when user manually links records
    note: Mapped[Optional[str]] = mapped_column(Text(), nullable=True)
    created_at: Mapped[object] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    cluster: Mapped["OverlapCluster"] = relationship(
        "OverlapCluster", back_populates="members"
    )
