"""
Overlap Resolution service.

Two modes of operation:
  run_overlap_detection()  — Full async background task that detects overlaps,
                             persists results to overlap_clusters, and creates
                             a dedup_job entry for tracking.
  build_overlap_snapshot() — Synchronous helper used by both the background task
                             and the preview endpoint; returns OverlapSnapshot.

Overlap scopes:
  within_source — all members of the cluster come from the same source file.
                  These are true intra-source duplicates (e.g. PubMed returned
                  the same PMID twice in one export).
  cross_source  — members span two or more sources.
                  These are the same paper appearing in multiple databases.

Algorithm: Delegates to TieredClusterBuilder (existing Union-Find engine) and
categorises each resulting cluster by comparing source_id membership.
"""
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
from app.utils.cluster_builder import Cluster, TieredClusterBuilder, SourceRecord
from app.utils.match_keys import StrategyConfig


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
    source_ids: list[str]               # unique source_ids in this cluster
    record_source_ids: list[str]        # all record_source IDs
    titles: list[Optional[str]]
    dois: list[Optional[str]]


@dataclass
class OverlapSnapshot:
    """Full result of an overlap detection run."""
    within_source_clusters: list[OverlapClusterSummary]
    cross_source_clusters: list[OverlapClusterSummary]
    within_source_duplicate_count: int  # total duplicate records found within sources
    cross_source_overlap_count: int     # record_sources that overlap across sources
    unique_overlapping_papers: int      # canonical clusters with cross-source overlap


# ---------------------------------------------------------------------------
# Public entry point: background task
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


# ---------------------------------------------------------------------------
# Internal implementation
# ---------------------------------------------------------------------------

async def _do_overlap_detection(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    async with SessionLocal() as db:
        await DedupJobRepo.set_running(db, job_id)
        try:
            await _run_detection(db, job_id, project_id, strategy_id)
        except Exception as exc:
            await DedupJobRepo.set_failed(db, job_id, str(exc))
            raise


async def _run_detection(
    db: AsyncSession,
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    strategy_id: uuid.UUID,
) -> None:
    # ── 1. Load strategy ─────────────────────────────────────────────────────
    strategy = await db.get(MatchStrategy, strategy_id)
    if strategy is None:
        raise ValueError(f"Strategy {strategy_id} not found")

    config_dict = strategy.config or {}
    config = StrategyConfig.from_dict(config_dict) if config_dict else StrategyConfig.from_preset(strategy.preset)

    # ── 2. Count records before ──────────────────────────────────────────────
    records_before = (
        await db.execute(select(func.count()).where(Record.project_id == project_id))
    ).scalar_one()

    # ── 3. Fetch all record_sources with source_id ───────────────────────────
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

    # ── 4. Build SourceRecord objects (include source_id in raw_data for lookup)
    sources, source_id_map = _build_source_records(rs_rows)

    # ── 5. Cluster all sources ───────────────────────────────────────────────
    builder = TieredClusterBuilder(config)
    clusters = builder.compute_clusters(sources)

    # ── 6. Delete previous overlap clusters for this project ─────────────────
    await db.execute(
        delete(OverlapCluster).where(OverlapCluster.project_id == project_id)
    )
    await db.flush()

    # ── 7. Categorise clusters and persist ───────────────────────────────────
    within_dupes = 0
    cross_overlaps = 0
    clusters_created = 0

    for cluster in clusters:
        if cluster.size <= 1:
            continue  # isolated — not an overlap

        scope = _classify_scope(cluster, source_id_map)

        oc = OverlapCluster(
            project_id=project_id,
            job_id=job_id,
            scope=scope,
            match_tier=cluster.match_tier,
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

        for src in cluster.members:
            role = "canonical" if src.id == cluster.representative.id else "duplicate"
            db.add(OverlapClusterMember(
                cluster_id=oc.id,
                record_source_id=src.id,
                source_id=source_id_map[src.id],
                role=role,
            ))

        clusters_created += 1
        if scope == "within_source":
            within_dupes += cluster.size - 1
        else:
            cross_overlaps += cluster.size

    await db.flush()

    # ── 8. Mark job completed ────────────────────────────────────────────────
    await DedupJobRepo.set_completed(
        db,
        job_id,
        records_before=records_before,
        records_after=records_before,  # overlap detection does not change records
        merges=within_dupes + cross_overlaps,
        clusters_created=clusters_created,
        clusters_deleted=0,
    )
    await StrategyRepo.set_active(db, project_id, strategy_id)


# ---------------------------------------------------------------------------
# Synchronous snapshot builder (used by preview endpoint and the above)
# ---------------------------------------------------------------------------

def build_overlap_snapshot(
    sources: list[SourceRecord],
    source_id_map: dict[uuid.UUID, uuid.UUID],
    config: StrategyConfig,
) -> OverlapSnapshot:
    """
    Runs the cluster builder and categorises results into within-source and
    cross-source clusters.  No DB writes.

    Args:
        sources:        SourceRecord list (all records in the project)
        source_id_map:  Maps record_source.id → source.id
        config:         StrategyConfig to use for clustering
    Returns:
        OverlapSnapshot with lists of OverlapClusterSummary objects
    """
    builder = TieredClusterBuilder(config)
    clusters = builder.compute_clusters(sources)

    within: list[OverlapClusterSummary] = []
    cross: list[OverlapClusterSummary] = []

    for cluster in clusters:
        if cluster.size <= 1:
            continue

        scope = _classify_scope(cluster, source_id_map)
        unique_source_ids = list({
            str(source_id_map[m.id]) for m in cluster.members
            if m.id in source_id_map
        })
        summary = OverlapClusterSummary(
            scope=scope,
            match_tier=cluster.match_tier,
            match_basis=cluster.match_basis,
            match_reason=cluster.match_reason,
            similarity_score=cluster.similarity_score,
            member_count=cluster.size,
            source_ids=unique_source_ids,
            record_source_ids=[str(m.id) for m in cluster.members],
            titles=[m.raw_data.get("title") for m in cluster.members],
            dois=[m.match_doi for m in cluster.members],
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

def _build_source_records(
    rs_rows,
) -> tuple[list[SourceRecord], dict[uuid.UUID, uuid.UUID]]:
    """
    Convert DB rows into SourceRecord objects.
    Returns (sources, source_id_map) where source_id_map[rs.id] = rs.source_id.
    """
    sources: list[SourceRecord] = []
    source_id_map: dict[uuid.UUID, uuid.UUID] = {}

    for row in rs_rows:
        raw = row.raw_data or {}
        pmid = raw.get("pmid") or raw.get("source_record_id")
        authors = raw.get("authors")
        src = SourceRecord(
            id=row.id,
            old_record_id=row.record_id,
            norm_title=row.norm_title,
            norm_first_author=row.norm_first_author,
            match_year=row.match_year,
            match_doi=row.match_doi,
            pmid=str(pmid) if pmid else None,
            authors=authors if isinstance(authors, list) else None,
            raw_data=raw,
        )
        sources.append(src)
        source_id_map[row.id] = row.source_id

    return sources, source_id_map


def _classify_scope(
    cluster: Cluster,
    source_id_map: dict[uuid.UUID, uuid.UUID],
) -> str:
    """
    Return 'within_source' if all cluster members come from the same source,
    otherwise 'cross_source'.
    """
    source_ids = {source_id_map.get(m.id) for m in cluster.members}
    source_ids.discard(None)
    return "within_source" if len(source_ids) <= 1 else "cross_source"
