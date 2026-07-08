"""Concept-mention provenance layer (implementation-audit P0.1/P0.2).

concept_extractions.extracted_json stays the form-shaped record the UI reads
and writes. concept_mentions is a synced, first-class view of that JSON: one
row per raw value, with a stable id that provenance, canonicalization, and
discovery analysis can reference without depending on JSON key stability.

Also provides effective_concept_extractions(), the "human row wins over the
AI row it was derived from" resolution used everywhere a caller previously
assumed exactly one ConceptExtraction row per (reviewer, item) — an
assumption migration 050's per-origin uniqueness intentionally breaks.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_extraction import ConceptExtraction
from app.models.concept_mention import ConceptMention
from app.models.screening_queue import ScreeningQueue


def _flatten_cells(extracted_json: Dict[str, Any]) -> List[Tuple[str, str]]:
    """Same value-flattening as get_taxonomy_aggregate: explode arrays, drop blanks."""
    pairs: List[Tuple[str, str]] = []
    cells = (extracted_json or {}).get("cells", {})
    for field_id, raw_value in cells.items():
        values = raw_value if isinstance(raw_value, list) else [raw_value] if raw_value else []
        for v in values:
            v = v.strip() if isinstance(v, str) else str(v)
            if v:
                pairs.append((field_id, v))
    return pairs


async def _resolve_sequence(
    db: AsyncSession,
    project_id: uuid.UUID,
    reviewer_id: Optional[uuid.UUID],
    record_id: Optional[uuid.UUID],
    cluster_id: Optional[uuid.UUID],
) -> Tuple[Optional[uuid.UUID], Optional[int]]:
    """(screening_queue_id, 1-based position) of this item in the reviewer's
    extraction queue, if any. The queue id anchors the position to one frozen
    sequence — a bare position number is meaningless across different queues
    (e.g. two corpora can each have a slot at position 1)."""
    if reviewer_id is None:
        return None, None
    rows = (await db.execute(
        select(ScreeningQueue).where(
            ScreeningQueue.project_id == project_id,
            ScreeningQueue.reviewer_id == reviewer_id,
            ScreeningQueue.stage.in_(["extract", "mixed"]),
        )
    )).scalars().all()
    target = str(record_id) if record_id else str(cluster_id)
    target_type = "record" if record_id else "cluster"
    for queue in rows:
        for i, slot in enumerate(queue.slots or []):
            if slot.get("type") == target_type and slot.get("id") == target:
                return queue.id, i + 1
    return None, None


async def sync_mentions_for_extraction(
    db: AsyncSession,
    ce: ConceptExtraction,
    *,
    field_map: Dict[str, Dict[str, Any]],
    ai_job_id: Optional[uuid.UUID] = None,
    llm_call_id: Optional[uuid.UUID] = None,
) -> List[ConceptMention]:
    """Diff-sync concept_mentions to match ce.extracted_json['cells'].

    Deletes mentions for (field_id, value) pairs no longer present, inserts
    new ones, and leaves unchanged ones (and any canonical_node_id already
    mapped onto them) untouched. Does not commit — the caller's transaction
    does, so this can be composed with other writes (e.g. the upsert).
    """
    target_pairs = set(_flatten_cells(ce.extracted_json))

    existing = (await db.execute(
        select(ConceptMention).where(ConceptMention.concept_extraction_id == ce.id)
    )).scalars().all()
    existing_by_pair = {(m.field_id, m.value): m for m in existing}

    for pair, mention in existing_by_pair.items():
        if pair not in target_pairs:
            await db.delete(mention)

    new_pairs = [p for p in target_pairs if p not in existing_by_pair]
    queue_id: Optional[uuid.UUID] = None
    sequence_index: Optional[int] = None
    if new_pairs:
        queue_id, sequence_index = await _resolve_sequence(
            db, ce.project_id, ce.reviewer_id, ce.record_id, ce.cluster_id
        )

    grounding = (ce.extracted_json or {}).get("grounding", {})

    created: List[ConceptMention] = []
    for field_id, value in new_pairs:
        field_info = field_map.get(field_id, {})
        field_grounding = grounding.get(field_id, {}) if isinstance(grounding, dict) else {}
        value_grounding = field_grounding.get(value) if isinstance(field_grounding, dict) else None
        source_quote = None
        locator = None
        if isinstance(value_grounding, dict):
            source_quote = value_grounding.get("quote")
            locator = {
                "grounded": bool(value_grounding.get("grounded")),
                "document": value_grounding.get("document"),
            }
        mention = ConceptMention(
            project_id=ce.project_id,
            concept_extraction_id=ce.id,
            field_id=field_id,
            field_type=field_info.get("field_type", "metadata"),
            value=value,
            source_quote=source_quote,
            locator=locator,
            origin=ce.origin,
            reviewer_id=ce.reviewer_id,
            ai_job_id=ai_job_id,
            llm_call_id=llm_call_id,
            sequence_index=sequence_index,
            screening_queue_id=queue_id,
        )
        db.add(mention)
        created.append(mention)

    return created


async def effective_concept_extractions(
    db: AsyncSession,
    project_id: uuid.UUID,
    reviewer_ids: Optional[Sequence[uuid.UUID]] = None,
) -> List[ConceptExtraction]:
    """One ConceptExtraction per (reviewer_id, item): the human row if it
    exists, else the AI row. Prevents double-counting once a human-edited row
    and its AI original can coexist (migration 050)."""
    stmt = select(ConceptExtraction).where(ConceptExtraction.project_id == project_id)
    if reviewer_ids is not None:
        stmt = stmt.where(ConceptExtraction.reviewer_id.in_(reviewer_ids))
    rows = (await db.execute(stmt)).scalars().all()

    by_key: Dict[Tuple[Optional[uuid.UUID], Optional[uuid.UUID], Optional[uuid.UUID]], ConceptExtraction] = {}
    for ce in rows:
        key = (ce.reviewer_id, ce.record_id, ce.cluster_id)
        current = by_key.get(key)
        if current is None or (current.origin != "human" and ce.origin == "human"):
            by_key[key] = ce
    return list(by_key.values())
