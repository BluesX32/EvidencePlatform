"""
Direct project-level screening service (migration 009+).

All SQL filtering via CTEs.  No Python-side list manipulation for availability logic.

Public API:
  get_project_sources_with_stats(db, project_id) → List[Dict]
  get_next_item(db, project_id, source_id, mode, reviewer_id) → Dict
  submit_decision(db, project_id, record_id, cluster_id, stage, decision,
                  reason_code, notes, reviewer_id) → Dict
  submit_extraction(db, project_id, record_id, cluster_id, extracted_json,
                    reviewer_id) → Dict

Canonical key helpers (kept for backward compatibility with existing tests):
  _resolve_canonical_key(record_id, cluster_map) → str
  _build_cluster_map(db, project_id, record_ids) → Dict
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.extraction_record import ExtractionRecord
from app.models.overlap_cluster import OverlapCluster
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_claim import ScreeningClaim
from app.models.screening_decision import ScreeningDecision
from app.models.source import Source

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Canonical key helpers (pure — importable for tests)
# ---------------------------------------------------------------------------

def _resolve_canonical_key(
    record_id: uuid.UUID, cluster_map: Dict[uuid.UUID, uuid.UUID]
) -> str:
    """Return "pg:{cluster_id}" if in a cross-source cluster, else "rec:{record_id}"."""
    cluster_id = cluster_map.get(record_id)
    if cluster_id is not None:
        return f"pg:{cluster_id}"
    return f"rec:{record_id}"


async def _build_cluster_map(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_ids: List[uuid.UUID],
) -> Dict[uuid.UUID, uuid.UUID]:
    """Return {record_id: cluster_id} for records in a cross-source cluster."""
    if not record_ids:
        return {}
    result = await db.execute(
        select(RecordSource.record_id, OverlapClusterMember.cluster_id)
        .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
        .join(OverlapCluster, OverlapCluster.id == OverlapClusterMember.cluster_id)
        .where(
            OverlapCluster.project_id == project_id,
            OverlapCluster.scope == "cross_source",
            RecordSource.record_id.in_(record_ids),
        )
    )
    cluster_map: Dict[uuid.UUID, uuid.UUID] = {}
    for row in result.all():
        if row.record_id not in cluster_map:
            cluster_map[row.record_id] = row.cluster_id
    return cluster_map


# ---------------------------------------------------------------------------
# Sources with stats
# ---------------------------------------------------------------------------

async def get_project_sources_with_stats(
    db: AsyncSession,
    project_id: uuid.UUID,
) -> List[Dict]:
    """
    Return per-source stats + one aggregate "all" row.

    For each source:
      record_count    — unique screening slots (clusters + standalones from this source)
      ta_screened     — # unique slots with a TA decision (project-wide)
      ta_included     — # unique slots with TA include decision
      ft_screened     — # unique slots with a FT decision
      ft_included     — # unique slots with FT include decision
      extracted_count — # unique slots with an extraction record
    """
    # 1. Get sources
    src_result = await db.execute(
        select(Source).where(Source.project_id == project_id).order_by(Source.name)
    )
    sources = src_result.scalars().all()

    # 2. Get all records in project with their cross-source cluster (if any)
    #    result: list of (record_id, cluster_id_or_None)
    records_result = await db.execute(
        select(
            Record.id.label("record_id"),
            OverlapCluster.id.label("cluster_id"),
        )
        .outerjoin(RecordSource, RecordSource.record_id == Record.id)
        .outerjoin(
            OverlapClusterMember,
            OverlapClusterMember.record_source_id == RecordSource.id,
        )
        .outerjoin(
            OverlapCluster,
            (OverlapCluster.id == OverlapClusterMember.cluster_id)
            & (OverlapCluster.scope == "cross_source"),
        )
        .where(Record.project_id == project_id)
        .distinct()
    )
    record_rows = records_result.all()

    # Build: slot_id → "cluster:<uuid>" or "record:<uuid>"
    # A record in a cross-source cluster contributes its cluster_id as the slot.
    record_to_slot: Dict[uuid.UUID, str] = {}
    for row in record_rows:
        if row.cluster_id is not None:
            record_to_slot[row.record_id] = f"cluster:{row.cluster_id}"
        else:
            record_to_slot[row.record_id] = f"record:{row.record_id}"

    # 3. Build source → set-of-slot-ids
    source_slots: Dict[uuid.UUID, set] = {s.id: set() for s in sources}
    all_slots: set = set()

    if record_to_slot:
        # Get record_id → source_ids mapping
        rs_result = await db.execute(
            select(RecordSource.record_id, RecordSource.source_id)
            .join(Record, Record.id == RecordSource.record_id)
            .where(Record.project_id == project_id)
        )
        for row in rs_result.all():
            slot = record_to_slot.get(row.record_id)
            if slot is not None:
                all_slots.add(slot)
                if row.source_id in source_slots:
                    source_slots[row.source_id].add(slot)

    # 4. Get decision counts (all decisions for this project, keyed by slot)
    #    For simplicity: count at project level (not per-reviewer)
    sd_result = await db.execute(
        select(
            ScreeningDecision.record_id,
            ScreeningDecision.cluster_id,
            ScreeningDecision.stage,
            ScreeningDecision.decision,
        )
        .where(ScreeningDecision.project_id == project_id)
    )
    sd_rows = sd_result.all()

    # Aggregate per slot
    ta_screened_slots: set = set()
    ta_included_slots: set = set()
    ft_screened_slots: set = set()
    ft_included_slots: set = set()

    for row in sd_rows:
        if row.record_id is not None:
            slot = f"record:{row.record_id}"
        else:
            slot = f"cluster:{row.cluster_id}"
        if row.stage == "TA":
            ta_screened_slots.add(slot)
            if row.decision == "include":
                ta_included_slots.add(slot)
        elif row.stage == "FT":
            ft_screened_slots.add(slot)
            if row.decision == "include":
                ft_included_slots.add(slot)

    # 5. Get extraction counts
    er_result = await db.execute(
        select(ExtractionRecord.record_id, ExtractionRecord.cluster_id)
        .where(ExtractionRecord.project_id == project_id)
    )
    extracted_slots: set = set()
    for row in er_result.all():
        if row.record_id is not None:
            extracted_slots.add(f"record:{row.record_id}")
        else:
            extracted_slots.add(f"cluster:{row.cluster_id}")

    # 6. Build per-source stats
    def _stats(slots: set) -> Dict:
        ta_s = len(slots & ta_screened_slots)
        ta_i = len(slots & ta_included_slots)
        ft_s = len(slots & ft_screened_slots)
        ft_i = len(slots & ft_included_slots)
        ex   = len(slots & extracted_slots)
        return {
            "record_count": len(slots),
            "ta_screened": ta_s,
            "ta_included": ta_i,
            "ft_screened": ft_s,
            "ft_included": ft_i,
            "extracted_count": ex,
        }

    result_list: List[Dict] = [
        {"id": str(s.id), "name": s.name, **_stats(source_slots[s.id])}
        for s in sources
    ]
    # Aggregate "all" row
    result_list.append({"id": "all", "name": "All databases (deduplicated)", **_stats(all_slots)})
    return result_list


# ---------------------------------------------------------------------------
# Next item (CTE-based, concurrency-safe)
# ---------------------------------------------------------------------------

_NEXT_ITEM_SQL = text("""
WITH
  -- Records whose source is in scope (all records if source_id is NULL)
  records_in_scope AS (
    SELECT DISTINCT r.id AS record_id, r.created_at
    FROM records r
    JOIN record_sources rs ON rs.record_id = r.id
    WHERE r.project_id = :project_id
      AND (:source_id IS NULL OR rs.source_id = :source_id)
  ),
  -- Records that belong to a cross-source cluster (used to identify standalones)
  clustered_records AS (
    SELECT DISTINCT rs.record_id
    FROM record_sources rs
    JOIN overlap_cluster_members ocm ON ocm.record_source_id = rs.id
    JOIN overlap_clusters oc ON oc.id = ocm.cluster_id
    WHERE oc.project_id = :project_id AND oc.scope = 'cross_source'
  ),
  -- Standalone records: in scope but not in any cross-source cluster
  standalone_in_scope AS (
    SELECT ris.record_id, ris.created_at
    FROM records_in_scope ris
    WHERE ris.record_id NOT IN (SELECT record_id FROM clustered_records)
  ),
  -- Cross-source clusters that contain at least one in-scope record
  clusters_in_scope AS (
    SELECT DISTINCT oc.id AS cluster_id, MIN(r.created_at) AS created_at
    FROM overlap_clusters oc
    JOIN overlap_cluster_members ocm ON ocm.cluster_id = oc.id
    JOIN record_sources rs ON rs.id = ocm.record_source_id
    JOIN records r ON r.id = rs.record_id
    JOIN records_in_scope ris ON ris.record_id = r.id
    WHERE oc.project_id = :project_id AND oc.scope = 'cross_source'
    GROUP BY oc.id
  ),
  -- Active (non-stale) claims
  active_claims AS (
    SELECT record_id, cluster_id
    FROM screening_claims
    WHERE project_id = :project_id
      AND claimed_at > now() - interval '30 minutes'
  ),
  -- Available standalone records (mode-filtered, not claimed)
  available_standalone AS (
    SELECT NULL::uuid AS cluster_id, s.record_id, s.created_at
    FROM standalone_in_scope s
    WHERE s.record_id NOT IN (
        SELECT record_id FROM active_claims WHERE record_id IS NOT NULL
      )
      AND (
        (
          :mode = 'screen'
          AND NOT EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.record_id = s.record_id
              AND sd.stage = 'TA'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
        )
        OR (
          :mode = 'fulltext'
          AND EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.record_id = s.record_id
              AND sd.stage = 'TA'
              AND sd.decision = 'include'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.record_id = s.record_id
              AND sd.stage = 'FT'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
        )
        OR (
          :mode = 'extract'
          AND EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.record_id = s.record_id
              AND sd.stage = 'FT'
              AND sd.decision = 'include'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM extraction_records er
            WHERE er.project_id = :project_id
              AND er.record_id = s.record_id
          )
        )
      )
  ),
  -- Available clusters (mode-filtered, not claimed)
  available_clusters AS (
    SELECT c.cluster_id, NULL::uuid AS record_id, c.created_at
    FROM clusters_in_scope c
    WHERE c.cluster_id NOT IN (
        SELECT cluster_id FROM active_claims WHERE cluster_id IS NOT NULL
      )
      AND (
        (
          :mode = 'screen'
          AND NOT EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.cluster_id = c.cluster_id
              AND sd.stage = 'TA'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
        )
        OR (
          :mode = 'fulltext'
          AND EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.cluster_id = c.cluster_id
              AND sd.stage = 'TA'
              AND sd.decision = 'include'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.cluster_id = c.cluster_id
              AND sd.stage = 'FT'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
        )
        OR (
          :mode = 'extract'
          AND EXISTS (
            SELECT 1 FROM screening_decisions sd
            WHERE sd.project_id = :project_id
              AND sd.cluster_id = c.cluster_id
              AND sd.stage = 'FT'
              AND sd.decision = 'include'
              AND (:reviewer_id IS NULL OR sd.reviewer_id = :reviewer_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM extraction_records er
            WHERE er.project_id = :project_id
              AND er.cluster_id = c.cluster_id
          )
        )
      )
  ),
  available AS (
    SELECT cluster_id, record_id, created_at FROM available_clusters
    UNION ALL
    SELECT cluster_id, record_id, created_at FROM available_standalone
  )
SELECT cluster_id, record_id
FROM available
ORDER BY created_at
LIMIT 1
""")


async def get_next_item(
    db: AsyncSession,
    project_id: uuid.UUID,
    source_id: Optional[str],
    mode: str,
    reviewer_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """
    Return the next available item for screening/review/extraction.

    Inserts a screening_claim row (soft lock) before returning metadata.
    Returns {"done": True} when no items are available.
    """
    source_uuid: Optional[uuid.UUID] = None
    if source_id and source_id != "all":
        try:
            source_uuid = uuid.UUID(source_id)
        except ValueError:
            return {"done": True}

    reviewer_uuid_str = str(reviewer_id) if reviewer_id else None

    params: Dict[str, Any] = {
        "project_id": project_id,
        "source_id": source_uuid,
        "mode": mode,
        "reviewer_id": reviewer_uuid_str,
    }

    result = await db.execute(_NEXT_ITEM_SQL, params)
    row = result.one_or_none()

    if row is None:
        return {"done": True}

    found_record_id: Optional[uuid.UUID] = row.record_id
    found_cluster_id: Optional[uuid.UUID] = row.cluster_id

    # Insert soft-lock claim (upsert via ON CONFLICT DO UPDATE to refresh claimed_at)
    if found_record_id is not None:
        await db.execute(
            text(
                "INSERT INTO screening_claims (id, project_id, record_id, reviewer_id, claimed_at) "
                "VALUES (gen_random_uuid(), :project_id, :record_id, :reviewer_id, now()) "
                "ON CONFLICT (project_id, record_id) WHERE record_id IS NOT NULL "
                "DO UPDATE SET claimed_at = now(), reviewer_id = EXCLUDED.reviewer_id"
            ),
            {
                "project_id": project_id,
                "record_id": found_record_id,
                "reviewer_id": reviewer_id,
            },
        )
    else:
        await db.execute(
            text(
                "INSERT INTO screening_claims (id, project_id, cluster_id, reviewer_id, claimed_at) "
                "VALUES (gen_random_uuid(), :project_id, :cluster_id, :reviewer_id, now()) "
                "ON CONFLICT (project_id, cluster_id) WHERE cluster_id IS NOT NULL "
                "DO UPDATE SET claimed_at = now(), reviewer_id = EXCLUDED.reviewer_id"
            ),
            {
                "project_id": project_id,
                "cluster_id": found_cluster_id,
                "reviewer_id": reviewer_id,
            },
        )

    # Fetch record metadata
    if found_record_id is not None:
        meta = await _fetch_standalone_record(db, found_record_id, project_id)
    else:
        meta = await _fetch_cluster_record(db, found_cluster_id, project_id)

    # Compute remaining count (approximate — items available for this reviewer+mode)
    remaining_result = await db.execute(
        text(
            "SELECT COUNT(*) FROM ("
            + _NEXT_ITEM_SQL.text.replace("ORDER BY created_at\nLIMIT 1", "")
            + ") _avail"
        ),
        params,
    )
    remaining = remaining_result.scalar() or 0

    return {
        "done": False,
        "record_id": str(found_record_id) if found_record_id else None,
        "cluster_id": str(found_cluster_id) if found_cluster_id else None,
        "remaining": remaining,
        **meta,
    }


# ---------------------------------------------------------------------------
# Record metadata fetch helpers
# ---------------------------------------------------------------------------

async def _fetch_standalone_record(
    db: AsyncSession,
    record_id: uuid.UUID,
    project_id: uuid.UUID,
) -> Dict[str, Any]:
    result = await db.execute(
        select(
            Record.title,
            Record.abstract,
            Record.year,
            Record.authors,
            Record.normalized_doi,
            func.array_agg(Source.name.distinct()).label("source_names"),
        )
        .join(RecordSource, RecordSource.record_id == Record.id)
        .join(Source, Source.id == RecordSource.source_id)
        .where(Record.id == record_id, Record.project_id == project_id)
        .group_by(Record.id)
    )
    row = result.one_or_none()
    if row is None:
        return {"title": None, "abstract": None, "year": None, "authors": None,
                "doi": None, "source_names": []}
    return {
        "title": row.title,
        "abstract": row.abstract,
        "year": row.year,
        "authors": row.authors,
        "doi": row.normalized_doi,
        "source_names": list(row.source_names or []),
    }


async def _fetch_cluster_record(
    db: AsyncSession,
    cluster_id: uuid.UUID,
    project_id: uuid.UUID,
) -> Dict[str, Any]:
    """Use the canonical-role member's record; aggregate source names."""
    result = await db.execute(
        select(
            Record.title, Record.abstract, Record.year,
            Record.authors, Record.normalized_doi,
        )
        .join(RecordSource, RecordSource.record_id == Record.id)
        .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
        .where(
            OverlapClusterMember.cluster_id == cluster_id,
            OverlapClusterMember.role == "canonical",
        )
        .limit(1)
    )
    row = result.one_or_none()
    if row is None:
        # Fall back to any member
        result = await db.execute(
            select(
                Record.title, Record.abstract, Record.year,
                Record.authors, Record.normalized_doi,
            )
            .join(RecordSource, RecordSource.record_id == Record.id)
            .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
            .where(OverlapClusterMember.cluster_id == cluster_id)
            .limit(1)
        )
        row = result.one_or_none()
    if row is None:
        return {"title": None, "abstract": None, "year": None, "authors": None,
                "doi": None, "source_names": []}

    src_result = await db.execute(
        select(Source.name)
        .join(RecordSource, RecordSource.source_id == Source.id)
        .join(OverlapClusterMember, OverlapClusterMember.record_source_id == RecordSource.id)
        .where(OverlapClusterMember.cluster_id == cluster_id)
        .distinct()
    )
    return {
        "title": row.title,
        "abstract": row.abstract,
        "year": row.year,
        "authors": row.authors,
        "doi": row.normalized_doi,
        "source_names": list(src_result.scalars().all()),
    }


# ---------------------------------------------------------------------------
# Decision submission
# ---------------------------------------------------------------------------

async def submit_decision(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID],
    cluster_id: Optional[uuid.UUID],
    stage: str,
    decision: str,
    reason_code: Optional[str],
    notes: Optional[str],
    reviewer_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """Insert a screening decision and release the soft lock."""
    dec = ScreeningDecision(
        project_id=project_id,
        record_id=record_id,
        cluster_id=cluster_id,
        stage=stage,
        decision=decision,
        reason_code=reason_code,
        notes=notes,
        reviewer_id=reviewer_id,
    )
    db.add(dec)
    await db.flush()

    # Release claim
    if record_id is not None:
        await db.execute(
            delete(ScreeningClaim).where(
                ScreeningClaim.project_id == project_id,
                ScreeningClaim.record_id == record_id,
            )
        )
    else:
        await db.execute(
            delete(ScreeningClaim).where(
                ScreeningClaim.project_id == project_id,
                ScreeningClaim.cluster_id == cluster_id,
            )
        )

    return {
        "id": str(dec.id),
        "project_id": str(dec.project_id),
        "record_id": str(dec.record_id) if dec.record_id else None,
        "cluster_id": str(dec.cluster_id) if dec.cluster_id else None,
        "stage": dec.stage,
        "decision": dec.decision,
        "reason_code": dec.reason_code,
        "notes": dec.notes,
        "reviewer_id": str(dec.reviewer_id) if dec.reviewer_id else None,
        "created_at": dec.created_at,
    }


# ---------------------------------------------------------------------------
# Extraction submission
# ---------------------------------------------------------------------------

async def submit_extraction(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID],
    cluster_id: Optional[uuid.UUID],
    extracted_json: dict,
    reviewer_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """Upsert an extraction record."""
    # Check for existing
    if record_id is not None:
        existing = await db.execute(
            select(ExtractionRecord).where(
                ExtractionRecord.project_id == project_id,
                ExtractionRecord.record_id == record_id,
            )
        )
    else:
        existing = await db.execute(
            select(ExtractionRecord).where(
                ExtractionRecord.project_id == project_id,
                ExtractionRecord.cluster_id == cluster_id,
            )
        )

    er = existing.scalar_one_or_none()
    if er is None:
        er = ExtractionRecord(
            project_id=project_id,
            record_id=record_id,
            cluster_id=cluster_id,
            extracted_json=extracted_json,
            reviewer_id=reviewer_id,
        )
        db.add(er)
    else:
        er.extracted_json = extracted_json
        er.reviewer_id = reviewer_id

    await db.flush()

    return {
        "id": str(er.id),
        "project_id": str(er.project_id),
        "record_id": str(er.record_id) if er.record_id else None,
        "cluster_id": str(er.cluster_id) if er.cluster_id else None,
        "extracted_json": er.extracted_json,
        "reviewer_id": str(er.reviewer_id) if er.reviewer_id else None,
        "created_at": er.created_at,
    }
