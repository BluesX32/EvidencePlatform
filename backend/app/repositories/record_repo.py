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
from app.utils.match_keys import compute_match_key, normalize_title, normalize_first_author


class RecordRepo:

    @staticmethod
    async def upsert_and_link(
        db: AsyncSession,
        parsed_records: list[dict],
        project_id: uuid.UUID,
        source_id: uuid.UUID,
        import_job_id: uuid.UUID,
        preset: str = "doi_first_strict",
    ) -> int:
        """
        Two-phase import:
          A. Upsert each parsed record into `records` (canonical store).
             - Records with a match_key: INSERT … ON CONFLICT (project_id, match_key) DO NOTHING,
               then SELECT id for both new and pre-existing rows.
             - Records without a match_key: always INSERT (no conflict possible; isolated).
          B. Insert a row into `record_sources` (join table) for every canonical record,
             including precomputed norm fields for future re-dedup.
             INSERT … ON CONFLICT (record_id, source_id) DO NOTHING — idempotent per source.

        Returns the count of new `record_sources` rows actually inserted,
        i.e. new source memberships added in this import.
        """
        # Pre-compute norm fields and match_key for every record
        enriched: list[dict] = []
        for r in parsed_records:
            norm_t = normalize_title(r.get("title"))
            norm_a = normalize_first_author(r.get("authors"))
            m_year = r.get("year")
            m_doi = r.get("doi")  # already lowercased by parser
            mk, basis = compute_match_key(norm_t, norm_a, m_year, m_doi, preset)
            enriched.append({
                **r,
                "norm_title": norm_t,
                "norm_first_author": norm_a,
                "match_year": m_year,
                "match_doi": m_doi,
                "match_key": mk,
                "match_basis": basis,
            })

        keyed_records = [(i, r) for i, r in enumerate(enriched) if r["match_key"] is not None]
        nokey_records = [(i, r) for i, r in enumerate(enriched) if r["match_key"] is None]

        record_ids: dict[int, uuid.UUID] = {}  # parsed-record index → canonical record.id

        # ── Phase A-1: Records with a match_key (batch upsert) ─────────────
        if keyed_records:
            values = [
                {
                    "project_id": project_id,
                    "normalized_doi": r.get("doi"),
                    "match_key": r["match_key"],
                    "match_basis": r["match_basis"],
                    "doi": r.get("doi"),
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
                for _, r in keyed_records
            ]
            stmt = pg_insert(Record).values(values).on_conflict_do_nothing(
                index_elements=["project_id", "match_key"],
                index_where=text("match_key IS NOT NULL"),
            )
            await db.execute(stmt)
            await db.flush()

            # Fetch ids for all match_keys (covers newly inserted and pre-existing).
            keys = [r["match_key"] for _, r in keyed_records]
            rows = await db.execute(
                select(Record.id, Record.match_key).where(
                    Record.project_id == project_id,
                    Record.match_key.in_(keys),
                )
            )
            key_to_id = {row.match_key: row.id for row in rows}
            for idx, rec in keyed_records:
                record_ids[idx] = key_to_id[rec["match_key"]]

        # ── Phase A-2: No-key records (individual inserts — never merged) ───
        for idx, rec in nokey_records:
            record = Record(
                project_id=project_id,
                normalized_doi=rec.get("doi"),
                match_key=None,
                match_basis="none",
                doi=rec.get("doi"),
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
                "raw_data": enriched[idx]["raw_data"],
                "norm_title": enriched[idx]["norm_title"],
                "norm_first_author": enriched[idx]["norm_first_author"],
                "match_year": enriched[idx]["match_year"],
                "match_doi": enriched[idx]["match_doi"],
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
                Record.match_basis,
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
                Record.doi, Record.match_basis, Record.created_at,
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
