"""
Overlap Resolution API endpoints.

POST /projects/{project_id}/overlaps/run        — Start an overlap detection job
GET  /projects/{project_id}/overlaps            — Get latest overlap summary
GET  /projects/{project_id}/overlaps/preview    — Preview overlaps without writing
GET  /projects/{project_id}/overlaps/clusters   — Detailed cluster list

The "Overlap Resolution" module has two conceptual engines:
  Within-Source Uniqueness  — duplicates within a single source file
  Cross-Source Overlap      — same paper in multiple sources

Both use the same TieredClusterBuilder (Union-Find, three tiers) and differ
only in how clusters are classified by source membership.
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
from app.repositories.project_repo import ProjectRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.overlap_service import (
    build_overlap_snapshot,
    _build_source_records,
)
from app.utils.match_keys import StrategyConfig

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


def _resolve_config(strategy: MatchStrategy) -> StrategyConfig:
    config_dict = strategy.config or {}
    return StrategyConfig.from_dict(config_dict) if config_dict else StrategyConfig.from_preset(strategy.preset)


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

    The job detects:
    - Within-source duplicates (same paper twice in one source file)
    - Cross-source overlaps (same paper in multiple sources)

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
    - Per-source record totals
    - Pairwise source overlap (legacy, computed from canonical record_id)
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

    # Per-source totals
    source_rows = (
        await db.execute(
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
    ).all()

    # Pairwise overlap (legacy: canonical record_id self-join)
    rs_a = RecordSource.__table__.alias("rs_a")
    rs_b = RecordSource.__table__.alias("rs_b")
    s_a = Source.__table__.alias("s_a")
    s_b = Source.__table__.alias("s_b")

    pair_rows = (
        await db.execute(
            select(
                rs_a.c.source_id.label("source_a_id"),
                s_a.c.name.label("source_a_name"),
                rs_b.c.source_id.label("source_b_id"),
                s_b.c.name.label("source_b_name"),
                func.count().label("shared_records"),
            )
            .select_from(rs_a)
            .join(
                rs_b,
                (rs_b.c.record_id == rs_a.c.record_id)
                & (rs_b.c.source_id > rs_a.c.source_id),
            )
            .join(s_a, s_a.c.id == rs_a.c.source_id)
            .join(s_b, s_b.c.id == rs_b.c.source_id)
            .join(
                Record,
                (Record.id == rs_a.c.record_id)
                & (Record.project_id == project_id),
            )
            .group_by(
                rs_a.c.source_id,
                s_a.c.name,
                rs_b.c.source_id,
                s_b.c.name,
            )
            .order_by(func.count().desc())
        )
    ).all()

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
            }
            for r in source_rows
        ],
        "pairs": [
            {
                "source_a_id": str(r.source_a_id),
                "source_a_name": r.source_a_name,
                "source_b_id": str(r.source_b_id),
                "source_b_name": r.source_b_name,
                "shared_records": r.shared_records,
            }
            for r in pair_rows
        ],
    }


# ---------------------------------------------------------------------------
# GET /overlaps/clusters — detailed cluster listing
# ---------------------------------------------------------------------------

@router.get("/clusters")
async def list_overlap_clusters(
    project_id: uuid.UUID,
    scope: Optional[str] = Query(None, description="Filter by scope: 'within_source' | 'cross_source'"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List detected overlap clusters with member details.

    Use ?scope=within_source to see intra-source duplicates.
    Use ?scope=cross_source to see cross-database overlaps.
    """
    await _require_project_access(project_id, current_user, db)

    q = select(OverlapCluster).where(OverlapCluster.project_id == project_id)
    if scope:
        q = q.where(OverlapCluster.scope == scope)
    q = q.order_by(OverlapCluster.created_at.desc()).offset(offset).limit(limit)

    clusters = (await db.execute(q)).scalars().all()

    result = []
    for oc in clusters:
        # Fetch members for this cluster
        members = (
            await db.execute(
                select(
                    OverlapClusterMember.record_source_id,
                    OverlapClusterMember.source_id,
                    OverlapClusterMember.role,
                    RecordSource.norm_title,
                    RecordSource.match_doi,
                    Source.name.label("source_name"),
                )
                .join(
                    RecordSource,
                    RecordSource.id == OverlapClusterMember.record_source_id,
                )
                .join(Source, Source.id == OverlapClusterMember.source_id)
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
            "members": [
                {
                    "record_source_id": str(m.record_source_id),
                    "source_id": str(m.source_id),
                    "source_name": m.source_name,
                    "role": m.role,
                    "title": m.norm_title,
                    "doi": m.match_doi,
                }
                for m in members
            ],
        })

    return {"clusters": result, "offset": offset, "limit": limit}


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

    sources, source_id_map = _build_source_records(rs_rows)
    snapshot = build_overlap_snapshot(sources, source_id_map, config)

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
