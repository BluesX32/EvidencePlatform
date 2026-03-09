"""Label management and assignment endpoints (Sprint 15 / migration 013).

Label definitions (project-scoped):
  GET    /projects/{project_id}/labels                → list labels
  POST   /projects/{project_id}/labels                → create label
  PATCH  /projects/{project_id}/labels/{label_id}     → rename / recolor
  DELETE /projects/{project_id}/labels/{label_id}     → delete label + all assignments

Label assignments:
  POST   /projects/{project_id}/labels/assign         → assign label to record/cluster
  DELETE /projects/{project_id}/labels/assign         → remove assignment

Labeled article view:
  GET    /projects/{project_id}/labels/articles       → articles enriched with labels
                                                         ?label_id=  (filter by one label)
                                                         ?record_id= | ?cluster_id= (single item)

Item labels (used by ScreeningWorkspace):
  GET    /projects/{project_id}/labels/item           → labels for a single record/cluster
                                                         ?record_id= | ?cluster_id=
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.project_label import ProjectLabel
from app.models.record_label import RecordLabel
from app.models.user import User
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects/{project_id}/labels", tags=["labels"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _require_project(
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


def _label_out(lbl: ProjectLabel) -> Dict[str, Any]:
    return {
        "id": str(lbl.id),
        "project_id": str(lbl.project_id),
        "name": lbl.name,
        "color": lbl.color,
        "created_at": lbl.created_at,
    }


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class LabelCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field("#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")


class LabelUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")


class AssignRequest(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    label_id: uuid.UUID


class UnassignRequest(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    label_id: uuid.UUID


# ---------------------------------------------------------------------------
# Label definition endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_labels(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Return all labels for a project, ordered by name."""
    await _require_project(project_id, current_user, db)
    rows = await db.execute(
        select(ProjectLabel)
        .where(ProjectLabel.project_id == project_id)
        .order_by(ProjectLabel.name)
    )
    return [_label_out(lbl) for lbl in rows.scalars().all()]


@router.post("", status_code=201)
async def create_label(
    project_id: uuid.UUID,
    body: LabelCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Create a new label. Name must be unique within the project."""
    await _require_project(project_id, current_user, db)
    lbl = ProjectLabel(
        project_id=project_id,
        name=body.name.strip(),
        color=body.color,
    )
    db.add(lbl)
    try:
        await db.flush()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail=f"Label '{body.name}' already exists in this project"
        )
    return _label_out(lbl)


@router.patch("/{label_id}")
async def update_label(
    project_id: uuid.UUID,
    label_id: uuid.UUID,
    body: LabelUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Rename or recolor an existing label."""
    await _require_project(project_id, current_user, db)
    row = await db.execute(
        select(ProjectLabel).where(
            ProjectLabel.id == label_id,
            ProjectLabel.project_id == project_id,
        )
    )
    lbl = row.scalar_one_or_none()
    if lbl is None:
        raise HTTPException(status_code=404, detail="Label not found")
    if body.name is not None:
        lbl.name = body.name.strip()
    if body.color is not None:
        lbl.color = body.color
    try:
        await db.flush()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail=f"Label '{body.name}' already exists in this project"
        )
    return _label_out(lbl)


@router.delete("/{label_id}", status_code=204)
async def delete_label(
    project_id: uuid.UUID,
    label_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a label and all its assignments."""
    await _require_project(project_id, current_user, db)
    row = await db.execute(
        select(ProjectLabel).where(
            ProjectLabel.id == label_id,
            ProjectLabel.project_id == project_id,
        )
    )
    lbl = row.scalar_one_or_none()
    if lbl is None:
        raise HTTPException(status_code=404, detail="Label not found")
    await db.delete(lbl)
    await db.commit()


# ---------------------------------------------------------------------------
# Assignment endpoints
# ---------------------------------------------------------------------------


@router.post("/assign", status_code=201)
async def assign_label(
    project_id: uuid.UUID,
    body: AssignRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Assign a label to a record or cluster. Idempotent — returns 200 if already assigned."""
    await _require_project(project_id, current_user, db)
    if body.record_id is None and body.cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Provide exactly one of record_id or cluster_id"
        )
    if body.record_id is not None and body.cluster_id is not None:
        raise HTTPException(
            status_code=422, detail="Provide record_id OR cluster_id, not both"
        )

    # Verify label belongs to project
    lbl_row = await db.execute(
        select(ProjectLabel).where(
            ProjectLabel.id == body.label_id,
            ProjectLabel.project_id == project_id,
        )
    )
    if lbl_row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Label not found")

    # Check if already assigned
    q = select(RecordLabel).where(
        RecordLabel.project_id == project_id,
        RecordLabel.label_id == body.label_id,
    )
    if body.record_id is not None:
        q = q.where(RecordLabel.record_id == body.record_id)
    else:
        q = q.where(RecordLabel.cluster_id == body.cluster_id)
    existing = (await db.execute(q)).scalar_one_or_none()
    if existing is not None:
        return {"id": str(existing.id), "already_assigned": True}

    rl = RecordLabel(
        project_id=project_id,
        record_id=body.record_id,
        cluster_id=body.cluster_id,
        label_id=body.label_id,
        reviewer_id=current_user.id,
    )
    db.add(rl)
    await db.flush()
    await db.commit()
    return {"id": str(rl.id), "already_assigned": False}


@router.delete("/assign", status_code=204)
async def unassign_label(
    project_id: uuid.UUID,
    body: UnassignRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a label assignment from a record or cluster."""
    await _require_project(project_id, current_user, db)
    if body.record_id is None and body.cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Provide exactly one of record_id or cluster_id"
        )
    q = select(RecordLabel).where(
        RecordLabel.project_id == project_id,
        RecordLabel.label_id == body.label_id,
    )
    if body.record_id is not None:
        q = q.where(RecordLabel.record_id == body.record_id)
    else:
        q = q.where(RecordLabel.cluster_id == body.cluster_id)
    row = (await db.execute(q)).scalar_one_or_none()
    if row is not None:
        await db.delete(row)
        await db.commit()


# ---------------------------------------------------------------------------
# Item labels (single-item fetch for ScreeningWorkspace)
# ---------------------------------------------------------------------------


@router.get("/item")
async def get_item_labels(
    project_id: uuid.UUID,
    record_id: Optional[str] = None,
    cluster_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Return all labels assigned to a specific record or cluster."""
    await _require_project(project_id, current_user, db)
    if record_id is None and cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Provide record_id or cluster_id"
        )

    if record_id:
        try:
            rid = uuid.UUID(record_id)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid record_id")
        q = (
            select(ProjectLabel)
            .join(RecordLabel, RecordLabel.label_id == ProjectLabel.id)
            .where(
                RecordLabel.project_id == project_id,
                RecordLabel.record_id == rid,
            )
            .order_by(ProjectLabel.name)
        )
    else:
        try:
            cid = uuid.UUID(cluster_id)  # type: ignore[arg-type]
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid cluster_id")
        q = (
            select(ProjectLabel)
            .join(RecordLabel, RecordLabel.label_id == ProjectLabel.id)
            .where(
                RecordLabel.project_id == project_id,
                RecordLabel.cluster_id == cid,
            )
            .order_by(ProjectLabel.name)
        )

    rows = await db.execute(q)
    return [_label_out(lbl) for lbl in rows.scalars().all()]


# ---------------------------------------------------------------------------
# Labeled articles view
# ---------------------------------------------------------------------------

# Raw SQL for the enriched article list — joins records/clusters with their labels.
_ARTICLES_SQL = text(
    """
    WITH labeled_records AS (
        SELECT
            rl.record_id,
            rl.cluster_id,
            rl.project_id,
            json_agg(
                json_build_object(
                    'id',         pl.id,
                    'name',       pl.name,
                    'color',      pl.color
                )
                ORDER BY pl.name
            ) AS labels
        FROM record_labels rl
        JOIN project_labels pl ON pl.id = rl.label_id
        WHERE rl.project_id = :project_id
          AND (:label_id IS NULL OR rl.label_id = :label_id::uuid)
        GROUP BY rl.record_id, rl.cluster_id, rl.project_id
    ),
    enriched AS (
        -- Records directly labeled
        SELECT
            lr.record_id,
            lr.cluster_id,
            r.title,
            r.year,
            r.doi,
            COALESCE(
                (SELECT array_agg(DISTINCT s.name ORDER BY s.name)
                 FROM record_sources rs2
                 JOIN sources s ON s.id = rs2.source_id
                 WHERE rs2.record_id = lr.record_id),
                ARRAY[]::text[]
            ) AS source_names,
            COALESCE(r.authors, ARRAY[]::text[]) AS authors,
            lr.labels
        FROM labeled_records lr
        JOIN records r ON r.id = lr.record_id
        WHERE lr.record_id IS NOT NULL
          AND (:record_id IS NULL OR lr.record_id = :record_id::uuid)
          AND (:cluster_id IS NULL OR FALSE)

        UNION ALL

        -- Cluster-level labels — resolve to canonical record for metadata
        SELECT
            lr.record_id,
            lr.cluster_id,
            r.title,
            r.year,
            r.doi,
            COALESCE(
                (SELECT array_agg(DISTINCT s.name ORDER BY s.name)
                 FROM overlap_cluster_members ocm2
                 JOIN record_sources rs3 ON rs3.id = ocm2.record_source_id
                 JOIN sources s ON s.id = rs3.source_id
                 WHERE ocm2.cluster_id = lr.cluster_id),
                ARRAY[]::text[]
            ) AS source_names,
            COALESCE(r.authors, ARRAY[]::text[]) AS authors,
            lr.labels
        FROM labeled_records lr
        JOIN overlap_cluster_members ocm ON ocm.cluster_id = lr.cluster_id AND ocm.role = 'canonical'
        JOIN record_sources rs ON rs.id = ocm.record_source_id
        JOIN records r ON r.id = rs.record_id
        WHERE lr.cluster_id IS NOT NULL
          AND (:cluster_id IS NULL OR lr.cluster_id = :cluster_id::uuid)
          AND (:record_id IS NULL OR FALSE)
    )
    SELECT *
    FROM enriched
    ORDER BY year DESC NULLS LAST, title ASC NULLS LAST
    LIMIT :limit OFFSET :offset
    """
)

_ARTICLES_COUNT_SQL = text(
    """
    SELECT COUNT(*) FROM record_labels rl
    WHERE rl.project_id = :project_id
      AND (:label_id IS NULL OR rl.label_id = :label_id::uuid)
      AND (:record_id IS NULL OR rl.record_id = :record_id::uuid)
      AND (:cluster_id IS NULL OR rl.cluster_id = :cluster_id::uuid)
    """
)


@router.get("/articles")
async def list_labeled_articles(
    project_id: uuid.UUID,
    label_id: Optional[str] = None,
    record_id: Optional[str] = None,
    cluster_id: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Return articles that have at least one label, enriched with metadata.

    Supports optional filtering by label_id, record_id, or cluster_id.
    """
    await _require_project(project_id, current_user, db)
    page = max(1, page)
    page_size = max(1, min(200, page_size))

    params = {
        "project_id": str(project_id),
        "label_id": label_id,
        "record_id": record_id,
        "cluster_id": cluster_id,
        "limit": page_size,
        "offset": (page - 1) * page_size,
    }

    count_params = {k: v for k, v in params.items() if k not in ("limit", "offset")}
    total = (await db.execute(_ARTICLES_COUNT_SQL, count_params)).scalar_one()

    rows = (await db.execute(_ARTICLES_SQL, params)).mappings().all()

    articles = [
        {
            "record_id": str(r["record_id"]) if r["record_id"] else None,
            "cluster_id": str(r["cluster_id"]) if r["cluster_id"] else None,
            "title": r["title"],
            "year": r["year"],
            "doi": r["doi"],
            "authors": list(r["authors"]) if r["authors"] else [],
            "source_names": list(r["source_names"]) if r["source_names"] else [],
            "labels": r["labels"] if r["labels"] else [],
        }
        for r in rows
    ]

    return {
        "articles": articles,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, -(-total // page_size)),
    }