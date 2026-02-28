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
    cluster_id: Optional[uuid.UUID] = None  # None for preview (not persisted)
    origin: str = "auto"                    # 'auto' | 'manual' | 'mixed'
    locked: bool = False


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

    # ── 5. Delete NON-locked cross-source clusters (preserve locked ones) ───────
    await db.execute(
        delete(OverlapCluster).where(
            OverlapCluster.project_id == project_id,
            OverlapCluster.scope == "cross_source",
            OverlapCluster.locked == False,  # noqa: E712
        )
    )
    await db.flush()

    # ── 5b. Build exclusion set: record_source_ids already in locked clusters ──
    from app.repositories.overlap_repo import OverlapRepo
    locked_member_ids = await OverlapRepo.get_locked_cross_source_member_ids(db, project_id)

    # ── 6. Persist cross-source clusters only ─────────────────────────────────
    cross_overlaps = 0
    clusters_created = 0

    for cluster in clusters:
        unique_source_ids = {r.source_id for r in cluster.records}
        if len(unique_source_ids) <= 1:
            continue  # within-source clusters are managed by auto-trigger

        # Filter out records already covered by a locked cluster
        if locked_member_ids:
            free_records = [
                r for r in cluster.records
                if r.record_source_id not in locked_member_ids
            ]
            free_sources = {r.source_id for r in free_records}
            if len(free_records) < 2 or len(free_sources) < 2:
                continue  # not enough uncovered records to form a meaningful cluster
        else:
            free_records = cluster.records

        original_records = cluster.records
        cluster.records = free_records
        await _persist_cluster(db, project_id, job_id, "cross_source", cluster)
        cluster.records = original_records  # restore
        clusters_created += 1
        cross_overlaps += len(free_records)

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
) -> OverlapCluster:
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
    return oc


async def _cluster_to_summary(
    db: AsyncSession,
    cluster: OverlapCluster,
) -> OverlapClusterSummary:
    """Load members for a persisted cluster and return an OverlapClusterSummary."""
    members = (
        await db.execute(
            select(OverlapClusterMember).where(
                OverlapClusterMember.cluster_id == cluster.id
            )
        )
    ).scalars().all()
    source_ids = list({str(m.source_id) for m in members})
    record_source_ids = [str(m.record_source_id) for m in members]
    return OverlapClusterSummary(
        cluster_id=cluster.id,
        scope=cluster.scope,
        match_tier=cluster.match_tier,
        match_basis=cluster.match_basis,
        match_reason=cluster.match_reason or "",
        similarity_score=cluster.similarity_score,
        member_count=len(members),
        source_ids=source_ids,
        record_source_ids=record_source_ids,
        titles=[],
        dois=[],
        origin=cluster.origin,
        locked=cluster.locked,
    )


# ---------------------------------------------------------------------------
# MembershipInfo — pure data carrier for _plan_manual_link
# ---------------------------------------------------------------------------

@dataclass
class MembershipInfo:
    """Snapshot of one record_source's current cluster membership state."""
    record_source_id: uuid.UUID
    cluster_id: Optional[uuid.UUID]    # None = unclustered
    cluster_origin: Optional[str]      # 'auto' | 'manual' | 'mixed' | None
    cluster_locked: Optional[bool]     # None if unclustered
    cluster_scope: Optional[str]       # 'cross_source' | None


def _plan_manual_link(
    memberships: list,   # list[MembershipInfo]
    locked_param: bool,
) -> dict:
    """
    Pure function: decide what DB action to take when the user requests
    linking a set of records.  No DB access.

    Returns a dict with a discriminated 'action' key:
      'noop'           — all records already in the same cluster
      'merge'          — exactly 2 unlocked clusters → merge into one
      'create_new'     — create a fresh manual cluster
      'add_to_existing'— add unclustered records to one existing unlocked cluster
    """
    all_ids = [m.record_source_id for m in memberships]
    clustered = [m for m in memberships if m.cluster_id is not None]
    unclustered = [m for m in memberships if m.cluster_id is None]
    cluster_ids = list({m.cluster_id for m in clustered})

    # ── Case 1: noop — all in same cluster ───────────────────────────────────
    if len(cluster_ids) == 1 and len(unclustered) == 0:
        return {"action": "noop", "cluster_id": cluster_ids[0]}

    # ── Case 2: exactly 2 clusters ───────────────────────────────────────────
    if len(cluster_ids) == 2 and len(unclustered) == 0:
        locked_clusters = [m for m in clustered if m.cluster_locked]
        if not locked_clusters:
            # Neither locked: merge; keep the lexicographically smaller UUID
            sorted_ids = sorted(cluster_ids, key=str)
            keep_id, delete_id = sorted_ids[0], sorted_ids[1]
            return {
                "action": "merge",
                "keep_cluster_id": keep_id,
                "delete_cluster_id": delete_id,
                "origin": "mixed",
                "locked": locked_param,
            }
        # At least one locked → create a new manual cluster
        return {
            "action": "create_new",
            "origin": "manual",
            "locked": locked_param,
            "member_ids": all_ids,
        }

    # ── Case 3: 3+ clusters → always create_new ──────────────────────────────
    if len(cluster_ids) >= 3:
        return {
            "action": "create_new",
            "origin": "manual",
            "locked": locked_param,
            "member_ids": all_ids,
        }

    # ── Case 4: 1 cluster + some unclustered ─────────────────────────────────
    if len(cluster_ids) == 1 and unclustered:
        existing = clustered[0]
        if existing.cluster_locked:
            # Locked: create a new cluster with all records
            return {
                "action": "create_new",
                "origin": "manual",
                "locked": locked_param,
                "member_ids": all_ids,
            }
        # Unlocked: add unclustered records to the existing cluster
        new_origin = (
            "mixed" if existing.cluster_origin == "auto" else (existing.cluster_origin or "mixed")
        )
        return {
            "action": "add_to_existing",
            "cluster_id": existing.cluster_id,
            "new_member_ids": [m.record_source_id for m in unclustered],
            "origin": new_origin,
            "locked": locked_param,
        }

    # ── Case 5: all unclustered → create_new ─────────────────────────────────
    return {
        "action": "create_new",
        "origin": "manual",
        "locked": locked_param,
        "member_ids": all_ids,
    }


# ---------------------------------------------------------------------------
# Manual overlap linking
# ---------------------------------------------------------------------------

async def manual_link_records(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_source_ids: list,    # list[uuid.UUID]
    locked: bool = True,
    note: Optional[str] = None,
) -> OverlapClusterSummary:
    """
    Link a set of records into a cross_source overlap cluster.

    1. Load current cross_source membership state for each record_source_id.
    2. Call _plan_manual_link() (pure) to determine the required action.
    3. Execute the plan and return a summary of the resulting cluster.
    """
    from app.models.source import Source  # avoid circular import at module level

    if len(record_source_ids) < 2:
        raise ValueError("At least two records required to create a link")

    # ── 1. Load memberships ───────────────────────────────────────────────────
    membership_rows = (
        await db.execute(
            select(
                OverlapClusterMember.record_source_id,
                OverlapClusterMember.cluster_id,
                OverlapCluster.origin.label("cluster_origin"),
                OverlapCluster.locked.label("cluster_locked"),
                OverlapCluster.scope.label("cluster_scope"),
            )
            .join(OverlapCluster, OverlapCluster.id == OverlapClusterMember.cluster_id)
            .where(
                OverlapClusterMember.record_source_id.in_(record_source_ids),
                OverlapCluster.scope == "cross_source",
            )
        )
    ).all()
    membership_by_id = {row.record_source_id: row for row in membership_rows}

    memberships = []
    for rsid in record_source_ids:
        row = membership_by_id.get(rsid)
        memberships.append(MembershipInfo(
            record_source_id=rsid,
            cluster_id=row.cluster_id if row else None,
            cluster_origin=row.cluster_origin if row else None,
            cluster_locked=row.cluster_locked if row else None,
            cluster_scope=row.cluster_scope if row else None,
        ))

    # ── 2. Plan ───────────────────────────────────────────────────────────────
    plan = _plan_manual_link(memberships, locked)

    # ── 3. Execute ────────────────────────────────────────────────────────────
    if plan["action"] == "noop":
        cluster = await db.get(OverlapCluster, plan["cluster_id"])
        return await _cluster_to_summary(db, cluster)

    if plan["action"] == "merge":
        keep_id = plan["keep_cluster_id"]
        delete_id = plan["delete_cluster_id"]

        # Find members of the cluster to delete
        delete_members = (
            await db.execute(
                select(OverlapClusterMember).where(
                    OverlapClusterMember.cluster_id == delete_id
                )
            )
        ).scalars().all()

        existing_in_keep = set(
            (
                await db.execute(
                    select(OverlapClusterMember.record_source_id).where(
                        OverlapClusterMember.cluster_id == keep_id
                    )
                )
            ).scalars().all()
        )

        for m in delete_members:
            if m.record_source_id not in existing_in_keep:
                db.add(OverlapClusterMember(
                    cluster_id=keep_id,
                    record_source_id=m.record_source_id,
                    source_id=m.source_id,
                    role=m.role,
                    added_by="auto",
                ))
        await db.flush()

        # Delete the old cluster (cascade removes its members)
        await db.execute(delete(OverlapCluster).where(OverlapCluster.id == delete_id))
        await db.flush()

        # Update the kept cluster
        keep_cluster = await db.get(OverlapCluster, keep_id)
        keep_cluster.origin = plan["origin"]
        keep_cluster.locked = plan["locked"]
        await db.flush()
        return await _cluster_to_summary(db, keep_cluster)

    if plan["action"] == "add_to_existing":
        cluster = await db.get(OverlapCluster, plan["cluster_id"])
        # Look up source_id for each new record_source_id
        new_rs_rows = (
            await db.execute(
                select(RecordSource.id, RecordSource.source_id).where(
                    RecordSource.id.in_(plan["new_member_ids"])
                )
            )
        ).all()
        source_by_rsid = {row.id: row.source_id for row in new_rs_rows}
        for rsid in plan["new_member_ids"]:
            src_id = source_by_rsid.get(rsid)
            if src_id is not None:
                db.add(OverlapClusterMember(
                    cluster_id=cluster.id,
                    record_source_id=rsid,
                    source_id=src_id,
                    role="duplicate",
                    added_by="user",
                    note=note,
                ))
        cluster.origin = plan["origin"]
        cluster.locked = plan["locked"]
        await db.flush()
        return await _cluster_to_summary(db, cluster)

    # plan["action"] == "create_new"
    # Look up source_id for every record_source_id
    rs_rows = (
        await db.execute(
            select(RecordSource.id, RecordSource.source_id).where(
                RecordSource.id.in_(plan["member_ids"])
            )
        )
    ).all()
    source_by_rsid = {row.id: row.source_id for row in rs_rows}

    new_cluster = OverlapCluster(
        project_id=project_id,
        job_id=None,
        scope="cross_source",
        match_tier=0,
        match_basis="manual",
        match_reason="Manually linked by user",
        similarity_score=None,
        origin=plan["origin"],
        locked=plan["locked"],
    )
    db.add(new_cluster)
    await db.flush()

    for rsid in plan["member_ids"]:
        src_id = source_by_rsid.get(rsid)
        if src_id is not None:
            db.add(OverlapClusterMember(
                cluster_id=new_cluster.id,
                record_source_id=rsid,
                source_id=src_id,
                role="duplicate",
                added_by="user",
                note=note,
            ))
    await db.flush()
    return await _cluster_to_summary(db, new_cluster)


async def lock_cluster(
    db: AsyncSession,
    project_id: uuid.UUID,
    cluster_id: uuid.UUID,
    locked: bool,
) -> OverlapClusterSummary:
    """Set or clear the locked flag on a cluster."""
    cluster = await db.get(OverlapCluster, cluster_id)
    if cluster is None or cluster.project_id != project_id:
        raise ValueError(f"Cluster {cluster_id} not found in project {project_id}")
    cluster.locked = locked
    await db.flush()
    return await _cluster_to_summary(db, cluster)


async def remove_cluster_member(
    db: AsyncSession,
    project_id: uuid.UUID,
    cluster_id: uuid.UUID,
    record_source_id: uuid.UUID,
) -> None:
    """Remove a user-added member from a cluster."""
    # Verify the cluster belongs to this project
    cluster = await db.get(OverlapCluster, cluster_id)
    if cluster is None or cluster.project_id != project_id:
        raise ValueError(f"Cluster {cluster_id} not found in project {project_id}")

    # Fetch the specific member
    member_result = await db.execute(
        select(OverlapClusterMember).where(
            OverlapClusterMember.cluster_id == cluster_id,
            OverlapClusterMember.record_source_id == record_source_id,
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None:
        raise ValueError(f"Record source {record_source_id} not found in cluster {cluster_id}")
    if member.added_by != "user":
        raise ValueError("Only user-added members can be removed")

    await db.delete(member)
    await db.flush()


# ---------------------------------------------------------------------------
# Pure visual summary helpers
# ---------------------------------------------------------------------------

def compute_overlap_matrix(source_uuids: list, cluster_source_sets: list) -> list:
    """
    Return an N×N symmetric matrix (list[list[int]]).
    Diagonal is always 0 (unique_counts are tracked separately).
    Cell [i][j] = number of cross_source clusters shared between source i and j.

    source_uuids: ordered list of source UUIDs defining row/col order
    cluster_source_sets: list[list[UUID]] — each inner list is the distinct
                         source_ids present in one cross_source cluster
    """
    n = len(source_uuids)
    idx = {sid: i for i, sid in enumerate(source_uuids)}
    m = [[0] * n for _ in range(n)]
    for source_ids in cluster_source_sets:
        unique = list({sid for sid in source_ids if sid in idx})
        for i in range(len(unique)):
            for j in range(i + 1, len(unique)):
                a, b = idx[unique[i]], idx[unique[j]]
                m[a][b] += 1
                m[b][a] += 1
    return m


def compute_top_intersections(
    source_id_to_name: dict,
    cluster_source_sets: list,
    top_n: int = 10,
) -> list:
    """
    Return up to top_n source-combination groups sorted by descending cluster count.

    Each entry: {"source_ids": [str, ...], "source_names": [str, ...], "count": int}
    Only includes groups with ≥2 distinct sources.
    """
    from collections import Counter

    counts: Counter = Counter()
    for source_ids in cluster_source_sets:
        key = frozenset(source_ids)
        if len(key) >= 2:
            counts[key] += 1

    result = []
    for key, count in counts.most_common(top_n):
        result.append({
            "source_ids": [str(sid) for sid in key],
            "source_names": [source_id_to_name.get(sid, str(sid)) for sid in key],
            "count": count,
        })
    return result


async def build_visual_summary(db: AsyncSession, project_id: uuid.UUID) -> dict:
    """
    Load data and compute the overlap visual summary for OverlapPage.
    Returns dict matching OverlapVisualSummary frontend type.
    """
    from app.repositories.overlap_repo import OverlapRepo

    source_rows = await OverlapRepo.source_totals_with_overlap(db, project_id)
    sources = [{"id": str(r.id), "name": r.name} for r in source_rows]
    source_uuids = [r.id for r in source_rows]
    unique_counts = {
        str(r.id): max(0, r.total - r.internal_overlaps)
        for r in source_rows
    }
    source_id_to_name = {r.id: r.name for r in source_rows}

    cluster_source_sets = await OverlapRepo.cross_source_cluster_source_sets(db, project_id)
    matrix = compute_overlap_matrix(source_uuids, cluster_source_sets)
    top_intersections = compute_top_intersections(source_id_to_name, cluster_source_sets)

    return {
        "sources": sources,
        "matrix": matrix,
        "unique_counts": unique_counts,
        "top_intersections": top_intersections,
    }
