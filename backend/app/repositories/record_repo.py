import uuid
from typing import Optional

from sqlalchemy import func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.record_source import RecordSource


class RecordRepo:
    @staticmethod
    async def bulk_insert_ignore_duplicates(
        db: AsyncSession, records: list[dict]
    ) -> int:
        """
        Insert records, skipping any that would violate the DOI uniqueness constraint.
        Returns the count of rows actually inserted.
        """
        if not records:
            return 0
        stmt = pg_insert(RecordSource).values(records)
        stmt = stmt.on_conflict_do_nothing(constraint="unique_doi_per_project")
        result = await db.execute(stmt)
        await db.commit()
        return result.rowcount

    @staticmethod
    async def list_paginated(
        db: AsyncSession,
        project_id: uuid.UUID,
        page: int,
        per_page: int,
        q: Optional[str],
        sort: str,
    ) -> tuple[list[RecordSource], int]:
        base = select(RecordSource).where(RecordSource.project_id == project_id)

        if q:
            pattern = f"%{q}%"
            base = base.where(
                or_(
                    RecordSource.title.ilike(pattern),
                    # Search authors array as text. Casting is safe for ILIKE on text representation.
                    func.array_to_string(RecordSource.authors, " ").ilike(pattern),
                )
            )

        sort_map = {
            "title_asc": RecordSource.title.asc(),
            "title_desc": RecordSource.title.desc(),
            "year_asc": RecordSource.year.asc(),
            "year_desc": RecordSource.year.desc(),
        }
        order = sort_map.get(sort, RecordSource.year.desc())

        count_q = select(func.count()).select_from(base.subquery())
        total = (await db.execute(count_q)).scalar_one()

        rows_q = base.order_by(order).offset((page - 1) * per_page).limit(per_page)
        rows = list((await db.execute(rows_q)).scalars().all())

        return rows, total
