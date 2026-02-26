"""SQLAlchemy model for the overlap_clusters table.

An OverlapCluster represents a group of record_sources that were detected as
duplicates or overlapping papers.  Two scopes are supported:

  within_source — records from the same source file that are duplicates of
                  each other (e.g. PubMed returned the same PMID twice).
  cross_source  — the same paper appears in records from multiple sources
                  (e.g. both PubMed and Scopus returned this article).

Each cluster is linked to the individual record_sources via
OverlapClusterMember rows.
"""
import uuid
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class OverlapCluster(Base):
    __tablename__ = "overlap_clusters"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # FK to the dedup_job that triggered this detection run (nullable)
    job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("dedup_jobs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 'within_source' | 'cross_source'
    scope: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # Which tier triggered the match (1=DOI/PMID, 2=title+year, 3=fuzzy)
    match_tier: Mapped[int] = mapped_column(Integer(), nullable=False)
    # Machine-readable basis (e.g. 'tier1_doi', 'tier2_title_year')
    match_basis: Mapped[str] = mapped_column(String(50), nullable=False)
    # Human-readable explanation
    match_reason: Mapped[Optional[str]] = mapped_column(Text(), nullable=True)
    # Fuzzy similarity score (null for exact matches)
    similarity_score: Mapped[Optional[float]] = mapped_column(Float(), nullable=True)
    # Extra structured details (matched DOI, matched title, etc.)
    reason_json: Mapped[Optional[dict]] = mapped_column(JSONB(), nullable=True)
    created_at: Mapped[object] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    members: Mapped[list] = relationship(
        "OverlapClusterMember", back_populates="cluster", cascade="all, delete-orphan"
    )
