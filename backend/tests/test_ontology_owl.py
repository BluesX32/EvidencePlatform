"""Tests for the OWL/RDF bridge (Protégé Desktop round trip).

Two layers:
- Pure round-trip tests for app.utils.ontology_owl (no DB).
- Integration tests calling the export_owl/import_owl router functions
  directly against a real DB, mirroring the pattern in
  tests/test_concept_provenance.py.
"""
from __future__ import annotations

import io
import uuid

import pytest
from rdflib import RDF, RDFS, Graph, Literal, URIRef
from rdflib.namespace import OWL
from sqlalchemy import select
from starlette.datastructures import UploadFile

from app.models.ontology_edge import OntologyEdge
from app.models.ontology_node import OntologyNode
from app.models.project import Project
from app.models.record import Record
from app.models.record_concept import RecordConcept
from app.models.user import User
from app.routers.ontology import (
    ConceptAssignBody,
    EdgeCreate,
    NodeCreate,
    assign_concept,
    create_edge,
    create_node,
    export_owl,
    import_owl,
)
from app.utils.ontology_owl import build_owl_bytes, node_uri, parse_owl_graph


async def _seed_project(db):
    user = User(email=f"owl-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()
    project = Project(name="OWL Bridge Test", created_by=user.id)
    db.add(project)
    await db.flush()
    return user, project


async def _seed_record(db, project):
    record = Record(project_id=project.id, title="Paper", source_format="ris")
    db.add(record)
    await db.flush()
    return record


# ---------------------------------------------------------------------------
# Pure round-trip tests (no DB)
# ---------------------------------------------------------------------------


def test_build_and_parse_roundtrip_preserves_node_fields():
    project_id = uuid.uuid4()
    root_id = uuid.uuid4()
    child_id = uuid.uuid4()
    nodes = [
        {
            "id": root_id, "parent_id": None, "name": "Symptom", "description": "top level",
            "namespace": "entity", "color": "#ff0000", "position": 0,
        },
        {
            "id": child_id, "parent_id": root_id, "name": "Fatigue", "description": None,
            "namespace": "entity", "color": None, "position": 1,
        },
    ]
    edges = [{"source_id": child_id, "target_id": root_id, "label": "is a subtype of"}]

    content = build_owl_bytes(project_id, nodes, edges, fmt="turtle")
    parsed_nodes, parsed_edges = parse_owl_graph(content, fmt="turtle")

    by_id = {n.node_id: n for n in parsed_nodes}
    assert set(by_id) == {root_id, child_id}
    assert by_id[root_id].name == "Symptom"
    assert by_id[root_id].description == "top level"
    assert by_id[root_id].color == "#ff0000"
    assert by_id[root_id].parent_iri is None
    assert by_id[child_id].name == "Fatigue"
    assert by_id[child_id].position == 1
    assert by_id[child_id].parent_iri == str(node_uri(project_id, root_id))

    assert len(parsed_edges) == 1
    edge = parsed_edges[0]
    assert edge.label == "is a subtype of"
    assert edge.source_iri == str(node_uri(project_id, child_id))
    assert edge.target_iri == str(node_uri(project_id, root_id))


def test_parse_recognizes_hand_authored_class_as_new_node():
    """A class with a non-EP IRI (e.g. authored directly in Protégé) has node_id=None."""
    g = Graph()
    external = URIRef("https://example.org/MyNewConcept")
    g.add((external, RDF.type, OWL.Class))
    g.add((external, RDFS.label, Literal("My New Concept")))
    content = g.serialize(format="turtle").encode("utf-8")

    parsed_nodes, _ = parse_owl_graph(content, fmt="turtle")
    assert len(parsed_nodes) == 1
    assert parsed_nodes[0].node_id is None
    assert parsed_nodes[0].name == "My New Concept"


# ---------------------------------------------------------------------------
# Integration tests (real DB, calling router functions directly)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_export_owl_produces_parseable_turtle(db):
    user, project = await _seed_project(db)
    await create_node(project.id, NodeCreate(name="Root"), current_user=user, db=db)

    resp = await export_owl(project.id, format="turtle", current_user=user, db=db)
    assert resp.media_type == "text/turtle"

    g = Graph()
    g.parse(data=resp.body, format="turtle")
    classes = list(g.subjects(RDF.type, OWL.Class))
    assert len(classes) == 1


@pytest.mark.asyncio
async def test_import_owl_creates_new_node_from_hand_authored_class(db):
    user, project = await _seed_project(db)

    g = Graph()
    external = URIRef("https://example.org/BrandNewConcept")
    g.add((external, RDF.type, OWL.Class))
    g.add((external, RDFS.label, Literal("Brand New Concept")))
    content = g.serialize(format="turtle").encode("utf-8")

    upload = UploadFile(file=io.BytesIO(content), filename="edited.ttl")
    result = await import_owl(project.id, file=upload, current_user=user, db=db)

    assert result["nodes_created"] == 1
    assert result["nodes_updated"] == 0

    nodes = await _list_nodes(db, project.id)
    assert len(nodes) == 1
    assert nodes[0].name == "Brand New Concept"


@pytest.mark.asyncio
async def test_reimport_unedited_export_is_a_noop(db):
    user, project = await _seed_project(db)
    await create_node(project.id, NodeCreate(name="Root"), current_user=user, db=db)
    await create_node(project.id, NodeCreate(name="Child"), current_user=user, db=db)

    resp = await export_owl(project.id, format="turtle", current_user=user, db=db)
    upload = UploadFile(file=io.BytesIO(resp.body), filename="ontology.ttl")
    result = await import_owl(project.id, file=upload, current_user=user, db=db)

    assert result["nodes_created"] == 0
    assert result["nodes_updated"] == 2

    nodes = await _list_nodes(db, project.id)
    assert len(nodes) == 2  # no duplicates


@pytest.mark.asyncio
async def test_reimport_renamed_node_updates_in_place_and_keeps_assignment(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)

    node = await create_node(project.id, NodeCreate(name="Fatigue"), current_user=user, db=db)
    node_id = uuid.UUID(node["id"])

    await assign_concept(
        project.id,
        ConceptAssignBody(record_id=record.id, node_id=node_id),
        current_user=user,
        db=db,
    )

    resp = await export_owl(project.id, format="turtle", current_user=user, db=db)
    g = Graph()
    g.parse(data=resp.body, format="turtle")
    subj = node_uri(project.id, node_id)
    g.set((subj, RDFS.label, Literal("Chronic Fatigue")))
    edited = g.serialize(format="turtle").encode("utf-8")

    upload = UploadFile(file=io.BytesIO(edited), filename="ontology.ttl")
    result = await import_owl(project.id, file=upload, current_user=user, db=db)

    assert result["nodes_created"] == 0
    assert result["nodes_updated"] == 1

    updated = (await db.execute(select(OntologyNode).where(OntologyNode.id == node_id))).scalar_one()
    assert updated.name == "Chronic Fatigue"

    assignment = (
        await db.execute(select(RecordConcept).where(RecordConcept.node_id == node_id))
    ).scalar_one_or_none()
    assert assignment is not None
    assert assignment.record_id == record.id


@pytest.mark.asyncio
async def test_edge_label_roundtrips_through_export_and_import(db):
    user, project = await _seed_project(db)
    a = await create_node(project.id, NodeCreate(name="A"), current_user=user, db=db)
    b = await create_node(project.id, NodeCreate(name="B"), current_user=user, db=db)
    await create_edge(
        project.id,
        EdgeCreate(source_id=uuid.UUID(a["id"]), target_id=uuid.UUID(b["id"]), label="causes"),
        current_user=user,
        db=db,
    )

    resp = await export_owl(project.id, format="turtle", current_user=user, db=db)
    upload = UploadFile(file=io.BytesIO(resp.body), filename="ontology.ttl")
    result = await import_owl(project.id, file=upload, current_user=user, db=db)

    assert result["edges_created"] == 0  # already existed, re-import is a no-op
    assert result["edges_updated"] == 0

    edges = (await db.execute(select(OntologyEdge).where(OntologyEdge.project_id == project.id))).scalars().all()
    assert len(edges) == 1
    assert edges[0].label == "causes"


async def _list_nodes(db, project_id):
    return (
        await db.execute(select(OntologyNode).where(OntologyNode.project_id == project_id))
    ).scalars().all()
