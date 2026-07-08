"""Order-aware concept discovery (implementation-audit P0.6).

Replaces the previous frontend computation (buildSeenValues in
ExtractionLibrary.tsx), which compared each article against *all other*
extractions regardless of order — causing the first paper introducing a
value to be marked "existing" whenever a later paper repeated it. This
computes first-occurrence vs recurrence from an explicit frozen sequence
(concept_mentions.sequence_index, falling back to parent-extraction
insertion order) and canonical-concept equality (falling back to raw
(field_id, value) equality for mentions not yet mapped to a taxonomy node).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_extraction import ConceptExtraction
from app.models.concept_mention import ConceptMention
from app.models.screening_queue import ScreeningQueue
from app.services.concept_mention_service import effective_concept_extractions


async def compute_discovery(
    db: AsyncSession,
    project_id: uuid.UUID,
    reviewer_id: uuid.UUID,
    source_id: Optional[uuid.UUID] = None,
) -> Dict[str, Any]:
    # Effective (human-wins) extraction rows for this reviewer, optionally
    # scoped to one source's queue, to mirror get_saturation's scoping.
    extractions = await effective_concept_extractions(db, project_id, reviewer_ids=[reviewer_id])

    if source_id is not None:
        queue = (await db.execute(
            select(ScreeningQueue).where(
                ScreeningQueue.project_id == project_id,
                ScreeningQueue.reviewer_id == reviewer_id,
                ScreeningQueue.source_id == str(source_id),
                ScreeningQueue.stage.in_(["extract", "mixed"]),
            ).order_by(ScreeningQueue.stage)
        )).scalars().first()
        if queue is None:
            return {"items": []}
        slot_ids = {uuid.UUID(s["id"]) for s in (queue.slots or [])}
        extractions = [
            ce for ce in extractions
            if (ce.record_id in slot_ids) or (ce.cluster_id in slot_ids)
        ]

    if not extractions:
        return {"items": []}

    ce_by_id = {ce.id: ce for ce in extractions}
    mentions = (await db.execute(
        select(ConceptMention).where(ConceptMention.concept_extraction_id.in_(ce_by_id.keys()))
    )).scalars().all()

    def sort_key(m: ConceptMention):
        ce = ce_by_id[m.concept_extraction_id]
        # Ranked mentions (known queue position) sort before unranked ones,
        # which fall back to their parent extraction's insertion order.
        has_seq = m.sequence_index is not None
        return (0 if has_seq else 1, m.sequence_index or 0, ce.created_at)

    mentions_sorted = sorted(mentions, key=sort_key)

    seen_groups: set = set()
    items: Dict[uuid.UUID, Dict[str, Any]] = {}

    for m in mentions_sorted:
        ce = ce_by_id[m.concept_extraction_id]
        group_key = ("node", m.canonical_node_id) if m.canonical_node_id else ("raw", m.field_id, m.value)
        computed_status = "recurrent" if group_key in seen_groups else "first"
        seen_groups.add(group_key)

        override_status = None
        stored_novelty = (ce.extracted_json or {}).get("novelty", {})
        field_novelty = stored_novelty.get(m.field_id, {}) if isinstance(stored_novelty, dict) else {}
        if isinstance(field_novelty, dict) and m.value in field_novelty:
            override_status = field_novelty[m.value]

        effective_status = (
            "first" if override_status == "new"
            else "recurrent" if override_status == "existing"
            else computed_status
        )

        item = items.setdefault(ce.id, {
            "record_id": str(ce.record_id) if ce.record_id else None,
            "cluster_id": str(ce.cluster_id) if ce.cluster_id else None,
            "sequence_index": None,
            "concepts": [],
        })
        if item["sequence_index"] is None and m.sequence_index is not None:
            item["sequence_index"] = m.sequence_index
        item["concepts"].append({
            "field_id": m.field_id,
            "value": m.value,
            "canonical_node_id": str(m.canonical_node_id) if m.canonical_node_id else None,
            "computed_status": computed_status,
            "override_status": override_status,
            "effective_status": effective_status,
        })

    ordered_items: List[Dict[str, Any]] = sorted(
        items.values(), key=lambda it: (it["sequence_index"] is None, it["sequence_index"] or 0)
    )
    return {"items": ordered_items}
