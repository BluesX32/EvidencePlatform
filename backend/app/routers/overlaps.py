"""
Overlap Resolution API endpoints.

POST /projects/{project_id}/overlaps/run        — Start an overlap detection job
GET  /projects/{project_id}/overlaps            — Get latest overlap summary
GET  /projects/{project_id}/overlaps/preview    — Preview overlaps without writing
GET  /projects/{project_id}/overlaps/clusters   — Detailed cluster list

The "Overlap Resolution" module has two conceptual engines:
  Within-Source Uniqueness  — duplicates within a single source file
                              (auto-triggered after each import)
  Cross-Source Overlap      — same paper in multiple sources
                              (manual run via /overlaps/run)

Both use OverlapDetector (5-tier, field-based, Union-Find).
"""
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.dedup_job import DedupJob
from app.models.match_strategy import MatchStrategy
from app.models.overlap_cluster import OverlapCluster
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source
from app.models.user import User
from app.repositories.dedup_repo import DedupJobRepo
from app.repositories.overlap_repo import OverlapRepo
from app.repositories.project_repo import ProjectRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.overlap_service import (
    build_overlap_preview,
    build_visual_summary,
    compute_top_intersections,
    lock_cluster,
    manual_link_records,
    remove_cluster_member,
)
from app.utils.overlap_detector import OverlapConfig, _build_overlap_records

router = APIRouter(prefix="/projects/{project_id}/overlaps", tags=["overlap-resolution"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _require_project_access(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Forbidden")
    return project


def _resolve_config(strategy: MatchStrategy) -> OverlapConfig:
    sf = strategy.selected_fields
    if sf and isinstance(sf, dict):
        return OverlapConfig.from_dict(sf)
    return OverlapConfig.default()


async def _fetch_rs_rows(db: AsyncSession, project_id: uuid.UUID):
    return (
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


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------

class OverlapRunRequest(BaseModel):
    strategy_id: uuid.UUID


class OverlapRunResponse(BaseModel):
    overlap_job_id: str
    status: str
    message: str


class ManualLinkRequest(BaseModel):
    record_ids: list        # list[str UUID]
    locked: bool = True
    note: Optional[str] = None


class ClusterLockRequest(BaseModel):
    locked: bool


class ClusterSummaryResponse(BaseModel):
    cluster_id: str
    scope: str
    match_tier: int
    match_basis: str
    match_reason: str
    similarity_score: Optional[float]
    member_count: int
    source_ids: list
    record_source_ids: list
    origin: str
    locked: bool


# ---------------------------------------------------------------------------
# POST /overlaps/run — start overlap detection background job
# ---------------------------------------------------------------------------

@router.post(
    "/run",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=OverlapRunResponse,
)
async def run_overlap_detection(
    project_id: uuid.UUID,
    body: OverlapRunRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Start an Overlap Resolution job in the background.

    The job detects cross-source overlaps (same paper in multiple sources).
    Within-source duplicates are detected automatically after each import.

    Results are stored in overlap_clusters and overlap_cluster_members.
    Poll GET /overlaps to see results once complete.
    """
    await _require_project_access(project_id, current_user, db)

    strategy = await StrategyRepo.get_by_id(db, project_id, body.strategy_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")

    # Check for already-running job
    running = await DedupJobRepo.get_running(db, project_id)
    if running:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Another job is already running for this project.",
                "job_id": str(running.id),
            },
        )

    # Create a dedup_job entry to track this run
    job = await DedupJobRepo.create(db, project_id, body.strategy_id, current_user.id)

    from app.services.overlap_service import run_overlap_detection as _run_detection
    background_tasks.add_task(_run_detection, job.id, project_id, body.strategy_id)

    return OverlapRunResponse(
        overlap_job_id=str(job.id),
        status="accepted",
        message="Overlap detection started. Poll GET /overlaps for results.",
    )


# ---------------------------------------------------------------------------
# GET /overlaps — latest overlap summary
# ---------------------------------------------------------------------------

@router.get("")
async def get_overlap_summary(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return a summary of the latest overlap detection results for this project.

    Includes:
    - Strategy name used for the last run
    - Within-source duplicate counts
    - Cross-source overlap counts
    - Per-source record totals (with unique_count and internal_overlaps)
    - Pairwise source overlap (computed from canonical record_id)
    """
    await _require_project_access(project_id, current_user, db)

    # Get active strategy name
    strategy = await StrategyRepo.get_active(db, project_id)
    strategy_name = strategy.name if strategy else None

    # Aggregate overlap_clusters
    within_count = (
        await db.execute(
            select(func.count(OverlapCluster.id)).where(
                OverlapCluster.project_id == project_id,
                OverlapCluster.scope == "within_source",
            )
        )
    ).scalar_one()

    cross_count = (
        await db.execute(
            select(func.count(OverlapCluster.id)).where(
                OverlapCluster.project_id == project_id,
                OverlapCluster.scope == "cross_source",
            )
        )
    ).scalar_one()

    # Within-source duplicate members (excluding the canonical in each cluster)
    within_dup_members = (
        await db.execute(
            select(func.count(OverlapClusterMember.id))
            .join(
                OverlapCluster,
                OverlapCluster.id == OverlapClusterMember.cluster_id,
            )
            .where(
                OverlapCluster.project_id == project_id,
                OverlapCluster.scope == "within_source",
                OverlapClusterMember.role == "duplicate",
            )
        )
    ).scalar_one()

    # Per-source totals with overlap counts
    source_rows = await OverlapRepo.source_totals_with_overlap(db, project_id)

    return {
        "strategy_name": strategy_name,
        "within_source": {
            "cluster_count": within_count,
            "duplicate_record_count": within_dup_members,
        },
        "cross_source": {
            "cluster_count": cross_count,
        },
        "sources": [
            {
                "id": str(r.id),
                "name": r.name,
                "total": r.total,
                "with_doi": r.with_doi,
                "internal_overlaps": r.internal_overlaps,
                "unique_count": max(0, r.total - r.internal_overlaps),
            }
            for r in source_rows
        ],
    }


# ---------------------------------------------------------------------------
# GET /overlaps/clusters — detailed cluster listing
# ---------------------------------------------------------------------------

@router.get("/clusters")
async def list_overlap_clusters(
    project_id: uuid.UUID,
    # Pagination
    page: int = Query(1, ge=1, description="1-based page number"),
    page_size: int = Query(50, ge=1, le=200, description="Items per page (25/50/100 recommended)"),
    # Filters
    scope: Optional[str] = Query(None, description="'within_source' | 'cross_source'"),
    source_id: Optional[uuid.UUID] = Query(None, description="Filter clusters containing this source"),
    origin: Optional[str] = Query(None, description="'auto' | 'manual' | 'mixed'"),
    locked: Optional[bool] = Query(None, description="True = pinned clusters only"),
    min_sources: Optional[int] = Query(None, ge=2, description="Min distinct source count per cluster"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List detected overlap clusters with member details.

    Supports server-side pagination (page/page_size) and filtering
    by scope, source, origin, locked status, and minimum source count.
    Returns total_items and total_pages for pagination controls.
    """
    import math as _math
    await _require_project_access(project_id, current_user, db)

    # Build WHERE conditions
    conditions = [OverlapCluster.project_id == project_id]
    if scope:
        conditions.append(OverlapCluster.scope == scope)
    if origin:
        conditions.append(OverlapCluster.origin == origin)
    if locked is not None:
        conditions.append(OverlapCluster.locked == locked)
    if source_id is not None:
        conditions.append(
            OverlapCluster.id.in_(
                select(OverlapClusterMember.cluster_id).where(
                    OverlapClusterMember.source_id == source_id
                )
            )
        )
    if min_sources is not None:
        src_count_sq = (
            select(func.count(func.distinct(OverlapClusterMember.source_id)))
            .where(OverlapClusterMember.cluster_id == OverlapCluster.id)
            .correlate(OverlapCluster)
            .scalar_subquery()
        )
        conditions.append(src_count_sq >= min_sources)

    # COUNT query (no LIMIT/OFFSET)
    total_items: int = (
        await db.execute(select(func.count(OverlapCluster.id)).where(*conditions))
    ).scalar() or 0
    total_pages = max(1, _math.ceil(total_items / page_size)) if total_items else 1

    # Correlated subquery for ORDER BY member count
    mc_sq = (
        select(func.count(OverlapClusterMember.id))
        .where(OverlapClusterMember.cluster_id == OverlapCluster.id)
        .correlate(OverlapCluster)
        .scalar_subquery()
    )

    # Data query with LIMIT/OFFSET
    data_q = (
        select(OverlapCluster)
        .where(*conditions)
        .order_by(mc_sq.desc(), OverlapCluster.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    clusters = (await db.execute(data_q)).scalars().all()

    result = []
    for oc in clusters:
        members = (
            await db.execute(
                select(
                    OverlapClusterMember.record_source_id,
                    OverlapClusterMember.source_id,
                    OverlapClusterMember.role,
                    OverlapClusterMember.added_by,
                    OverlapClusterMember.note,
                    RecordSource.norm_title,
                    RecordSource.match_doi,
                    RecordSource.match_year,
                    Source.name.label("source_name"),
                    Record.title.label("orig_title"),
                )
                .join(
                    RecordSource,
                    RecordSource.id == OverlapClusterMember.record_source_id,
                )
                .join(Source, Source.id == OverlapClusterMember.source_id)
                .join(Record, Record.id == RecordSource.record_id)
                .where(OverlapClusterMember.cluster_id == oc.id)
            )
        ).all()

        result.append({
            "cluster_id": str(oc.id),
            "scope": oc.scope,
            "match_tier": oc.match_tier,
            "match_basis": oc.match_basis,
            "match_reason": oc.match_reason,
            "similarity_score": oc.similarity_score,
            "member_count": len(members),
            "origin": oc.origin,
            "locked": oc.locked,
            "members": [
                {
                    "record_source_id": str(m.record_source_id),
                    "source_id": str(m.source_id),
                    "source_name": m.source_name,
                    "role": m.role,
                    "added_by": m.added_by,
                    "note": m.note,
                    "title": m.orig_title or m.norm_title,
                    "year": m.match_year,
                    "doi": m.match_doi,
                }
                for m in members
            ],
        })

    return {
        "clusters": result,
        "page": page,
        "page_size": page_size,
        "total_items": total_items,
        "total_pages": total_pages,
    }


# ---------------------------------------------------------------------------
# GET /overlaps/preview — preview without writing
# ---------------------------------------------------------------------------

@router.get("/preview")
async def preview_overlap(
    project_id: uuid.UUID,
    strategy_id: uuid.UUID = Query(..., description="Strategy to use for preview"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Synchronously compute what an overlap detection run would find,
    without persisting anything.

    Returns within-source and cross-source cluster summaries.
    """
    await _require_project_access(project_id, current_user, db)

    strategy = await StrategyRepo.get_by_id(db, project_id, strategy_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")

    config = _resolve_config(strategy)
    rs_rows = await _fetch_rs_rows(db, project_id)

    snapshot = build_overlap_preview(rs_rows, config)

    return {
        "strategy_id": str(strategy_id),
        "strategy_name": strategy.name,
        "config": config.to_dict(),
        "within_source": {
            "cluster_count": len(snapshot.within_source_clusters),
            "duplicate_record_count": snapshot.within_source_duplicate_count,
            "clusters": [
                {
                    "match_tier": c.match_tier,
                    "match_basis": c.match_basis,
                    "match_reason": c.match_reason,
                    "similarity_score": c.similarity_score,
                    "member_count": c.member_count,
                    "source_ids": c.source_ids,
                    "titles": c.titles,
                    "dois": c.dois,
                }
                for c in snapshot.within_source_clusters
            ],
        },
        "cross_source": {
            "cluster_count": len(snapshot.cross_source_clusters),
            "overlap_record_count": snapshot.cross_source_overlap_count,
            "unique_overlapping_papers": snapshot.unique_overlapping_papers,
            "clusters": [
                {
                    "match_tier": c.match_tier,
                    "match_basis": c.match_basis,
                    "match_reason": c.match_reason,
                    "similarity_score": c.similarity_score,
                    "member_count": c.member_count,
                    "source_ids": c.source_ids,
                    "titles": c.titles,
                    "dois": c.dois,
                }
                for c in snapshot.cross_source_clusters
            ],
        },
    }


# ---------------------------------------------------------------------------
# GET /overlaps/visual-summary — NxN matrix for OverlapPage visualization
# ---------------------------------------------------------------------------

@router.get("/visual-summary")
async def get_visual_summary(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return a visual overlap summary for the project.

    Includes:
    - sources: ordered list of {id, name}
    - matrix: N×N symmetric matrix where cell [i][j] = number of cross_source
              clusters shared between source i and source j (diagonal = 0)
    - unique_counts: {source_id: unique_record_count}
    - top_intersections: top 10 source-combination groups by overlap count
    """
    await _require_project_access(project_id, current_user, db)
    return await build_visual_summary(db, project_id)


# ---------------------------------------------------------------------------
# GET /overlaps/intersections — multi-source source-combination counts
# ---------------------------------------------------------------------------

@router.get("/intersections")
async def get_intersections(
    project_id: uuid.UUID,
    top_n: int = Query(20, ge=1, le=100),
    min_size: int = Query(2, ge=2, le=20, description="Minimum number of sources in a combination"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return the top source-combination groups sorted by overlap cluster count.

    Each entry represents a distinct combination of sources (e.g. PubMed + Scopus + Embase)
    and the number of cross-source clusters that involve all sources in that combination.

    Use min_size=3 to restrict to three-way (or higher) intersections only.
    """
    await _require_project_access(project_id, current_user, db)
    source_rows = await OverlapRepo.source_totals_with_overlap(db, project_id)
    source_id_to_name = {r.id: r.name for r in source_rows}
    sources = [{"id": str(r.id), "name": r.name} for r in source_rows]
    cluster_source_sets = await OverlapRepo.cross_source_cluster_source_sets(db, project_id)
    intersections = compute_top_intersections(
        source_id_to_name, cluster_source_sets, top_n=top_n, min_size=min_size
    )
    return {"sources": sources, "intersections": intersections}


# ---------------------------------------------------------------------------
# POST /overlaps/manual-link — user-driven overlap linking
# ---------------------------------------------------------------------------

@router.post("/manual-link", response_model=ClusterSummaryResponse)
async def manual_link_records_endpoint(
    project_id: uuid.UUID,
    body: ManualLinkRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Manually link a set of records into a cross-source overlap cluster.

    - If both records are already in the same cluster: no-op, returns existing cluster.
    - If records are in two different unlocked clusters: merges them.
    - If a locked cluster is involved or 3+ clusters: creates a new manual cluster.
    - New manual clusters are locked by default (locked=True) so algorithm reruns
      will not alter them.
    """
    await _require_project_access(project_id, current_user, db)
    try:
        record_source_ids = [uuid.UUID(str(rid)) for rid in body.record_ids]
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid record_id: {exc}")
    try:
        summary = await manual_link_records(
            db=db,
            project_id=project_id,
            record_source_ids=record_source_ids,
            locked=body.locked,
            note=body.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await db.commit()
    return ClusterSummaryResponse(
        cluster_id=str(summary.cluster_id),
        scope=summary.scope,
        match_tier=summary.match_tier,
        match_basis=summary.match_basis,
        match_reason=summary.match_reason,
        similarity_score=summary.similarity_score,
        member_count=summary.member_count,
        source_ids=summary.source_ids,
        record_source_ids=summary.record_source_ids,
        origin=summary.origin,
        locked=summary.locked,
    )


# ---------------------------------------------------------------------------
# POST /overlaps/{cluster_id}/lock — set or clear the locked flag
# ---------------------------------------------------------------------------

@router.post("/{cluster_id}/lock", response_model=ClusterSummaryResponse)
async def lock_cluster_endpoint(
    project_id: uuid.UUID,
    cluster_id: uuid.UUID,
    body: ClusterLockRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Lock or unlock an overlap cluster. Locked clusters are not modified by algorithm reruns."""
    await _require_project_access(project_id, current_user, db)
    try:
        summary = await lock_cluster(db, project_id, cluster_id, body.locked)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    await db.commit()
    return ClusterSummaryResponse(
        cluster_id=str(summary.cluster_id),
        scope=summary.scope,
        match_tier=summary.match_tier,
        match_basis=summary.match_basis,
        match_reason=summary.match_reason,
        similarity_score=summary.similarity_score,
        member_count=summary.member_count,
        source_ids=summary.source_ids,
        record_source_ids=summary.record_source_ids,
        origin=summary.origin,
        locked=summary.locked,
    )


# ---------------------------------------------------------------------------
# DELETE /overlaps/{cluster_id}/members/{record_source_id}
# ---------------------------------------------------------------------------

@router.delete(
    "/{cluster_id}/members/{record_source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_cluster_member_endpoint(
    project_id: uuid.UUID,
    cluster_id: uuid.UUID,
    record_source_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Remove a user-added member from an overlap cluster.
    Only members with added_by='user' can be removed.
    """
    await _require_project_access(project_id, current_user, db)
    try:
        await remove_cluster_member(db, project_id, cluster_id, record_source_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await db.commit()
