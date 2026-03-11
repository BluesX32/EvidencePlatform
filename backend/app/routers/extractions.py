"""Extraction library endpoints (Sprint 13).

GET /projects/{project_id}/extractions          → ExtractionLibraryItem[]
GET /projects/{project_id}/extractions/{id}     → ExtractionLibraryItem

These endpoints join extraction_records with article metadata (title, authors, year,
doi, source_names) so the frontend can render the library without extra round-trips.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, ANY_ROLE
from app.models.user import User
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects/{project_id}/extractions", tags=["extractions"])

# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

_LIST_SQL = text("""
WITH cluster_reps AS (
    -- Pick the first member record for each cluster (representative title/authors/etc)
    SELECT DISTINCT ON (ocm.cluster_id)
        ocm.cluster_id,
        r.id  AS rep_record_id,
        r.title,
        r.authors,
        r.year,
        r.doi
    FROM overlap_cluster_members ocm
    JOIN record_sources rs ON rs.id = ocm.record_source_id
    JOIN records r         ON r.id  = rs.record_id
    ORDER BY ocm.cluster_id, ocm.id
)
SELECT
    er.id,
    er.record_id,
    er.cluster_id,
    er.extracted_json,
    er.reviewer_id,
    er.created_at,
    COALESCE(r.title,   cr.title)   AS title,
    COALESCE(r.authors, cr.authors) AS authors,
    COALESCE(r.year,    cr.year)    AS year,
    COALESCE(r.doi,     cr.doi)     AS doi,
    array_remove(array_agg(DISTINCT s.name), NULL) AS source_names
FROM extraction_records er
LEFT JOIN records r        ON r.id  = er.record_id
LEFT JOIN cluster_reps cr  ON cr.cluster_id = er.cluster_id
LEFT JOIN record_sources rs2
       ON rs2.record_id = COALESCE(er.record_id, cr.rep_record_id)
LEFT JOIN sources s        ON s.id  = rs2.source_id
WHERE er.project_id = :project_id
GROUP BY
    er.id, er.record_id, er.cluster_id, er.extracted_json,
    er.reviewer_id, er.created_at,
    r.title, r.authors, r.year, r.doi,
    cr.title, cr.authors, cr.year, cr.doi
ORDER BY er.created_at DESC
""")

_SINGLE_SQL = text("""
WITH cluster_reps AS (
    SELECT DISTINCT ON (ocm.cluster_id)
        ocm.cluster_id,
        r.id  AS rep_record_id,
        r.title,
        r.authors,
        r.year,
        r.doi
    FROM overlap_cluster_members ocm
    JOIN record_sources rs ON rs.id = ocm.record_source_id
    JOIN records r         ON r.id  = rs.record_id
    ORDER BY ocm.cluster_id, ocm.id
)
SELECT
    er.id,
    er.record_id,
    er.cluster_id,
    er.extracted_json,
    er.reviewer_id,
    er.created_at,
    COALESCE(r.title,   cr.title)   AS title,
    COALESCE(r.authors, cr.authors) AS authors,
    COALESCE(r.year,    cr.year)    AS year,
    COALESCE(r.doi,     cr.doi)     AS doi,
    array_remove(array_agg(DISTINCT s.name), NULL) AS source_names
FROM extraction_records er
LEFT JOIN records r        ON r.id  = er.record_id
LEFT JOIN cluster_reps cr  ON cr.cluster_id = er.cluster_id
LEFT JOIN record_sources rs2
       ON rs2.record_id = COALESCE(er.record_id, cr.rep_record_id)
LEFT JOIN sources s        ON s.id  = rs2.source_id
WHERE er.project_id = :project_id
  AND er.id = :extraction_id
GROUP BY
    er.id, er.record_id, er.cluster_id, er.extracted_json,
    er.reviewer_id, er.created_at,
    r.title, r.authors, r.year, r.doi,
    cr.title, cr.authors, cr.year, cr.doi
""")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _require_project(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    await require_project_role(db, project_id, current_user.id, allowed=ANY_ROLE)
    project = await ProjectRepo.get_by_id(db, project_id)
    return project


def _row_to_dict(row: Any, project_id: uuid.UUID) -> Dict[str, Any]:
    return {
        "id":             str(row.id),
        "project_id":     str(project_id),
        "record_id":      str(row.record_id) if row.record_id else None,
        "cluster_id":     str(row.cluster_id) if row.cluster_id else None,
        "extracted_json": row.extracted_json,
        "reviewer_id":    str(row.reviewer_id) if row.reviewer_id else None,
        "created_at":     row.created_at,
        "title":          row.title,
        "authors":        list(row.authors) if row.authors else [],
        "year":           row.year,
        "doi":            row.doi,
        "source_names":   list(row.source_names) if row.source_names else [],
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_extractions(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all extraction records for a project, enriched with article metadata."""
    await _require_project(project_id, current_user, db)
    result = await db.execute(_LIST_SQL, {"project_id": project_id})
    return [_row_to_dict(r, project_id) for r in result.mappings().all()]


@router.get("/{extraction_id}")
async def get_extraction(
    project_id: uuid.UUID,
    extraction_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return a single extraction record enriched with article metadata."""
    await _require_project(project_id, current_user, db)
    result = await db.execute(
        _SINGLE_SQL,
        {"project_id": project_id, "extraction_id": extraction_id},
    )
    row = result.mappings().one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Extraction not found")
    return _row_to_dict(row, project_id)
