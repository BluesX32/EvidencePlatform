"""End-to-end concept provenance export (implementation-audit P0.8).

One machine-readable bundle per article/cluster joining: extraction rows
(human + AI, with derivation), concept_mentions (passage-grounded raw
values), canonical mappings, the concept_events transformation ledger, and
ontology mappings. Intended to back case-study tables/figures and as the
target of the P0.8 round-trip integration test.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_event import ConceptEvent
from app.models.concept_extraction import ConceptExtraction
from app.models.concept_mention import ConceptMention
from app.models.concept_taxonomy_node import ConceptTaxonomyNode


async def build_provenance_export(
    db: AsyncSession,
    project_id: uuid.UUID,
    *,
    record_id: Optional[uuid.UUID] = None,
    cluster_id: Optional[uuid.UUID] = None,
    reviewer_id: Optional[uuid.UUID] = None,
) -> Dict[str, Any]:
    stmt = select(ConceptExtraction).where(ConceptExtraction.project_id == project_id)
    if record_id is not None:
        stmt = stmt.where(ConceptExtraction.record_id == record_id)
    if cluster_id is not None:
        stmt = stmt.where(ConceptExtraction.cluster_id == cluster_id)
    if reviewer_id is not None:
        stmt = stmt.where(ConceptExtraction.reviewer_id == reviewer_id)
    extractions = (await db.execute(stmt)).scalars().all()

    by_item: Dict[tuple, List[ConceptExtraction]] = {}
    for ce in extractions:
        key = (ce.record_id, ce.cluster_id)
        by_item.setdefault(key, []).append(ce)

    items: List[Dict[str, Any]] = []
    for (rec_id, cl_id), ces in by_item.items():
        ce_ids = [ce.id for ce in ces]
        mentions = (await db.execute(
            select(ConceptMention).where(ConceptMention.concept_extraction_id.in_(ce_ids))
        )).scalars().all()

        canonical_ids = {m.canonical_node_id for m in mentions if m.canonical_node_id}
        canonical_nodes: Dict[uuid.UUID, ConceptTaxonomyNode] = {}
        if canonical_ids:
            nodes = (await db.execute(
                select(ConceptTaxonomyNode).where(ConceptTaxonomyNode.id.in_(canonical_ids))
            )).scalars().all()
            canonical_nodes = {n.id: n for n in nodes}

        events: List[ConceptEvent] = []
        if mention_ids := [m.id for m in mentions]:
            events += (await db.execute(
                select(ConceptEvent).where(ConceptEvent.mention_id.in_(mention_ids))
            )).scalars().all()
        if canonical_ids:
            events += (await db.execute(
                select(ConceptEvent).where(ConceptEvent.taxonomy_node_id.in_(canonical_ids))
            )).scalars().all()
        # De-duplicate (an event could match both filters).
        events = list({e.id: e for e in events}.values())

        ontology_mappings = [e for e in events if e.action == "map_ontology"]

        items.append({
            "record_id": str(rec_id) if rec_id else None,
            "cluster_id": str(cl_id) if cl_id else None,
            "extractions": [
                {
                    "id": str(ce.id),
                    "origin": ce.origin,
                    "reviewer_id": str(ce.reviewer_id) if ce.reviewer_id else None,
                    "derived_from_id": str(ce.derived_from_id) if ce.derived_from_id else None,
                    "created_at": ce.created_at.isoformat(),
                    "updated_at": ce.updated_at.isoformat(),
                }
                for ce in ces
            ],
            "mentions": [
                {
                    "id": str(m.id),
                    "concept_extraction_id": str(m.concept_extraction_id),
                    "field_id": m.field_id,
                    "field_type": m.field_type,
                    "value": m.value,
                    "source_quote": m.source_quote,
                    "locator": m.locator,
                    "origin": m.origin,
                    "ai_job_id": str(m.ai_job_id) if m.ai_job_id else None,
                    "llm_call_id": str(m.llm_call_id) if m.llm_call_id else None,
                    "canonical_node_id": str(m.canonical_node_id) if m.canonical_node_id else None,
                    "sequence_index": m.sequence_index,
                }
                for m in mentions
            ],
            "canonical_mappings": [
                {
                    "mention_id": str(m.id),
                    "canonical_node_id": str(m.canonical_node_id),
                    "canonical_name": canonical_nodes[m.canonical_node_id].name,
                    "field_id": m.field_id,
                }
                for m in mentions
                if m.canonical_node_id and m.canonical_node_id in canonical_nodes
            ],
            "events": [
                {
                    "id": str(e.id),
                    "action": e.action,
                    "entity_type": e.entity_type,
                    "mention_id": str(e.mention_id) if e.mention_id else None,
                    "taxonomy_node_id": str(e.taxonomy_node_id) if e.taxonomy_node_id else None,
                    "ontology_node_id": str(e.ontology_node_id) if e.ontology_node_id else None,
                    "prior_state": e.prior_state,
                    "resulting_state": e.resulting_state,
                    "actor_origin": e.actor_origin,
                    "created_at": e.created_at.isoformat(),
                }
                for e in events
            ],
            "ontology_mappings": [
                {
                    "ontology_node_id": str(e.ontology_node_id) if e.ontology_node_id else None,
                    "source_taxonomy_node_id": str(e.taxonomy_node_id) if e.taxonomy_node_id else None,
                    "mapping_type": e.mapping_type,
                    "created_at": e.created_at.isoformat(),
                }
                for e in ontology_mappings
            ],
        })

    return {
        "project_id": str(project_id),
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "items": items,
    }
