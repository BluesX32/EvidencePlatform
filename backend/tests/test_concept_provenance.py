"""Tests for the concept-provenance sprint (migration 050, implementation-audit P0.1-P0.8).

Covers: concept_mentions sync from extracted_json, human/AI artifact
separation on upsert, canonical reassignment + survivorship events on
taxonomy merge, ontology-mapping events, order-aware discovery, and the
end-to-end provenance export.
"""
import uuid

import pytest
from sqlalchemy import select

from app.models.concept_event import ConceptEvent
from app.models.concept_extraction import ConceptExtraction
from app.models.concept_mention import ConceptMention
from app.models.concept_taxonomy_node import ConceptTaxonomyNode
from app.models.ontology_node import OntologyNode
from app.models.project import Project
from app.models.record import Record
from app.models.user import User
from app.routers.concept_extraction import (
    ConceptExtractionUpsert,
    PushItem,
    PushToOntologyRequest,
    get_item_concept_extraction,
    push_to_ontology,
    upsert_concept_extraction,
)
from app.routers.concept_taxonomy import MergeRequest, merge_nodes
from app.services.concept_mention_service import sync_mentions_for_extraction
from app.services.concept_provenance_service import build_provenance_export
from app.services.discovery_service import compute_discovery

FIELD_MAP = {"f1": {"field_type": "entity", "label": "Symptom"}}


async def _seed_project(db):
    user = User(email=f"cprov-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()
    project = Project(name="Concept Provenance Test", created_by=user.id)
    db.add(project)
    await db.flush()
    return user, project


async def _seed_record(db, project):
    record = Record(project_id=project.id, title="Paper", source_format="ris")
    db.add(record)
    await db.flush()
    return record


# ── P0.1: mention sync ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mention_created_from_human_extraction(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)

    ce = ConceptExtraction(
        project_id=project.id, record_id=record.id, reviewer_id=user.id, origin="human",
        extracted_json={"cells": {"f1": ["Fatigue", "Pain"]}},
    )
    db.add(ce)
    await db.flush()

    created = await sync_mentions_for_extraction(db, ce, field_map=FIELD_MAP)
    await db.commit()

    assert {m.value for m in created} == {"Fatigue", "Pain"}
    rows = (await db.execute(
        select(ConceptMention).where(ConceptMention.concept_extraction_id == ce.id)
    )).scalars().all()
    assert len(rows) == 2
    assert all(m.field_id == "f1" and m.origin == "human" for m in rows)
    await db.rollback()


# ── P0.2: human/AI artifact separation ───────────────────────────────────────

@pytest.mark.asyncio
async def test_ai_extraction_then_human_edit_preserves_both(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)

    ai_row = ConceptExtraction(
        project_id=project.id, record_id=record.id, reviewer_id=user.id, origin="ai",
        extracted_json={"cells": {"f1": ["Fatigue"]}},
    )
    db.add(ai_row)
    await db.commit()

    out = await upsert_concept_extraction(
        project_id=project.id,
        body=ConceptExtractionUpsert(record_id=str(record.id), extracted_json={"cells": {"f1": ["Fatigue", "Pain"]}}),
        current_user=user,
        db=db,
    )
    assert out.origin == "human"
    assert out.derived_from_id == str(ai_row.id)

    rows = (await db.execute(
        select(ConceptExtraction).where(
            ConceptExtraction.project_id == project.id, ConceptExtraction.record_id == record.id,
        )
    )).scalars().all()
    assert {r.origin for r in rows} == {"human", "ai"}

    items = await get_item_concept_extraction(
        project_id=project.id, record_id=str(record.id), cluster_id=None,
        as_reviewer_id=None, current_user=user, db=db,
    )
    assert items[0].origin == "human"
    await db.rollback()


# ── P0.4: merge reassigns mentions + writes survivorship event ──────────────

@pytest.mark.asyncio
async def test_merge_reassigns_mentions_and_writes_survivorship_event(db):
    user, project = await _seed_project(db)
    record1 = await _seed_record(db, project)
    record2 = await _seed_record(db, project)

    node_a = ConceptTaxonomyNode(project_id=project.id, name="Tired", field_id="f1", field_type="entity")
    node_b = ConceptTaxonomyNode(project_id=project.id, name="Fatigued", field_id="f1", field_type="entity")
    db.add_all([node_a, node_b])
    await db.flush()

    ce1 = ConceptExtraction(project_id=project.id, record_id=record1.id, reviewer_id=user.id, origin="human",
                             extracted_json={"cells": {"f1": ["Tired"]}})
    ce2 = ConceptExtraction(project_id=project.id, record_id=record2.id, reviewer_id=user.id, origin="human",
                             extracted_json={"cells": {"f1": ["Fatigued"]}})
    db.add_all([ce1, ce2])
    await db.flush()
    await sync_mentions_for_extraction(db, ce1, field_map=FIELD_MAP)
    await sync_mentions_for_extraction(db, ce2, field_map=FIELD_MAP)
    await db.commit()

    result = await merge_nodes(
        project_id=project.id,
        body=MergeRequest(node_ids=[str(node_a.id), str(node_b.id)], canonical_name="Fatigue", field_id="f1"),
        current_user=user, db=db,
    )
    canonical_id = uuid.UUID(result["id"])
    assert set(result["aliases"]) == {"Tired", "Fatigued"}

    # Source nodes are gone.
    remaining = (await db.execute(
        select(ConceptTaxonomyNode).where(ConceptTaxonomyNode.id.in_([node_a.id, node_b.id]))
    )).scalars().all()
    assert remaining == []

    # Both mentions now point at the canonical node.
    mentions = (await db.execute(
        select(ConceptMention).where(ConceptMention.project_id == project.id)
    )).scalars().all()
    assert len(mentions) == 2
    assert all(m.canonical_node_id == canonical_id for m in mentions)

    # One survivorship event per absorbed node, reconstructable after deletion.
    events = (await db.execute(
        select(ConceptEvent).where(ConceptEvent.action == "merge", ConceptEvent.project_id == project.id)
    )).scalars().all()
    assert len(events) == 2
    deleted_names = {e.prior_state["name"] for e in events}
    assert deleted_names == {"Tired", "Fatigued"}
    assert all(e.taxonomy_node_id == canonical_id for e in events)
    await db.rollback()


# ── P0.5: ontology-mapping events ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_push_to_ontology_writes_mapping_event(db):
    user, project = await _seed_project(db)
    node = ConceptTaxonomyNode(project_id=project.id, name="Fatigue", field_id="f1", field_type="entity")
    db.add(node)
    await db.commit()

    await push_to_ontology(
        project_id=project.id,
        body=PushToOntologyRequest(items=[
            PushItem(value="Fatigue", field_type="entity", field_id="f1"),
            PushItem(value="Unmapped Value", field_type="entity", field_id=None),
        ]),
        current_user=user, db=db,
    )

    events = (await db.execute(
        select(ConceptEvent).where(ConceptEvent.action == "map_ontology", ConceptEvent.project_id == project.id)
    )).scalars().all()
    assert len(events) == 2
    by_mapping_type = {e.mapping_type: e for e in events}
    assert by_mapping_type["taxonomy_node_to_ontology"].taxonomy_node_id == node.id
    assert by_mapping_type["raw_value_to_ontology"].taxonomy_node_id is None
    await db.rollback()


# ── P0.6: order-aware discovery ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_discovery_first_vs_recurrence_and_override(db):
    user, project = await _seed_project(db)
    record1 = await _seed_record(db, project)
    record2 = await _seed_record(db, project)

    ce1 = ConceptExtraction(project_id=project.id, record_id=record1.id, reviewer_id=user.id, origin="human",
                             extracted_json={"cells": {"f1": ["Fatigue"]}})
    ce2 = ConceptExtraction(project_id=project.id, record_id=record2.id, reviewer_id=user.id, origin="human",
                             extracted_json={"cells": {"f1": ["Fatigue"]}},
                             )
    db.add_all([ce1, ce2])
    await db.flush()
    ce2.extracted_json = {"cells": {"f1": ["Fatigue"]}, "novelty": {"f1": {"Fatigue": "new"}}}

    db.add(ConceptMention(project_id=project.id, concept_extraction_id=ce1.id, field_id="f1",
                           field_type="entity", value="Fatigue", origin="human", reviewer_id=user.id,
                           sequence_index=1))
    db.add(ConceptMention(project_id=project.id, concept_extraction_id=ce2.id, field_id="f1",
                           field_type="entity", value="Fatigue", origin="human", reviewer_id=user.id,
                           sequence_index=2))
    await db.commit()

    result = await compute_discovery(db, project.id, user.id)
    items = sorted(result["items"], key=lambda it: it["sequence_index"])
    assert items[0]["record_id"] == str(record1.id)
    assert items[0]["concepts"][0]["computed_status"] == "first"
    assert items[0]["concepts"][0]["effective_status"] == "first"

    assert items[1]["record_id"] == str(record2.id)
    concept2 = items[1]["concepts"][0]
    assert concept2["computed_status"] == "recurrent"
    assert concept2["override_status"] == "new"
    assert concept2["effective_status"] == "first"
    await db.rollback()


# ── P0.8: end-to-end provenance export round trip ───────────────────────────

@pytest.mark.asyncio
async def test_provenance_export_round_trip(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)

    ce = ConceptExtraction(project_id=project.id, record_id=record.id, reviewer_id=user.id, origin="human",
                            extracted_json={"cells": {"f1": ["Fatigue"]}})
    db.add(ce)
    await db.flush()
    await sync_mentions_for_extraction(db, ce, field_map=FIELD_MAP)
    await db.commit()

    mention = (await db.execute(
        select(ConceptMention).where(ConceptMention.concept_extraction_id == ce.id)
    )).scalar_one()

    node = ConceptTaxonomyNode(project_id=project.id, name="Fatigue", field_id="f1", field_type="entity")
    db.add(node)
    await db.flush()
    mention.canonical_node_id = node.id

    ontology_node = OntologyNode(project_id=project.id, name="Fatigue", namespace="concept")
    db.add(ontology_node)
    await db.flush()
    db.add(ConceptEvent(
        project_id=project.id, action="map_ontology", entity_type="ontology_mapping",
        taxonomy_node_id=node.id, ontology_node_id=ontology_node.id,
        mapping_type="taxonomy_node_to_ontology", actor_id=user.id,
    ))
    await db.commit()

    export = await build_provenance_export(db, project.id, record_id=record.id)
    assert export["project_id"] == str(project.id)
    assert len(export["items"]) == 1
    item = export["items"][0]

    ce_ids = {e["id"] for e in item["extractions"]}
    assert str(ce.id) in ce_ids

    assert len(item["mentions"]) == 1
    assert item["mentions"][0]["concept_extraction_id"] in ce_ids
    assert item["mentions"][0]["canonical_node_id"] == str(node.id)

    assert len(item["canonical_mappings"]) == 1
    assert item["canonical_mappings"][0]["canonical_node_id"] == str(node.id)

    mapping_events = [e for e in item["events"] if e["action"] == "map_ontology"]
    assert len(mapping_events) == 1
    assert mapping_events[0]["taxonomy_node_id"] == str(node.id)
    assert mapping_events[0]["ontology_node_id"] == str(ontology_node.id)

    assert len(item["ontology_mappings"]) == 1
    assert item["ontology_mappings"][0]["ontology_node_id"] == str(ontology_node.id)
    await db.rollback()
