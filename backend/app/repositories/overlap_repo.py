"""
Overlap repository.

Two queries:
  1. Per-source totals: total records claimed, records with a DOI.
  2. Pairwise overlap: count of canonical records shared by each pair of sources.

Overlap is computed over canonical record_id — correctness is guaranteed by
insert-time dedup (no DOI string matching at query time).
"""
import uuid
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.match_strategy import MatchStrategy
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source


class OverlapRepo:

    @staticmethod
    async def active_strategy_name(
        db: AsyncSession, project_id: uuid.UUID
    ) -> Optional[str]:
        """Return the name of the currently active match strategy, or None."""
        result = await db.execute(
            select(MatchStrategy.name).where(
                MatchStrategy.project_id == project_id,
                MatchStrategy.is_active == True,  # noqa: E712
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def source_totals(db: AsyncSession, project_id: uuid.UUID) -> list:
        """
        Returns one row per source with:
          id, name, total (records claimed), with_doi (records with a DOI)
        """
        stmt = (
            select(
                Source.id,
                Source.name,
                func.count(RecordSource.record_id).label("total"),
                func.count(Record.normalized_doi).label("with_doi"),
            )
            .outerjoin(RecordSource, RecordSource.source_id == Source.id)
            .outerjoin(Record, Record.id == RecordSource.record_id)
            .where(Source.project_id == project_id)
            .group_by(Source.id, Source.name)
            .order_by(Source.name)
        )
        result = await db.execute(stmt)
        return list(result.all())

    @staticmethod
    async def pairwise_overlap(db: AsyncSession, project_id: uuid.UUID) -> list:
        """
        Returns one row per ordered source pair (source_a < source_b) with:
          source_a_id, source_a_name, source_b_id, source_b_name, shared_records

        Self-join on record_id — no DOI matching at query time.
        """
        rs_a = RecordSource.__table__.alias("rs_a")
        rs_b = RecordSource.__table__.alias("rs_b")
        s_a = Source.__table__.alias("s_a")
        s_b = Source.__table__.alias("s_b")

        stmt = (
            select(
                rs_a.c.source_id.label("source_a_id"),
                s_a.c.name.label("source_a_name"),
                rs_b.c.source_id.label("source_b_id"),
                s_b.c.name.label("source_b_name"),
                func.count().label("shared_records"),
            )
            .select_from(rs_a)
            .join(rs_b, (rs_b.c.record_id == rs_a.c.record_id) & (rs_b.c.source_id > rs_a.c.source_id))
            .join(s_a, s_a.c.id == rs_a.c.source_id)
            .join(s_b, s_b.c.id == rs_b.c.source_id)
            .join(Record, (Record.id == rs_a.c.record_id) & (Record.project_id == project_id))
            .group_by(rs_a.c.source_id, s_a.c.name, rs_b.c.source_id, s_b.c.name)
            .order_by(func.count().desc())
        )
        result = await db.execute(stmt)
        return list(result.all())
