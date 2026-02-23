"""Dedup service: re-clusters record_sources under a new match strategy.

Runs as a FastAPI background task. The router creates the dedup_job row and
returns 202 immediately; this service does the actual work.

Algorithm
---------
For each record_source in the project:
  1. Compute (match_key, match_basis) from precomputed norm fields + strategy preset.
  2. Group sources by match_key.
  3. For each cluster:
       a. Find or create a canonical records row with that match_key.
       b. Re-point record_sources.record_id to the cluster's canonical record.
  4. Delete orphaned records rows (no record_sources left).
  5. Log every move to match_log.
  6. Update dedup_jobs statistics and status.

Advisory lock ensures only one mutation job (import or dedup) runs per project.
"""
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal, engine
from app.models.dedup_job import DedupJob
from app.models.match_log import MatchLog
from app.models.match_strategy import MatchStrategy
from app.models.record import Record
from app.models.record_source import RecordSource
from app.repositories.dedup_repo import DedupJobRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.locks import try_acquire_project_lock, release_project_lock
from app.utils.match_keys import compute_match_key


async def run_dedup(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    """Background task entry point."""
    async with engine.connect() as lock_conn:
        acquired = await try_acquire_project_lock(lock_conn, project_id)
        if not acquired:
            # Mark job failed — another job is running
            async with SessionLocal() as db:
                await DedupJobRepo.set_failed(
                    db, job_id, "Could not acquire project lock: another job is running"
                )
            return

        try:
            await _do_dedup(job_id, project_id, strategy_id)
        finally:
            await release_project_lock(lock_conn, project_id)


async def _do_dedup(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    async with SessionLocal() as db:
        await DedupJobRepo.set_running(db, job_id)

        try:
            await _run_clustering(db, job_id, project_id, strategy_id)
        except Exception as exc:
            await DedupJobRepo.set_failed(db, job_id, str(exc))
            raise


async def _run_clustering(
    db: AsyncSession,
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    # ── 1. Load strategy ────────────────────────────────────────────────────
    strategy = await db.get(MatchStrategy, strategy_id)
    if strategy is None:
        raise ValueError(f"Strategy {strategy_id} not found")
    preset = strategy.preset

    # ── 2. Count records before ─────────────────────────────────────────────
    count_result = await db.execute(
        select(func.count()).where(Record.project_id == project_id)
    )
    records_before = count_result.scalar_one()

    # ── 3. Fetch all record_sources for project ─────────────────────────────
    rs_rows = (
        await db.execute(
            select(
                RecordSource.id,
                RecordSource.record_id,
                RecordSource.norm_title,
                RecordSource.norm_first_author,
                RecordSource.match_year,
                RecordSource.match_doi,
                RecordSource.source_id,
                RecordSource.import_job_id,
                RecordSource.raw_data,
            )
            .join(Record, Record.id == RecordSource.record_id)
            .where(Record.project_id == project_id)
        )
    ).all()

    if not rs_rows:
        await DedupJobRepo.set_completed(db, job_id, records_before, 0, 0, 0, 0)
        await StrategyRepo.set_active(db, project_id, strategy_id)
        return

    # ── 4. Compute match key for each record_source ─────────────────────────
    # rs_data: list of dicts with id, old_record_id, match_key, match_basis
    rs_data = []
    for row in rs_rows:
        mk, basis = compute_match_key(
            norm_title=row.norm_title,
            norm_first_author=row.norm_first_author,
            year=row.match_year,
            doi=row.match_doi,
            preset=preset,
        )
        rs_data.append(
            {
                "id": row.id,
                "old_record_id": row.record_id,
                "match_key": mk,
                "match_basis": basis,
                "source_id": row.source_id,
                "import_job_id": row.import_job_id,
                "raw_data": row.raw_data,
            }
        )

    # ── 5. Group by match_key ────────────────────────────────────────────────
    # match_key=None → each source is isolated (own cluster)
    keyed_groups: dict[str, list[dict]] = defaultdict(list)
    null_records = []  # sources with no key
    for rs in rs_data:
        if rs["match_key"] is not None:
            keyed_groups[rs["match_key"]].append(rs)
        else:
            null_records.append(rs)

    # ── 6. Resolve clusters ─────────────────────────────────────────────────
    # Maps old_record_id → new canonical record id (for logging)
    match_log_entries: list[dict] = []
    merges = 0
    clusters_created = 0

    for match_key_val, members in keyed_groups.items():
        basis = members[0]["match_basis"]

        # Look for an existing canonical record with this match_key
        existing = (
            await db.execute(
                select(Record.id).where(
                    Record.project_id == project_id,
                    Record.match_key == match_key_val,
                )
            )
        ).scalar_one_or_none()

        if existing:
            canonical_id = existing
        else:
            # Create a new canonical record using the "best" member's data
            best = _pick_best_source(members)
            raw = best["raw_data"]
            new_rec = Record(
                project_id=project_id,
                match_key=match_key_val,
                match_basis=basis,
                normalized_doi=raw.get("doi"),
                doi=raw.get("doi"),
                title=raw.get("title"),
                abstract=raw.get("abstract"),
                authors=raw.get("authors"),
                year=raw.get("year"),
                journal=raw.get("journal"),
                volume=raw.get("volume"),
                issue=raw.get("issue"),
                pages=raw.get("pages"),
                issn=raw.get("issn"),
                keywords=raw.get("keywords"),
                source_format=raw.get("source_format", "ris"),
            )
            db.add(new_rec)
            await db.flush()
            canonical_id = new_rec.id
            clusters_created += 1

        # Re-point all record_sources in this cluster to canonical_id
        for rs in members:
            action = "unchanged" if rs["old_record_id"] == canonical_id else "merged"
            if action == "merged":
                merges += 1
            match_log_entries.append(
                {
                    "dedup_job_id": job_id,
                    "record_src_id": rs["id"],
                    "old_record_id": rs["old_record_id"],
                    "new_record_id": canonical_id,
                    "match_key": match_key_val,
                    "match_basis": basis,
                    "action": action,
                }
            )

        # Batch-update record_sources
        member_ids = [rs["id"] for rs in members]
        await db.execute(
            update(RecordSource)
            .where(RecordSource.id.in_(member_ids))
            .values(record_id=canonical_id)
        )

    # For null-keyed sources: each source keeps (or gets) its own isolated record.
    # Re-point to the same record it was already in — no change needed, just log.
    for rs in null_records:
        match_log_entries.append(
            {
                "dedup_job_id": job_id,
                "record_src_id": rs["id"],
                "old_record_id": rs["old_record_id"],
                "new_record_id": rs["old_record_id"],
                "match_key": None,
                "match_basis": "none",
                "action": "unchanged",
            }
        )

    await db.flush()

    # ── 7. Write match_log BEFORE deleting orphans (FK references old records) ─
    if match_log_entries:
        db.add_all([MatchLog(**e) for e in match_log_entries])
        await db.flush()

    # ── 8. Delete orphaned records rows (no record_sources pointing to them) ─
    orphan_result = await db.execute(
        delete(Record)
        .where(
            Record.project_id == project_id,
            Record.id.not_in(
                select(RecordSource.record_id).where(
                    RecordSource.record_id.isnot(None)
                )
            ),
        )
        .returning(Record.id)
    )
    clusters_deleted = len(orphan_result.fetchall())

    # ── 9. Count records after ───────────────────────────────────────────────
    count_after_result = await db.execute(
        select(func.count()).where(Record.project_id == project_id)
    )
    records_after = count_after_result.scalar_one()

    # ── 10. Mark job completed and set strategy active ───────────────────────
    await DedupJobRepo.set_completed(
        db,
        job_id,
        records_before=records_before,
        records_after=records_after,
        merges=merges,
        clusters_created=clusters_created,
        clusters_deleted=clusters_deleted,
    )
    await StrategyRepo.set_active(db, project_id, strategy_id)


def _pick_best_source(members: list[dict]) -> dict:
    """Choose the best canonical source record for a cluster.

    Priority: has DOI > most bib fields populated > earliest in list.
    """
    def score(m: dict) -> tuple:
        raw = m["raw_data"]
        has_doi = 1 if raw.get("doi") else 0
        field_count = sum(
            1 for k in ("title", "abstract", "authors", "year", "journal")
            if raw.get(k)
        )
        return (has_doi, field_count)

    return max(members, key=score)
