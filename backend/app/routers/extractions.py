"""Extraction library endpoints (Sprint 13).

GET /projects/{project_id}/extractions          → ExtractionLibraryItem[]
GET /projects/{project_id}/extractions/{id}     → ExtractionLibraryItem

For owners/admins: returns all included papers with each reviewer's extraction
(or all reviewers when no ?reviewer_id= is supplied).  An optional
?reviewer_id= UUID param scopes to one reviewer's work.

For reviewers/observers: always scoped to their own extractions; papers they
have been assigned (via permissions.record_ids) that they haven't extracted yet
still appear so they know what work remains.

Papers included at TA+FT but not yet extracted appear with extracted_json=null
and extracted=false.  Already-extracted papers have extracted=true.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, ANY_ROLE, ADMIN_ROLE
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.team_repo import TeamRepo

router = APIRouter(prefix="/projects/{project_id}/extractions", tags=["extractions"])

# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

# Drive from included_items so unextracted papers still appear.
# extraction_records is LEFT-JOINed, filtered to the requested reviewer.
# Papers not yet extracted have er.* columns = NULL → extracted=false.
_LIST_SQL = text("""
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
),
included_items AS (
    SELECT record_id, cluster_id
    FROM screening_decisions
    WHERE project_id = :project_id
      AND stage = 'TA'
      AND decision = 'include'
    INTERSECT
    SELECT record_id, cluster_id
    FROM screening_decisions
    WHERE project_id = :project_id
      AND stage = 'FT'
      AND decision = 'include'
)
SELECT
    er.id,
    COALESCE(er.record_id,  ii.record_id)  AS record_id,
    COALESCE(er.cluster_id, ii.cluster_id) AS cluster_id,
    er.extracted_json,
    er.reviewer_id,
    er.created_at,
    COALESCE(r.title,   cr.title)   AS title,
    COALESCE(r.authors, cr.authors) AS authors,
    COALESCE(r.year,    cr.year)    AS year,
    COALESCE(r.doi,     cr.doi)     AS doi,
    array_remove(array_agg(DISTINCT s.name), NULL) AS source_names
FROM included_items ii
LEFT JOIN extraction_records er
    ON (
        (ii.record_id  IS NOT NULL AND er.record_id  = ii.record_id  AND er.cluster_id  IS NULL)
     OR (ii.cluster_id IS NOT NULL AND er.cluster_id = ii.cluster_id AND er.record_id   IS NULL)
    )
    AND er.project_id = :project_id
    AND (CAST(:reviewer_id AS UUID) IS NULL OR er.reviewer_id = CAST(:reviewer_id AS UUID))
LEFT JOIN records r        ON r.id  = COALESCE(er.record_id, ii.record_id)
LEFT JOIN cluster_reps cr  ON cr.cluster_id = COALESCE(er.cluster_id, ii.cluster_id)
LEFT JOIN record_sources rs2
       ON rs2.record_id = COALESCE(er.record_id, cr.rep_record_id, ii.record_id)
LEFT JOIN sources s        ON s.id  = rs2.source_id
GROUP BY
    er.id, er.record_id, er.cluster_id, er.extracted_json,
    er.reviewer_id, er.created_at,
    ii.record_id, ii.cluster_id,
    r.title, r.authors, r.year, r.doi,
    cr.title, cr.authors, cr.year, cr.doi
ORDER BY er.created_at ASC NULLS LAST, COALESCE(r.title, cr.title) ASC NULLS LAST
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
),
included_items AS (
    SELECT record_id, cluster_id
    FROM screening_decisions
    WHERE project_id = :project_id
      AND stage = 'TA'
      AND decision = 'include'
    INTERSECT
    SELECT record_id, cluster_id
    FROM screening_decisions
    WHERE project_id = :project_id
      AND stage = 'FT'
      AND decision = 'include'
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
JOIN included_items ii
  ON (er.record_id  IS NOT NULL AND ii.record_id  = er.record_id  AND ii.cluster_id  IS NULL)
  OR (er.cluster_id IS NOT NULL AND ii.cluster_id = er.cluster_id AND er.record_id   IS NULL)
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


def _row_to_dict(row: Any, project_id: uuid.UUID) -> Dict[str, Any]:
    extracted = row.extracted_json is not None
    return {
        "id":             str(row.id) if row.id else None,
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
        "extracted":      extracted,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_extractions(
    project_id: uuid.UUID,
    reviewer_id: Optional[uuid.UUID] = Query(None, description="Filter by reviewer (owner/admin only)"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return included papers enriched with extraction data.

    Owners/admins see all papers (optionally filtered to one reviewer via
    ?reviewer_id=).  Reviewers see only their own extractions and only their
    assigned papers (permissions.record_ids).
    """
    role = await require_project_role(db, project_id, current_user.id, allowed=ANY_ROLE)

    if role in ADMIN_ROLE:
        effective_reviewer_id: Optional[uuid.UUID] = reviewer_id
        allowed_record_ids: Optional[set] = None
    else:
        effective_reviewer_id = current_user.id
        member = await TeamRepo.get_member(db, project_id, current_user.id)
        allowed_record_ids = None
        if member and member.permissions:
            raw_ids = member.permissions.get("record_ids")
            if raw_ids:
                allowed_record_ids = {uuid.UUID(r) for r in raw_ids}

    result = await db.execute(
        _LIST_SQL,
        {"project_id": project_id, "reviewer_id": effective_reviewer_id},
    )
    rows = [_row_to_dict(r, project_id) for r in result.mappings().all()]

    if allowed_record_ids is not None:
        rows = [
            r for r in rows
            if r["record_id"] and uuid.UUID(r["record_id"]) in allowed_record_ids
        ]

    return rows


@router.get("/{extraction_id}")
async def get_extraction(
    project_id: uuid.UUID,
    extraction_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return a single extraction record enriched with article metadata."""
    await require_project_role(db, project_id, current_user.id, allowed=ANY_ROLE)
    result = await db.execute(
        _SINGLE_SQL,
        {"project_id": project_id, "extraction_id": extraction_id},
    )
    row = result.mappings().one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Extraction not found")
    return _row_to_dict(row, project_id)
