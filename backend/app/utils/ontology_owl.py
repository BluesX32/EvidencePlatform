"""
OWL/RDF bridge for the ontology module — lets a project's concept tree be
opened and edited in Protégé Desktop and re-imported afterwards.

Two pure functions, no DB/I-O: `build_owl_graph` (DB rows -> rdflib.Graph)
and `parse_owl_graph` (rdflib.Graph -> plain dicts). The router does the I/O
and the upsert; this module only knows about the OWL <-> dict mapping.

Mapping (intentionally simple — a structural bridge, not a reasoning engine):
  OntologyNode      -> owl:Class, rdfs:label/comment/subClassOf,
                       + ep:namespace/color/position annotations so re-import
                       round-trips app-only fields exactly.
  OntologyEdge       -> one owl:AnnotationProperty per distinct label
                       (ep:rel_<slug>, rdfs:label = original text), asserted
                       as <source> ep:rel_<slug> <target>. Edge color is
                       cosmetic-only and is not preserved.

Node identity: each class IRI embeds the node's UUID
(EP_BASE/{project_id}/{node_id}). On import, a class whose IRI matches this
scheme and whose UUID exists in the project is an update to that node;
anything else (hand-authored in Protégé) is a new node.
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

from rdflib import RDF, RDFS, BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import OWL

EP_BASE = "https://evidenceplatform.org/ontology/"
EP = Namespace("https://evidenceplatform.org/ontology/schema#")

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def node_uri(project_id: "uuid.UUID | str", node_id: "uuid.UUID | str") -> URIRef:
    return URIRef(f"{EP_BASE}{project_id}/{node_id}")


def _slugify(label: str) -> str:
    slug = _SLUG_RE.sub("_", label.strip().lower()).strip("_")
    return slug or "rel"


def _parse_node_uri(iri: str) -> Optional[uuid.UUID]:
    """Return the embedded node UUID if `iri` matches our scheme, else None.

    Project scoping falls out naturally at import time: the caller only
    treats a recovered UUID as "existing" if it belongs to the target
    project, so a file exported from a different project's ontology always
    creates new nodes even though this parser doesn't itself check the
    embedded project segment.
    """
    if not iri.startswith(EP_BASE):
        return None
    tail = iri[len(EP_BASE):]
    parts = tail.split("/")
    if len(parts) != 2:
        return None
    try:
        uuid.UUID(parts[0])
        return uuid.UUID(parts[1])
    except ValueError:
        return None


def build_owl_graph(
    project_id: "uuid.UUID | str",
    nodes: List[Dict[str, Any]],
    edges: List[Dict[str, Any]],
) -> Graph:
    """Build an rdflib Graph from flat ontology_nodes/ontology_edges rows.

    `nodes` items need: id, parent_id, name, description, namespace, color, position.
    `edges` items need: source_id, target_id, label.
    """
    g = Graph()
    g.bind("owl", OWL)
    g.bind("rdfs", RDFS)
    g.bind("ep", EP)

    for n in nodes:
        subj = node_uri(project_id, n["id"])
        g.add((subj, RDF.type, OWL.Class))
        g.add((subj, RDFS.label, Literal(n["name"])))
        if n.get("description"):
            g.add((subj, RDFS.comment, Literal(n["description"])))
        if n.get("parent_id"):
            g.add((subj, RDFS.subClassOf, node_uri(project_id, n["parent_id"])))
        if n.get("namespace"):
            g.add((subj, EP.namespace, Literal(n["namespace"])))
        if n.get("color"):
            g.add((subj, EP.color, Literal(n["color"])))
        g.add((subj, EP.position, Literal(int(n.get("position") or 0))))

    declared_props: set = set()
    for e in edges:
        label = e.get("label") or "related_to"
        slug = _slugify(label)
        prop = EP[f"rel_{slug}"]
        if slug not in declared_props:
            g.add((prop, RDF.type, OWL.AnnotationProperty))
            g.add((prop, RDFS.label, Literal(label)))
            declared_props.add(slug)
        g.add((
            node_uri(project_id, e["source_id"]),
            prop,
            node_uri(project_id, e["target_id"]),
        ))

    return g


def build_owl_bytes(
    project_id: "uuid.UUID | str",
    nodes: List[Dict[str, Any]],
    edges: List[Dict[str, Any]],
    fmt: str = "turtle",
) -> bytes:
    g = build_owl_graph(project_id, nodes, edges)
    rdflib_format = "xml" if fmt == "xml" else "turtle"
    return g.serialize(format=rdflib_format).encode("utf-8")


class ParsedNode:
    def __init__(
        self,
        iri: str,
        node_id: Optional[uuid.UUID],
        name: str,
        description: Optional[str],
        namespace: str,
        color: Optional[str],
        position: int,
        parent_iri: Optional[str],
    ) -> None:
        self.iri = iri
        self.node_id = node_id  # None => new node, needs a fresh UUID
        self.name = name
        self.description = description
        self.namespace = namespace
        self.color = color
        self.position = position
        self.parent_iri = parent_iri


class ParsedEdge:
    def __init__(self, source_iri: str, target_iri: str, label: str) -> None:
        self.source_iri = source_iri
        self.target_iri = target_iri
        self.label = label


def parse_owl_graph(content: bytes, fmt: str = "turtle") -> Tuple[List[ParsedNode], List[ParsedEdge]]:
    """Parse an OWL/RDF file into plain ParsedNode/ParsedEdge lists.

    Recognizes any triple whose predicate starts with `ep:rel_` as an edge;
    everything else attached to an owl:Class is treated as node metadata.
    """
    g = Graph()
    rdflib_format = "xml" if fmt == "xml" else "turtle"
    g.parse(data=content, format=rdflib_format)

    rel_labels: Dict[URIRef, str] = {}
    for prop in g.subjects(RDF.type, OWL.AnnotationProperty):
        if isinstance(prop, URIRef) and str(prop).startswith(str(EP)):
            label = g.value(prop, RDFS.label)
            rel_labels[prop] = str(label) if label is not None else str(prop).rsplit("#", 1)[-1]

    nodes: List[ParsedNode] = []
    for cls in g.subjects(RDF.type, OWL.Class):
        if isinstance(cls, BNode):
            continue
        iri = str(cls)
        node_id = _parse_node_uri(iri)

        name_lit = g.value(cls, RDFS.label)
        name = str(name_lit) if name_lit is not None else iri.rsplit("/", 1)[-1].rsplit("#", 1)[-1]

        desc_lit = g.value(cls, RDFS.comment)
        description = str(desc_lit) if desc_lit is not None else None

        ns_lit = g.value(cls, EP.namespace)
        namespace = str(ns_lit) if ns_lit is not None else "entity"

        color_lit = g.value(cls, EP.color)
        color = str(color_lit) if color_lit is not None else None

        pos_lit = g.value(cls, EP.position)
        position = int(pos_lit) if pos_lit is not None else 0

        parent = g.value(cls, RDFS.subClassOf)
        parent_iri = str(parent) if parent is not None else None

        nodes.append(ParsedNode(iri, node_id, name, description, namespace, color, position, parent_iri))

    edges: List[ParsedEdge] = []
    for prop, label in rel_labels.items():
        for source, target in g.subject_objects(prop):
            if isinstance(source, BNode) or isinstance(target, BNode):
                continue
            edges.append(ParsedEdge(str(source), str(target), label))

    return nodes, edges
