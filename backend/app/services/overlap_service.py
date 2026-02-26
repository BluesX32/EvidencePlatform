"""
Overlap Resolution service.

Two modes of operation:
  run_within_source_detection() — Auto-triggered after each successful import.
                                   No advisory lock. Clears old within-source
                                   clusters for the given source and writes
                                   fresh ones.
  run_overlap_detection()       — Manual cross-source detection (background
                                   task via /overlaps/run). Acquires advisory
                                   lock, loads ALL record_sources, runs
                                   OverlapDetector, persists cross_source
                                   clusters only (within_source clusters are
                                   managed by the auto-trigger above).
  build_overlap_preview()       — Pure (no DB writes). Used by /preview endpoint.

Overlap scopes:
  within_source — all cluster members from the same source file
  cross_source  — members from two or more sources

Algorithm: OverlapDetector (5-tier, blocking key, Union-Find) in
app.utils.overlap_detector.  No longer delegates to TieredClusterBuilder.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal, engine
from app.models.dedup_job import DedupJob
from app.models.match_strategy import MatchStrategy
from app.models.overlap_cluster import OverlapCluster
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.record import Record
from app.models.record_source import RecordSource
from app.repositories.dedup_repo import DedupJobRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.locks import try_acquire_project_lock, release_project_lock
from app.utils.overlap_detector import (
    OverlapConfig,
    OverlapDetector,
    DetectedCluster,
    OverlapRecord,
    _build_overlap_records,
    select_representative,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lightweight result types (not persisted; used for preview and response)
# ---------------------------------------------------------------------------

@dataclass
class OverlapClusterSummary:
    """Serialisable view of one detected overlap cluster."""
    scope: str                          # 'within_source' | 'cross_source'
    match_tier: int
    match_basis: str
    match_reason: str
    similarity_score: Optional[float]
    member_count: int
    source_ids: list                    # unique source_ids in this cluster
    record_source_ids: list             # all record_source IDs
    titles: list
    dois: list


@dataclass
class OverlapSnapshot:
    """Full result of an overlap detection run."""
    within_source_clusters: list
    cross_source_clusters: list
    within_source_duplicate_count: int  # total duplicate records found within sources
    cross_source_overlap_count: int     # record_sources that overlap across sources
    unique_overlapping_papers: int      # canonical clusters with cross-source overlap


# ---------------------------------------------------------------------------
# Auto-triggered: within-source detection (after each import)
# ---------------------------------------------------------------------------

async def run_within_source_detection(
    project_id: uuid.UUID,
    source_id: uuid.UUID,
) -> None:
    """
    Auto-triggered after a successful import. No advisory lock needed.

    1. Load all record_sources for the given source.
    2. Run OverlapDetector — only within-source pairs matter here.
    3. Delete old within-source clusters for this source.
    4. Persist new within-source clusters.
    """
    async with SessionLocal() as db:
        # Load record_sources for this source only
        rs_rows = (
            await db.execute(
                select(
                    RecordSource.id,
                    RecordSource.record_id,
                    RecordSource.source_id,
                    RecordSource.norm_title,
                    RecordSource.norm_first_author,
                    RecordSource.match_year,
                    RecordSource.match_doi,
                    RecordSource.raw_data,
                )
                .where(RecordSource.source_id == source_id)
            )
        ).all()

        if len(rs_rows) < 2:
            return

        records = _build_overlap_records(rs_rows)
        config = _load_config_for_project(None)  # use default for auto-run

        detector = OverlapDetector(config)
        clusters = detector.detect(records)

        # Delete previous within-source clusters for this source
        # (clusters whose ONLY members belong to this source)
        old_cluster_ids = (
            await db.execute(
                select(OverlapCluster.id)
                .join(
                    OverlapClusterMember,
                    OverlapClusterMember.cluster_id == OverlapCluster.id,
                )
                .where(
                    OverlapCluster.project_id == project_id,
                    OverlapCluster.scope == "within_source",
                    OverlapClusterMember.source_id == source_id,
                )
                .group_by(OverlapCluster.id)
            )
        ).scalars().all()

        if old_cluster_ids:
            await db.execute(
                delete(OverlapCluster).where(OverlapCluster.id.in_(old_cluster_ids))
            )
            await db.flush()

        # Persist new within-source clusters only
        for cluster in clusters:
            unique_sources = {r.source_id for r in cluster.records}
            if len(unique_sources) != 1:
                continue  # skip cross-source (shouldn't happen within one source load)

            await _persist_cluster(db, project_id, None, "within_source", cluster)

        await db.commit()
        logger.info(
            "Within-source overlap detection complete for source %s: %d clusters",
            source_id,
            sum(1 for c in clusters if len({r.source_id for r in c.records}) == 1),
        )


# ---------------------------------------------------------------------------
# Manual: cross-source detection (background task via /overlaps/run)
# ---------------------------------------------------------------------------

async def run_overlap_detection(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    """Background task entry point (used by the /overlaps/run endpoint)."""
    async with engine.connect() as lock_conn:
        acquired = await try_acquire_project_lock(lock_conn, project_id)
        if not acquired:
            async with SessionLocal() as db:
                await DedupJobRepo.set_failed(
                    db, job_id,
                    "Could not acquire project lock: another job is running",
                )
            return
        try:
            await _do_overlap_detection(job_id, project_id, strategy_id)
        finally:
            await release_project_lock(lock_conn, project_id)


async def _do_overlap_detection(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    async with SessionLocal() as db:
        await DedupJobRepo.set_running(db, job_id)
        try:
            await _run_cross_source_detection(db, job_id, project_id, strategy_id)
        except Exception as exc:
            await DedupJobRepo.set_failed(db, job_id, str(exc))
            raise


async def _run_cross_source_detection(
    db: AsyncSession,
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    # ── 1. Load strategy ─────────────────────────────────────────────────────
    strategy = await db.get(MatchStrategy, strategy_id)
    if strategy is None:
        raise ValueError(f"Strategy {strategy_id} not found")

    config = _load_config_for_project(strategy)

    # ── 2. Count records before ──────────────────────────────────────────────
    records_before = (
        await db.execute(select(func.count()).where(Record.project_id == project_id))
    ).scalar_one()

    # ── 3. Fetch ALL record_sources for this project ─────────────────────────
    rs_rows = (
        await db.execute(
            select(
                RecordSource.id,
                RecordSource.record_id,
                RecordSource.source_id,
                RecordSource.norm_title,
                RecordSource.norm_first_author,
                RecordSource.match_year,
                RecordSource.match_doi,
                RecordSource.raw_data,
            )
            .join(Record, Record.id == RecordSource.record_id)
            .where(Record.project_id == project_id)
        )
    ).all()

    if not rs_rows:
        await DedupJobRepo.set_completed(db, job_id, records_before, records_before, 0, 0, 0)
        return

    # ── 4. Run detector ───────────────────────────────────────────────────────
    records = _build_overlap_records(rs_rows)
    detector = OverlapDetector(config)
    clusters = detector.detect(records)

    # ── 5. Delete previous cross-source clusters for this project ────────────
    await db.execute(
        delete(OverlapCluster).where(
            OverlapCluster.project_id == project_id,
            OverlapCluster.scope == "cross_source",
        )
    )
    await db.flush()

    # ── 6. Persist cross-source clusters only ─────────────────────────────────
    cross_overlaps = 0
    clusters_created = 0

    for cluster in clusters:
        unique_source_ids = {r.source_id for r in cluster.records}
        if len(unique_source_ids) <= 1:
            continue  # within-source clusters are managed by auto-trigger

        await _persist_cluster(db, project_id, job_id, "cross_source", cluster)
        clusters_created += 1
        cross_overlaps += len(cluster.records)

    # ── 7. Mark job completed ────────────────────────────────────────────────
    await DedupJobRepo.set_completed(
        db,
        job_id,
        records_before=records_before,
        records_after=records_before,
        merges=cross_overlaps,
        clusters_created=clusters_created,
        clusters_deleted=0,
    )
    await StrategyRepo.set_active(db, project_id, strategy_id)
    await db.commit()


# ---------------------------------------------------------------------------
# Preview (pure — no DB writes)
# ---------------------------------------------------------------------------

def build_overlap_preview(rs_rows, config: OverlapConfig) -> OverlapSnapshot:
    """
    Run OverlapDetector on the given rows and classify into within/cross.
    No DB writes. Used by the /preview endpoint.
    """
    records = _build_overlap_records(rs_rows)
    detector = OverlapDetector(config)
    clusters = detector.detect(records)

    within: list = []
    cross: list = []

    for cluster in clusters:
        unique_source_ids = {r.source_id for r in cluster.records}
        scope = "within_source" if len(unique_source_ids) == 1 else "cross_source"
        summary = OverlapClusterSummary(
            scope=scope,
            match_tier=cluster.tier,
            match_basis=cluster.match_basis,
            match_reason=cluster.match_reason,
            similarity_score=cluster.similarity_score,
            member_count=len(cluster.records),
            source_ids=[str(sid) for sid in unique_source_ids],
            record_source_ids=[str(r.record_source_id) for r in cluster.records],
            titles=[r.norm_title or None for r in cluster.records],
            dois=[r.doi for r in cluster.records],
        )
        if scope == "within_source":
            within.append(summary)
        else:
            cross.append(summary)

    within_dup_count = sum(c.member_count - 1 for c in within)
    cross_overlap_count = sum(c.member_count for c in cross)
    unique_papers = len(cross)

    return OverlapSnapshot(
        within_source_clusters=within,
        cross_source_clusters=cross,
        within_source_duplicate_count=within_dup_count,
        cross_source_overlap_count=cross_overlap_count,
        unique_overlapping_papers=unique_papers,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_config_for_project(strategy: Optional[MatchStrategy]) -> OverlapConfig:
    """Load OverlapConfig from strategy.selected_fields JSONB, or use default."""
    if strategy is None:
        return OverlapConfig.default()
    sf = strategy.selected_fields
    if sf and isinstance(sf, dict):
        return OverlapConfig.from_dict(sf)
    return OverlapConfig.default()


async def _persist_cluster(
    db: AsyncSession,
    project_id: uuid.UUID,
    job_id: Optional[uuid.UUID],
    scope: str,
    cluster: DetectedCluster,
) -> None:
    """Write one DetectedCluster to overlap_clusters + overlap_cluster_members."""
    rep = select_representative(cluster.records)

    oc = OverlapCluster(
        project_id=project_id,
        job_id=job_id,
        scope=scope,
        match_tier=cluster.tier,
        match_basis=cluster.match_basis,
        match_reason=cluster.match_reason,
        similarity_score=cluster.similarity_score,
        reason_json={
            "match_basis": cluster.match_basis,
            "match_reason": cluster.match_reason,
        },
    )
    db.add(oc)
    await db.flush()  # get oc.id

    for r in cluster.records:
        role = "canonical" if r.record_source_id == rep.record_source_id else "duplicate"
        db.add(OverlapClusterMember(
            cluster_id=oc.id,
            record_source_id=r.record_source_id,
            source_id=r.source_id,
            role=role,
        ))
    await db.flush()
