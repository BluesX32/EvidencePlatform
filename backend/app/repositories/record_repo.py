"""
Record repository.

Two responsibilities:
  1. Upsert canonical records + insert join rows during import.
  2. Paginated listing for the API (query records, aggregate source names).
"""
import uuid
from typing import Optional

from sqlalchemy import func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source


class RecordRepo:

    @staticmethod
    async def upsert_and_link(
        db: AsyncSession,
        parsed_records: list[dict],
        project_id: uuid.UUID,
        source_id: uuid.UUID,
        import_job_id: uuid.UUID,
    ) -> int:
        """
        Two-phase import:
          A. Upsert each parsed record into `records` (canonical store).
             - DOI records: INSERT … ON CONFLICT (project_id, normalized_doi) DO NOTHING,
               then SELECT id for both new and pre-existing rows.
             - No-DOI records: always INSERT (no conflict possible; not deduplicated).
          B. Insert a row into `record_sources` (join table) for every canonical record.
             INSERT … ON CONFLICT (record_id, source_id) DO NOTHING — idempotent per source.

        Returns the count of new `record_sources` rows actually inserted,
        i.e. new source memberships added in this import.
        """
        doi_records = [(i, r) for i, r in enumerate(parsed_records) if r.get("doi")]
        nodoi_records = [(i, r) for i, r in enumerate(parsed_records) if not r.get("doi")]

        record_ids: dict[int, uuid.UUID] = {}  # parsed-record index → canonical record.id

        # ── Phase A-1: DOI records (batch upsert) ──────────────────────────
        if doi_records:
            values = [
                {
                    "project_id": project_id,
                    "normalized_doi": r["doi"],  # parser already lowercases/strips
                    "doi": r["doi"],
                    "title": r.get("title"),
                    "abstract": r.get("abstract"),
                    "authors": r.get("authors"),
                    "year": r.get("year"),
                    "journal": r.get("journal"),
                    "volume": r.get("volume"),
                    "issue": r.get("issue"),
                    "pages": r.get("pages"),
                    "issn": r.get("issn"),
                    "keywords": r.get("keywords"),
                    "source_format": r.get("source_format", "ris"),
                }
                for _, r in doi_records
            ]
            stmt = pg_insert(Record).values(values).on_conflict_do_nothing(
                index_elements=["project_id", "normalized_doi"],
                index_where=text("normalized_doi IS NOT NULL"),
            )
            await db.execute(stmt)
            await db.flush()

            # Fetch ids for all DOIs (covers both newly inserted and pre-existing).
            dois = [r["doi"] for _, r in doi_records]
            rows = await db.execute(
                select(Record.id, Record.normalized_doi).where(
                    Record.project_id == project_id,
                    Record.normalized_doi.in_(dois),
                )
            )
            doi_to_id = {row.normalized_doi: row.id for row in rows}
            for idx, rec in doi_records:
                record_ids[idx] = doi_to_id[rec["doi"]]

        # ── Phase A-2: No-DOI records (individual inserts) ─────────────────
        for idx, rec in nodoi_records:
            record = Record(
                project_id=project_id,
                normalized_doi=None,
                doi=None,
                title=rec.get("title"),
                abstract=rec.get("abstract"),
                authors=rec.get("authors"),
                year=rec.get("year"),
                journal=rec.get("journal"),
                volume=rec.get("volume"),
                issue=rec.get("issue"),
                pages=rec.get("pages"),
                issn=rec.get("issn"),
                keywords=rec.get("keywords"),
                source_format=rec.get("source_format", "ris"),
            )
            db.add(record)
            await db.flush()
            record_ids[idx] = record.id

        # ── Phase B: insert record_sources join rows ────────────────────────
        join_values = [
            {
                "record_id": record_ids[idx],
                "source_id": source_id,
                "import_job_id": import_job_id,
                "raw_data": parsed_records[idx]["raw_data"],
            }
            for idx in record_ids
        ]
        if not join_values:
            await db.commit()
            return 0

        join_stmt = pg_insert(RecordSource).values(join_values).on_conflict_do_nothing(
            index_elements=["record_id", "source_id"]
        )
        result = await db.execute(join_stmt)
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
        source_id: Optional[uuid.UUID] = None,
    ) -> tuple[list, int]:
        """
        Returns (rows, total) where each row has Record columns + aggregated `sources`.

        One row per canonical record — no duplicates regardless of how many sources
        have claimed it.  `sources` is a list of source names (may be empty).
        """
        base = (
            select(
                Record.id,
                Record.title,
                Record.authors,
                Record.year,
                Record.journal,
                Record.volume,
                Record.issue,
                Record.pages,
                Record.doi,
                Record.created_at,
                func.array_remove(
                    func.array_agg(func.distinct(Source.name)),
                    None,
                ).label("sources"),
            )
            .outerjoin(RecordSource, RecordSource.record_id == Record.id)
            .outerjoin(Source, Source.id == RecordSource.source_id)
            .where(Record.project_id == project_id)
            .group_by(
                Record.id, Record.title, Record.authors, Record.year,
                Record.journal, Record.volume, Record.issue, Record.pages,
                Record.doi, Record.created_at,
            )
        )

        if q:
            pattern = f"%{q}%"
            base = base.where(
                or_(
                    Record.title.ilike(pattern),
                    func.array_to_string(Record.authors, " ").ilike(pattern),
                )
            )

        if source_id:
            base = base.where(
                Record.id.in_(
                    select(RecordSource.record_id).where(RecordSource.source_id == source_id)
                )
            )

        sort_map = {
            "title_asc": Record.title.asc(),
            "title_desc": Record.title.desc(),
            "year_asc": Record.year.asc(),
            "year_desc": Record.year.desc(),
        }
        order = sort_map.get(sort, Record.year.desc())

        count_q = select(func.count()).select_from(base.subquery())
        total = (await db.execute(count_q)).scalar_one()

        rows_q = base.order_by(order).offset((page - 1) * per_page).limit(per_page)
        rows = list((await db.execute(rows_q)).all())

        return rows, total
