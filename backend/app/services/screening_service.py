"""
Screening service — VS4.

Provides the core business logic for:
  - generate_queue      : build deterministic-random screening queue
  - get_next_item       : fetch next unreviewed TA item with record metadata
  - submit_decision     : record TA/FT decision (with optional borderline escalation)
  - submit_extraction   : save extraction and update saturation counters
  - _resolve_canonical_key / _build_cluster_map : canonical key helpers
  - _fetch_record_for_key : enrich a canonical key with display metadata
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
    """Return "pg:{cluster_id}" if the record is in a cross-source cluster, else "rec:{record_id}"."""
    cluster_id = cluster_map.get(record_id)
    if cluster_id is not None:
        return f"pg:{cluster_id}"
    return f"rec:{record_id}"


async def _build_cluster_map(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_ids: List[uuid.UUID],
) -> Dict[uuid.UUID, uuid.UUID]:
    """
    Return {record_id: cluster_id} for records that belong to a cross-source
    overlap cluster in this project.
    """
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
    # If a record is in multiple clusters (shouldn't happen but defensively handled),
    # the first cluster_id encountered wins.
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

    Steps:
    1. Fetch all record_ids from record_sources where source_id IN corpus.source_ids.
    2. Build cluster_map for cross-source dedup.
    3. Resolve canonical_key per record; deduplicate within corpus.
    4. Find canonical_keys already finally decided in other corpora of this project.
    5. Filter out prior-decided keys.
    6. Shuffle with random.Random(seed).
    7. Delete old queue, insert new items.
    8. Update corpus queue metadata.
    9. Return summary dict.
    """
    project_id = corpus.project_id
    source_ids = corpus.source_ids or []

    # Step 1: fetch record_ids
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

    # Step 2: cluster map
    cluster_map = await _build_cluster_map(db, project_id, record_ids)

    # Step 3: resolve canonical keys, deduplicate within corpus
    seen: set = set()
    canonical_keys: List[str] = []
    for rid in record_ids:
        key = _resolve_canonical_key(rid, cluster_map)
        if key not in seen:
            seen.add(key)
            canonical_keys.append(key)

    # Step 4: find prior-decided canonical_keys across other corpora in this project
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

    # Step 5: filter
    before_count = len(canonical_keys)
    canonical_keys = [k for k in canonical_keys if k not in prior_keys]
    excluded_count = before_count - len(canonical_keys)

    # Step 6: shuffle
    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    rng = random.Random(seed)
    rng.shuffle(canonical_keys)

    # Step 7: delete old queue and insert new
    await ScreeningRepo.delete_queue(db, corpus.id)
    await ScreeningRepo.insert_queue_items(db, corpus.id, canonical_keys)

    # Step 8: update corpus metadata
    await CorpusRepo.update_queue_meta(db, corpus, len(canonical_keys), seed)

    logger.info(
        "generate_queue corpus=%s queue_size=%d excluded=%d seed=%d",
        corpus.id,
        len(canonical_keys),
        excluded_count,
        seed,
    )

    return {
        "queue_size": len(canonical_keys),
        "excluded_count": excluded_count,
        "seed": seed,
    }


# ---------------------------------------------------------------------------
# Next item
# ---------------------------------------------------------------------------

async def get_next_item(
    db: AsyncSession,
    corpus: Corpus,
) -> Optional[Dict[str, Any]]:
    """
    Return the next unreviewed TA item with record enrichment, or None if
    the queue is exhausted.
    """
    decided_keys = await ScreeningRepo.get_decided_keys(db, corpus.id, stage="TA")
    item = await ScreeningRepo.get_next_undecided(db, corpus.id, decided_keys)
    if item is None:
        return None

    record_data = await _fetch_record_for_key(db, item.canonical_key, corpus.project_id)
    total = corpus.queue_size
    position = item.order_index + 1
    return {
        "canonical_key": item.canonical_key,
        "order_index": item.order_index,
        "position": position,
        "total": total,
        **record_data,
    }


# ---------------------------------------------------------------------------
# Record fetch
# ---------------------------------------------------------------------------

async def _fetch_record_for_key(
    db: AsyncSession,
    canonical_key: str,
    project_id: uuid.UUID,
) -> Dict[str, Any]:
    """
    Return display data for a canonical_key:
      title, abstract, year, authors, doi, source_names (list)
    """
    if canonical_key.startswith("rec:"):
        record_id = uuid.UUID(canonical_key[4:])
        return await _fetch_standalone_record(db, record_id, project_id)
    elif canonical_key.startswith("pg:"):
        cluster_id = uuid.UUID(canonical_key[3:])
        return await _fetch_cluster_record(db, cluster_id, project_id)
    return {"title": None, "abstract": None, "year": None, "authors": None, "doi": None, "source_names": []}


async def _fetch_standalone_record(
    db: AsyncSession,
    record_id: uuid.UUID,
    project_id: uuid.UUID,
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
    db: AsyncSession,
    cluster_id: uuid.UUID,
    project_id: uuid.UUID,
) -> Dict[str, Any]:
    """
    For a cross-source cluster: take the canonical-role member's record and
    aggregate all source names from the cluster.
    """
    # Prefer canonical member; fall back to first member if none
    result = await db.execute(
        select(
            Record.title,
            Record.abstract,
            Record.year,
            Record.authors,
            Record.normalized_doi,
        )
        .join(RecordSource, RecordSource.record_id == Record.id)
        .join(
            OverlapClusterMember,
            OverlapClusterMember.record_source_id == RecordSource.id,
        )
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
                Record.title,
                Record.abstract,
                Record.year,
                Record.authors,
                Record.normalized_doi,
            )
            .join(RecordSource, RecordSource.record_id == Record.id)
            .join(
                OverlapClusterMember,
                OverlapClusterMember.record_source_id == RecordSource.id,
            )
            .where(OverlapClusterMember.cluster_id == cluster_id)
            .limit(1)
        )
        row = result.one_or_none()
    if row is None:
        return {"title": None, "abstract": None, "year": None, "authors": None, "doi": None, "source_names": []}

    # Aggregate source names
    src_result = await db.execute(
        select(Source.name)
        .join(RecordSource, RecordSource.source_id == Source.id)
        .join(
            OverlapClusterMember,
            OverlapClusterMember.record_source_id == RecordSource.id,
        )
        .where(OverlapClusterMember.cluster_id == cluster_id)
        .distinct()
    )
    source_names = list(src_result.scalars().all())
    return {
        "title": row.title,
        "abstract": row.abstract,
        "year": row.year,
        "authors": row.authors,
        "doi": row.normalized_doi,
        "source_names": source_names,
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
    """
    Record a TA or FT decision. If decision is "borderline", also create a
    CorpusBorderlineCase row.
    """
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
# Extraction submission
# ---------------------------------------------------------------------------

async def submit_extraction(
    db: AsyncSession,
    corpus: Corpus,
    canonical_key: str,
    extracted_json: dict,
    novelty_flag: bool,
    novelty_notes: Optional[str],
    reviewer_id: Optional[uuid.UUID],
) -> Dict[str, Any]:
    """
    Upsert an extraction row and update saturation counters on the corpus.
    """
    ext = await ScreeningRepo.upsert_extraction(
        db,
        corpus_id=corpus.id,
        canonical_key=canonical_key,
        extracted_json=extracted_json,
        novelty_flag=novelty_flag,
        novelty_notes=novelty_notes,
        reviewer_id=reviewer_id,
    )
    await CorpusRepo.update_saturation(db, corpus, novelty_flag)
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
