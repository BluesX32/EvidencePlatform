"""
Screening service — VS4.

Provides the core business logic for:
  - generate_queue      : build deterministic-random screening queue
  - get_next_item       : fetch next pending item with record metadata
  - skip_item           : mark a queue item as skipped (not useful now)
  - submit_decision     : record TA decision (with borderline escalation)
  - submit_extraction   : save extraction and update saturation counters
  - _resolve_canonical_key / _build_cluster_map : canonical key helpers
  - _fetch_record_for_key : enrich a canonical key with display metadata

Saturation logic:
  extraction.extracted_json["framework_updated"] drives the counter:
    True  → consecutive_no_novelty resets to 0
    False → consecutive_no_novelty += 1
  When counter >= saturation_threshold: corpus.stopped_at is set.
  Saturation can fire without exhausting the queue (saturation-first design).
"""
from __future__ import annotations

import logging
import random
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.corpus import Corpus
from app.models.overlap_cluster import OverlapCluster
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source
from app.repositories.corpus_repo import CorpusRepo
from app.repositories.screening_repo import ScreeningRepo

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
        .join(
            OverlapClusterMember,
            OverlapClusterMember.record_source_id == RecordSource.id,
        )
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
# Queue generation
# ---------------------------------------------------------------------------

async def generate_queue(
    db: AsyncSession,
    corpus: Corpus,
    seed: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Build (or re-build) the screening queue for a corpus.

    1. Fetch record_ids for sources in corpus.source_ids
    2. Build cluster_map
    3. Resolve + deduplicate canonical_keys
    4. Filter out keys already finally decided in other corpora of this project
    5. Shuffle with random.Random(seed)
    6. Delete old queue, insert new items (all status='pending')
    7. Update corpus queue metadata
    """
    project_id = corpus.project_id
    source_ids = corpus.source_ids or []

    if source_ids:
        rs_result = await db.execute(
            select(RecordSource.record_id)
            .join(Record, Record.id == RecordSource.record_id)
            .where(
                RecordSource.source_id.in_(source_ids),
                Record.project_id == project_id,
            )
            .distinct()
        )
        record_ids: List[uuid.UUID] = list(rs_result.scalars().all())
    else:
        record_ids = []

    cluster_map = await _build_cluster_map(db, project_id, record_ids)

    seen: set = set()
    canonical_keys: List[str] = []
    for rid in record_ids:
        key = _resolve_canonical_key(rid, cluster_map)
        if key not in seen:
            seen.add(key)
            canonical_keys.append(key)

    # Prior decisions across other corpora in this project
    from app.models.corpus_decision import CorpusDecision
    prior_result = await db.execute(
        select(CorpusDecision.canonical_key)
        .join(Corpus, Corpus.id == CorpusDecision.corpus_id)
        .where(
            Corpus.project_id == project_id,
            CorpusDecision.corpus_id != corpus.id,
            CorpusDecision.stage == "TA",
            CorpusDecision.decision.in_(["include", "exclude"]),
        )
        .distinct()
    )
    prior_keys: set = set(prior_result.scalars().all())

    before_count = len(canonical_keys)
    canonical_keys = [k for k in canonical_keys if k not in prior_keys]
    excluded_count = before_count - len(canonical_keys)

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    rng = random.Random(seed)
    rng.shuffle(canonical_keys)

    await ScreeningRepo.delete_queue(db, corpus.id)
    await ScreeningRepo.insert_queue_items(db, corpus.id, canonical_keys)
    await CorpusRepo.update_queue_meta(db, corpus, len(canonical_keys), seed)

    logger.info(
        "generate_queue corpus=%s queue_size=%d excluded=%d seed=%d",
        corpus.id, len(canonical_keys), excluded_count, seed,
    )
    return {"queue_size": len(canonical_keys), "excluded_count": excluded_count, "seed": seed}


# ---------------------------------------------------------------------------
# Next item (status-based)
# ---------------------------------------------------------------------------

async def get_next_item(
    db: AsyncSession,
    corpus: Corpus,
) -> Optional[Dict[str, Any]]:
    """Return the next pending queue item with record enrichment, or None if done."""
    item = await ScreeningRepo.get_next_pending(db, corpus.id)
    if item is None:
        return None
    record_data = await _fetch_record_for_key(db, item.canonical_key, corpus.project_id)
    return {
        "canonical_key": item.canonical_key,
        "order_index": item.order_index,
        "position": item.order_index + 1,
        "total": corpus.queue_size,
        **record_data,
    }


# ---------------------------------------------------------------------------
# Skip item
# ---------------------------------------------------------------------------

async def skip_item(
    db: AsyncSession,
    corpus: Corpus,
    canonical_key: str,
) -> Dict[str, Any]:
    """Mark a queue item as skipped and return the next pending item."""
    await ScreeningRepo.mark_item_status(db, corpus.id, canonical_key, "skipped")
    next_item = await get_next_item(db, corpus)
    return {"skipped": canonical_key, "next": next_item}


# ---------------------------------------------------------------------------
# Record fetch helpers
# ---------------------------------------------------------------------------

async def _fetch_record_for_key(
    db: AsyncSession,
    canonical_key: str,
    project_id: uuid.UUID,
) -> Dict[str, Any]:
    """Return display data (title, abstract, year, authors, doi, source_names)."""
    if canonical_key.startswith("rec:"):
        record_id = uuid.UUID(canonical_key[4:])
        return await _fetch_standalone_record(db, record_id, project_id)
    elif canonical_key.startswith("pg:"):
        cluster_id = uuid.UUID(canonical_key[3:])
        return await _fetch_cluster_record(db, cluster_id, project_id)
    return {"title": None, "abstract": None, "year": None, "authors": None, "doi": None, "source_names": []}


async def _fetch_standalone_record(
    db: AsyncSession, record_id: uuid.UUID, project_id: uuid.UUID,
) -> Dict[str, Any]:
    result = await db.execute(
        select(
            Record.id,
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
        return {"title": None, "abstract": None, "year": None, "authors": None, "doi": None, "source_names": []}
    return {
        "title": row.title,
        "abstract": row.abstract,
        "year": row.year,
        "authors": row.authors,
        "doi": row.normalized_doi,
        "source_names": list(row.source_names or []),
    }


async def _fetch_cluster_record(
    db: AsyncSession, cluster_id: uuid.UUID, project_id: uuid.UUID,
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
        return {"title": None, "abstract": None, "year": None, "authors": None, "doi": None, "source_names": []}
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
    corpus: Corpus,
    canonical_key: str,
    stage: str,
    decision: str,
    reason_code: Optional[str],
    notes: Optional[str],
    reviewer_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """Record a TA decision. Also marks the queue item as 'decided' and creates borderline case if needed."""
    dec = await ScreeningRepo.insert_decision(
        db,
        corpus_id=corpus.id,
        canonical_key=canonical_key,
        stage=stage,
        decision=decision,
        reason_code=reason_code,
        notes=notes,
        reviewer_id=reviewer_id,
    )
    # Update queue item status
    if stage == "TA":
        await ScreeningRepo.mark_item_status(db, corpus.id, canonical_key, "decided")

    borderline_id = None
    if decision == "borderline":
        bc = await ScreeningRepo.insert_borderline(
            db, corpus_id=corpus.id, canonical_key=canonical_key, stage=stage
        )
        borderline_id = bc.id

    return {
        "id": dec.id,
        "corpus_id": dec.corpus_id,
        "canonical_key": dec.canonical_key,
        "stage": dec.stage,
        "decision": dec.decision,
        "reason_code": dec.reason_code,
        "notes": dec.notes,
        "reviewer_id": dec.reviewer_id,
        "created_at": dec.created_at,
        "borderline_case_id": borderline_id,
    }


# ---------------------------------------------------------------------------
# Extraction submission — saturation-first design
# ---------------------------------------------------------------------------

async def submit_extraction(
    db: AsyncSession,
    corpus: Corpus,
    canonical_key: str,
    extracted_json: dict,
    reviewer_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """
    Upsert an extraction row and update saturation counters.

    Saturation is driven by extracted_json["framework_updated"]:
      True  → reset consecutive_no_novelty to 0
      False → increment consecutive_no_novelty
    Saturation can fire without exhausting the queue (saturation-first design).
    """
    framework_updated: bool = bool(extracted_json.get("framework_updated", True))
    framework_update_note: str = extracted_json.get("framework_update_note", "") or ""

    ext = await ScreeningRepo.upsert_extraction(
        db,
        corpus_id=corpus.id,
        canonical_key=canonical_key,
        extracted_json=extracted_json,
        novelty_flag=framework_updated,
        novelty_notes=framework_update_note or None,
        reviewer_id=reviewer_id,
    )
    # Mark queue item as extracted (implies decided+included)
    await ScreeningRepo.mark_item_status(db, corpus.id, canonical_key, "extracted")

    await CorpusRepo.update_saturation(db, corpus, framework_updated)

    return {
        "id": ext.id,
        "corpus_id": ext.corpus_id,
        "canonical_key": ext.canonical_key,
        "novelty_flag": ext.novelty_flag,
        "novelty_notes": ext.novelty_notes,
        "reviewer_id": ext.reviewer_id,
        "created_at": ext.created_at,
        "saturation": {
            "total_extracted": corpus.total_extracted,
            "consecutive_no_novelty": corpus.consecutive_no_novelty,
            "saturation_threshold": corpus.saturation_threshold,
            "stopped_at": corpus.stopped_at,
        },
    }
