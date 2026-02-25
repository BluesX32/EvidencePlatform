"""Dedup service: re-clusters record_sources under a new match strategy.

Runs as a FastAPI background task. The router creates the dedup_job row and
returns 202 immediately; this service does the actual work.

Algorithm (Tiered — Phase B upgrade)
--------------------------------------
For each record_source in the project:
  1. Build a SourceRecord from precomputed norm fields + PMID from raw_data.
  2. Call TieredClusterBuilder.compute_clusters() — Union-Find over 3 tiers:
       Tier 1: exact DOI or PMID
       Tier 2: exact normalized title + year (or + author)
       Tier 3: fuzzy title similarity (rapidfuzz, optional)
  3. For each cluster:
       a. Derive match_key for the canonical record from the cluster's tier+representative.
       b. Find or create a canonical records row with that match_key.
       c. Re-point record_sources.record_id to the cluster's canonical record.
  4. Delete orphaned records rows (no record_sources left).
  5. Log every move to match_log with match_tier, match_basis, match_reason.
  6. Update dedup_jobs statistics and status.

Backward compatibility: existing presets (doi_first_strict, etc.) are converted
to StrategyConfig via StrategyConfig.from_preset(), producing identical clustering
behavior for tiers 1 and 2.

Advisory lock ensures only one mutation job (import or dedup) runs per project.
"""
import uuid
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
from app.utils.match_keys import StrategyConfig
from app.utils.cluster_builder import TieredClusterBuilder, SourceRecord, Cluster


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
    # ── 1. Load strategy and resolve StrategyConfig ──────────────────────────
    strategy = await db.get(MatchStrategy, strategy_id)
    if strategy is None:
        raise ValueError(f"Strategy {strategy_id} not found")

    # Prefer JSONB config; fall back to preset mapping for existing strategies
    config_dict = strategy.config or {}
    if config_dict:
        config = StrategyConfig.from_dict(config_dict)
    else:
        config = StrategyConfig.from_preset(strategy.preset)

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

    # ── 4. Build SourceRecord objects ────────────────────────────────────────
    sources = []
    for row in rs_rows:
        raw = row.raw_data or {}
        # PMID may be stored under 'pmid' (MEDLINE) or 'source_record_id' (general)
        pmid = raw.get("pmid") or raw.get("source_record_id")
        authors = raw.get("authors")
        sources.append(SourceRecord(
            id=row.id,
            old_record_id=row.record_id,
            norm_title=row.norm_title,
            norm_first_author=row.norm_first_author,
            match_year=row.match_year,
            match_doi=row.match_doi,
            pmid=str(pmid) if pmid else None,
            authors=authors if isinstance(authors, list) else None,
            raw_data=raw,
        ))

    # ── 5. Run tiered clustering ─────────────────────────────────────────────
    builder = TieredClusterBuilder(config)
    clusters = builder.compute_clusters(sources)

    # ── 6. Resolve clusters ─────────────────────────────────────────────────
    match_log_entries: list[dict] = []
    merges = 0
    clusters_created = 0

    for cluster in clusters:
        is_isolated = cluster.match_tier == 0

        if is_isolated:
            # Isolated: each source keeps its existing record unchanged
            for src in cluster.members:
                match_log_entries.append({
                    "dedup_job_id": job_id,
                    "record_src_id": src.id,
                    "old_record_id": src.old_record_id,
                    "new_record_id": src.old_record_id,
                    "match_key": None,
                    "match_basis": "none",
                    "action": "unchanged",
                })
            continue

        # Derive canonical match_key from cluster tier + representative
        match_key_val = _derive_match_key(cluster)

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
            # Create a new canonical record from the cluster's representative
            rep = cluster.representative
            raw = rep.raw_data
            new_rec = Record(
                project_id=project_id,
                match_key=match_key_val,
                match_basis=cluster.match_basis,
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

        # Batch-update record_sources to point to canonical record
        member_ids = [src.id for src in cluster.members]
        await db.execute(
            update(RecordSource)
            .where(RecordSource.id.in_(member_ids))
            .values(record_id=canonical_id)
        )

        for src in cluster.members:
            action = "unchanged" if src.old_record_id == canonical_id else "merged"
            if action == "merged":
                merges += 1
            match_log_entries.append({
                "dedup_job_id": job_id,
                "record_src_id": src.id,
                "old_record_id": src.old_record_id,
                "new_record_id": canonical_id,
                "match_key": match_key_val,
                "match_basis": cluster.match_basis,
                "action": action,
            })

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


def _derive_match_key(cluster: Cluster) -> Optional[str]:
    """
    Derive the canonical match_key string for a non-isolated cluster.

    The key format is compatible with the legacy compute_match_key() output
    so that existing canonical records can be found by match_key lookup.
    """
    rep = cluster.representative
    basis = cluster.match_basis

    if basis == "tier1_doi" and rep.match_doi:
        return f"doi:{rep.match_doi}"
    if basis == "tier1_pmid" and rep.pmid:
        return f"pmid:{rep.pmid}"
    if basis == "tier2_title_year" and rep.norm_title and rep.match_year:
        return f"ty:{rep.norm_title}|{rep.match_year}"
    if basis == "tier2_title_author_year" and rep.norm_title and rep.norm_first_author and rep.match_year:
        return f"tay:{rep.norm_title}|{rep.norm_first_author}|{rep.match_year}"
    if basis == "tier3_fuzzy" and rep.norm_title:
        score = cluster.similarity_score or 0.0
        year = rep.match_year or "unknown"
        return f"fuz:{score:.2f}:{rep.norm_title}|{year}"

    # Fallback: stable key based on representative's source ID
    return f"auto:{rep.id}"
