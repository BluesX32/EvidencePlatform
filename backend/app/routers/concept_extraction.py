"""Concept extraction endpoints.

Concept templates define structured fields for extracting entities and relations
from screened papers. Concept extractions store per-item responses.

Endpoints:
  POST   /projects/{id}/concept-extractions           → upsert concept extraction for an item
  GET    /projects/{id}/concept-extractions/item      → get concept extraction for one record/cluster
  GET    /projects/{id}/concept-extractions/aggregate → taxonomy aggregation (values × field_type)
  POST   /projects/{id}/concept-extractions/push-to-ontology → create ontology nodes from selected values
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE, ADMIN_ROLE
from app.models.concept_extraction import ConceptExtraction
from app.models.ontology_node import OntologyNode
from app.models.user import User
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects/{project_id}/concept-extractions", tags=["concept_extraction"])


# ── Pydantic models ──────────────────────────────────────────────────────────

class ConceptExtractionUpsert(BaseModel):
    record_id: Optional[str] = None
    cluster_id: Optional[str] = None
    extracted_json: Dict[str, Any] = {}


class ConceptExtractionOut(BaseModel):
    id: str
    project_id: str
    record_id: Optional[str]
    cluster_id: Optional[str]
    extracted_json: Dict[str, Any]
    reviewer_id: Optional[str]
    created_at: str
    updated_at: str


class TaxonomyEntry(BaseModel):
    value: str
    field_id: str
    field_label: str
    field_type: str   # "entity" | "relation" | "metadata"
    count: int
    record_ids: List[str]


class TaxonomyAggregate(BaseModel):
    entity: List[TaxonomyEntry]
    relation: List[TaxonomyEntry]
    metadata: List[TaxonomyEntry]


class PushItem(BaseModel):
    value: str
    field_type: str   # "entity" | "relation" | "metadata"
    namespace: Optional[str] = None  # override default namespace
    parent_id: Optional[str] = None


class PushToOntologyRequest(BaseModel):
    items: List[PushItem]


class PushToOntologyResult(BaseModel):
    created: int
    skipped: int   # already exists by (project, parent, name)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _ce_out(ce: ConceptExtraction) -> ConceptExtractionOut:
    return ConceptExtractionOut(
        id=str(ce.id),
        project_id=str(ce.project_id),
        record_id=str(ce.record_id) if ce.record_id else None,
        cluster_id=str(ce.cluster_id) if ce.cluster_id else None,
        extracted_json=ce.extracted_json or {},
        reviewer_id=str(ce.reviewer_id) if ce.reviewer_id else None,
        created_at=ce.created_at.isoformat(),
        updated_at=ce.updated_at.isoformat(),
    )


def _default_namespace(field_type: str) -> str:
    if field_type == "entity":
        return "concept"
    if field_type == "relation":
        return "relationships"
    return "concept"


# ── Upsert concept extraction ─────────────────────────────────────────────────

@router.post("", response_model=ConceptExtractionOut, status_code=200)
async def upsert_concept_extraction(
    project_id: uuid.UUID,
    body: ConceptExtractionUpsert,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)

    if not body.record_id and not body.cluster_id:
        raise HTTPException(400, "Provide record_id or cluster_id")
    if body.record_id and body.cluster_id:
        raise HTTPException(400, "Provide only one of record_id or cluster_id")

    record_id = uuid.UUID(body.record_id) if body.record_id else None
    cluster_id = uuid.UUID(body.cluster_id) if body.cluster_id else None

    # Look for existing row (per reviewer)
    stmt = select(ConceptExtraction).where(
        ConceptExtraction.project_id == project_id,
        ConceptExtraction.reviewer_id == current_user.id,
    )
    if record_id:
        stmt = stmt.where(ConceptExtraction.record_id == record_id)
    else:
        stmt = stmt.where(ConceptExtraction.cluster_id == cluster_id)

    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    if existing:
        existing.extracted_json = body.extracted_json
        await db.commit()
        await db.refresh(existing)
        return _ce_out(existing)

    ce = ConceptExtraction(
        project_id=project_id,
        record_id=record_id,
        cluster_id=cluster_id,
        extracted_json=body.extracted_json,
        reviewer_id=current_user.id,
    )
    db.add(ce)
    await db.commit()
    await db.refresh(ce)
    return _ce_out(ce)


# ── List all concept extractions for a project ────────────────────────────────

@router.get("", response_model=List[ConceptExtractionOut])
async def list_concept_extractions(
    project_id: uuid.UUID,
    as_reviewer_id: Optional[uuid.UUID] = Query(None, description="Admin only: list another reviewer's extractions"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return concept extractions for this project scoped to one reviewer.

    Admins may pass ?as_reviewer_id= to view a specific reviewer's extractions
    (e.g. for the chart in reviewer canvas mode).  Everyone else sees their own.
    """
    role = await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)
    if as_reviewer_id and role in ADMIN_ROLE:
        target_reviewer = as_reviewer_id
    else:
        target_reviewer = current_user.id
    stmt = (
        select(ConceptExtraction)
        .where(
            ConceptExtraction.project_id == project_id,
            ConceptExtraction.reviewer_id == target_reviewer,
        )
        .order_by(ConceptExtraction.updated_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [_ce_out(r) for r in rows]


# ── Get concept extraction for one item ───────────────────────────────────────

@router.get("/item", response_model=List[ConceptExtractionOut])
async def get_item_concept_extraction(
    project_id: uuid.UUID,
    record_id: Optional[str] = Query(None),
    cluster_id: Optional[str] = Query(None),
    as_reviewer_id: Optional[uuid.UUID] = Query(None, description="Admin only: view a specific reviewer's extraction"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)

    if not record_id and not cluster_id:
        raise HTTPException(400, "Provide record_id or cluster_id")

    # The form always shows one reviewer's extraction.
    # Admins may pass as_reviewer_id to inspect another reviewer's row;
    # everyone else (and admins who don't pass it) sees their own row.
    if as_reviewer_id and role in ADMIN_ROLE:
        target_reviewer = as_reviewer_id
    else:
        target_reviewer = current_user.id

    stmt = (
        select(ConceptExtraction)
        .where(
            ConceptExtraction.project_id == project_id,
            ConceptExtraction.reviewer_id == target_reviewer,
        )
    )
    if record_id:
        stmt = stmt.where(ConceptExtraction.record_id == uuid.UUID(record_id))
    else:
        stmt = stmt.where(ConceptExtraction.cluster_id == uuid.UUID(cluster_id))

    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [_ce_out(r) for r in rows]


# ── Taxonomy aggregate ─────────────────────────────────────────────────────────

@router.get("/aggregate", response_model=TaxonomyAggregate)
async def get_taxonomy_aggregate(
    project_id: uuid.UUID,
    as_reviewer_id: Optional[uuid.UUID] = Query(None, description="Admin only: aggregate for a specific reviewer"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns concept extraction values grouped by field_type (entity/relation/metadata).
    Reviewers see only their own concepts (zipper model: forms are per-reviewer, so the
    aggregate is also per-reviewer).  Owners/admins see all reviewers combined unless
    ?as_reviewer_id= is supplied, in which case only that reviewer's data is returned.
    """
    project = await ProjectRepo.get_by_id(db, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    concept_template = project.concept_template or {}
    fields = concept_template.get("fields", [])
    field_map: Dict[str, Dict] = {f["id"]: f for f in fields}

    role = await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)

    stmt = select(ConceptExtraction).where(ConceptExtraction.project_id == project_id)
    if role not in ADMIN_ROLE:
        # Reviewers always see only their own aggregate.
        stmt = stmt.where(ConceptExtraction.reviewer_id == current_user.id)
    elif as_reviewer_id:
        # Admins can scope to a specific reviewer (for canvas mode).
        stmt = stmt.where(ConceptExtraction.reviewer_id == as_reviewer_id)
    result = await db.execute(stmt)
    extractions = result.scalars().all()

    # Aggregate: (field_id, value) → {field_type, field_label, count, record_ids}
    key_data: Dict[tuple, Dict] = {}

    for ce in extractions:
        item_id = str(ce.record_id or ce.cluster_id)
        cells = ce.extracted_json.get("cells", {})
        for field_id, raw_value in cells.items():
            field_info = field_map.get(field_id)
            if not field_info:
                continue
            values = raw_value if isinstance(raw_value, list) else [raw_value] if raw_value else []
            for v in values:
                v = v.strip() if isinstance(v, str) else str(v)
                if not v:
                    continue
                key = (field_id, v)
                if key not in key_data:
                    key_data[key] = {
                        "field_id": field_id,
                        "field_label": field_info.get("label", field_id),
                        "field_type": field_info.get("field_type", "metadata"),
                        "value": v,
                        "count": 0,
                        "record_ids": [],
                    }
                key_data[key]["count"] += 1
                key_data[key]["record_ids"].append(item_id)

    buckets: Dict[str, List[TaxonomyEntry]] = {"entity": [], "relation": [], "metadata": []}
    for data in sorted(key_data.values(), key=lambda x: -x["count"]):
        ft = data["field_type"]
        if ft not in buckets:
            ft = "metadata"
        buckets[ft].append(TaxonomyEntry(
            value=data["value"],
            field_id=data["field_id"],
            field_label=data["field_label"],
            field_type=data["field_type"],
            count=data["count"],
            record_ids=list(dict.fromkeys(data["record_ids"])),
        ))

    return TaxonomyAggregate(**buckets)


# ── Push to ontology ────────────────────────────────────────────────────────────

@router.post("/push-to-ontology", response_model=PushToOntologyResult)
async def push_to_ontology(
    project_id: uuid.UUID,
    body: PushToOntologyRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create ontology nodes from selected taxonomy values."""
    await require_project_role(db, project_id, current_user.id, allowed=ADMIN_ROLE)

    created = 0
    skipped = 0

    for item in body.items:
        namespace = item.namespace or _default_namespace(item.field_type)
        parent_id = uuid.UUID(item.parent_id) if item.parent_id else None
        name = item.value.strip()
        if not name:
            continue

        # Check for existing node with same (project, parent, name)
        stmt = select(OntologyNode).where(
            OntologyNode.project_id == project_id,
            OntologyNode.name == name,
            OntologyNode.parent_id == parent_id,
        )
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing:
            skipped += 1
            continue

        # Determine position among siblings
        sib_stmt = select(OntologyNode).where(
            OntologyNode.project_id == project_id,
            OntologyNode.parent_id == parent_id,
        )
        sib_result = await db.execute(sib_stmt)
        siblings = sib_result.scalars().all()
        position = max((s.position for s in siblings), default=-1) + 1

        node = OntologyNode(
            project_id=project_id,
            parent_id=parent_id,
            name=name,
            namespace=namespace,
            position=position,
        )
        db.add(node)
        created += 1

    await db.commit()
    return PushToOntologyResult(created=created, skipped=skipped)
