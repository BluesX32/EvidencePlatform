"""Concept taxonomy — parent-child hierarchy and merge endpoints.

Endpoints:
  GET    /projects/{id}/concept-taxonomy/nodes          → list all nodes
  POST   /projects/{id}/concept-taxonomy/nodes          → get-or-create node
  PATCH  /projects/{id}/concept-taxonomy/nodes/{nid}    → rename / reparent
  DELETE /projects/{id}/concept-taxonomy/nodes/{nid}    → delete node
  POST   /projects/{id}/concept-taxonomy/merge          → merge nodes into one
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE
from app.models.concept_taxonomy_node import ConceptTaxonomyNode
from app.models.user import User

router = APIRouter(
    prefix="/projects/{project_id}/concept-taxonomy",
    tags=["concept_taxonomy"],
)


# ── Schemas ───────────────────────────────────────────────────────────────────

class NodeCreate(BaseModel):
    name: str
    field_id: str
    field_type: str
    description: Optional[str] = None


class NodeUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None  # "" or "null" → set to None (make root)
    description: Optional[str] = None
    clear_parent: bool = False        # explicit flag to remove parent


class MergeRequest(BaseModel):
    node_ids: List[str]                # existing node IDs to merge
    extra_values: Optional[List[Dict[str, str]]] = None  # [{name, field_id, field_type}] for raw values not yet nodes
    canonical_name: str                # name of the surviving node
    field_id: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _node_out(n: ConceptTaxonomyNode) -> Dict[str, Any]:
    return {
        "id": str(n.id),
        "project_id": str(n.project_id),
        "name": n.name,
        "field_id": n.field_id,
        "field_type": n.field_type,
        "parent_id": str(n.parent_id) if n.parent_id else None,
        "aliases": list(n.aliases or []),
        "description": n.description,
        "created_at": n.created_at.isoformat(),
        "updated_at": n.updated_at.isoformat(),
    }


async def _all_descendant_ids(
    db: AsyncSession,
    node_id: uuid.UUID,
    project_id: uuid.UUID,
) -> set[uuid.UUID]:
    """Return the set of all descendant IDs (not including node_id itself)."""
    visited: set[uuid.UUID] = set()
    queue = [node_id]
    while queue:
        current = queue.pop()
        rows = await db.execute(
            select(ConceptTaxonomyNode).where(
                ConceptTaxonomyNode.project_id == project_id,
                ConceptTaxonomyNode.parent_id == current,
            )
        )
        for child in rows.scalars().all():
            if child.id not in visited:
                visited.add(child.id)
                queue.append(child.id)
    return visited


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/nodes")
async def list_nodes(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)
    rows = await db.execute(
        select(ConceptTaxonomyNode)
        .where(ConceptTaxonomyNode.project_id == project_id)
        .order_by(ConceptTaxonomyNode.field_type, ConceptTaxonomyNode.name)
    )
    return [_node_out(n) for n in rows.scalars().all()]


@router.post("/nodes", status_code=200)
async def get_or_create_node(
    project_id: uuid.UUID,
    body: NodeCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Idempotent: returns existing node if (project, field_id, name) exists."""
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)

    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name must not be empty")

    existing = (await db.execute(
        select(ConceptTaxonomyNode).where(
            ConceptTaxonomyNode.project_id == project_id,
            ConceptTaxonomyNode.field_id == body.field_id,
            ConceptTaxonomyNode.name == name,
        )
    )).scalar_one_or_none()

    if existing:
        return _node_out(existing)

    node = ConceptTaxonomyNode(
        project_id=project_id,
        name=name,
        field_id=body.field_id,
        field_type=body.field_type,
        description=body.description,
    )
    db.add(node)
    await db.flush()
    await db.commit()
    await db.refresh(node)
    return _node_out(node)


@router.patch("/nodes/{node_id}")
async def update_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    body: NodeUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)

    node = (await db.execute(
        select(ConceptTaxonomyNode).where(
            ConceptTaxonomyNode.id == node_id,
            ConceptTaxonomyNode.project_id == project_id,
        )
    )).scalar_one_or_none()
    if node is None:
        raise HTTPException(404, "Node not found")

    if body.name is not None:
        node.name = body.name.strip() or node.name

    if body.description is not None:
        node.description = body.description

    if body.clear_parent:
        node.parent_id = None
    elif body.parent_id is not None:
        if body.parent_id in ("", "null"):
            node.parent_id = None
        else:
            new_parent_id = uuid.UUID(body.parent_id)
            if new_parent_id == node_id:
                raise HTTPException(422, "A node cannot be its own parent")
            # Prevent cycles: new parent must not be a descendant of this node
            descendants = await _all_descendant_ids(db, node_id, project_id)
            if new_parent_id in descendants:
                raise HTTPException(422, "Setting this parent would create a cycle")
            # Verify parent exists in same project
            parent = (await db.execute(
                select(ConceptTaxonomyNode).where(
                    ConceptTaxonomyNode.id == new_parent_id,
                    ConceptTaxonomyNode.project_id == project_id,
                )
            )).scalar_one_or_none()
            if parent is None:
                raise HTTPException(404, "Parent node not found")
            node.parent_id = new_parent_id

    try:
        await db.flush()
        await db.commit()
        await db.refresh(node)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, f"A node named '{body.name}' already exists in this field")

    return _node_out(node)


@router.delete("/nodes/{node_id}", status_code=204)
async def delete_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)
    node = (await db.execute(
        select(ConceptTaxonomyNode).where(
            ConceptTaxonomyNode.id == node_id,
            ConceptTaxonomyNode.project_id == project_id,
        )
    )).scalar_one_or_none()
    if node is None:
        raise HTTPException(404, "Node not found")
    await db.delete(node)
    await db.commit()


@router.post("/merge")
async def merge_nodes(
    project_id: uuid.UUID,
    body: MergeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Merge multiple nodes (and optional raw values) into one canonical node.

    All aliases and children from merged nodes are transferred to the canonical.
    Merged nodes are deleted.
    """
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)

    canonical_name = body.canonical_name.strip()
    if not canonical_name:
        raise HTTPException(422, "canonical_name must not be empty")

    # Load all source nodes
    source_nodes: List[ConceptTaxonomyNode] = []
    for nid_str in body.node_ids:
        try:
            nid = uuid.UUID(nid_str)
        except ValueError:
            raise HTTPException(422, f"Invalid node_id: {nid_str}")
        node = (await db.execute(
            select(ConceptTaxonomyNode).where(
                ConceptTaxonomyNode.id == nid,
                ConceptTaxonomyNode.project_id == project_id,
            )
        )).scalar_one_or_none()
        if node is None:
            raise HTTPException(404, f"Node {nid_str} not found")
        source_nodes.append(node)

    if len(source_nodes) + len(body.extra_values or []) < 1:
        raise HTTPException(422, "Provide at least one node or value to merge")

    # Determine field_type from first source node or extra_values
    field_type = source_nodes[0].field_type if source_nodes else (body.extra_values or [{}])[0].get("field_type", "entity")

    # Find or create the canonical node
    canonical = (await db.execute(
        select(ConceptTaxonomyNode).where(
            ConceptTaxonomyNode.project_id == project_id,
            ConceptTaxonomyNode.field_id == body.field_id,
            ConceptTaxonomyNode.name == canonical_name,
        )
    )).scalar_one_or_none()

    if canonical is None:
        canonical = ConceptTaxonomyNode(
            project_id=project_id,
            name=canonical_name,
            field_id=body.field_id,
            field_type=field_type,
        )
        db.add(canonical)
        await db.flush()

    # Collect all aliases from source nodes + their names + extra_values
    all_aliases: list[str] = list(canonical.aliases or [])
    for sn in source_nodes:
        if sn.id == canonical.id:
            continue
        # Add source node's name as alias (unless it is the canonical name)
        if sn.name != canonical_name and sn.name not in all_aliases:
            all_aliases.append(sn.name)
        # Absorb source node's aliases
        for alias in (sn.aliases or []):
            if alias != canonical_name and alias not in all_aliases:
                all_aliases.append(alias)
        # Re-parent any children of source node to canonical
        children_rows = await db.execute(
            select(ConceptTaxonomyNode).where(
                ConceptTaxonomyNode.parent_id == sn.id,
                ConceptTaxonomyNode.project_id == project_id,
            )
        )
        for child in children_rows.scalars().all():
            if child.id != canonical.id:
                child.parent_id = canonical.id

    # Add extra (raw) values as aliases
    for ev in (body.extra_values or []):
        ev_name = ev.get("name", "").strip()
        if ev_name and ev_name != canonical_name and ev_name not in all_aliases:
            all_aliases.append(ev_name)

    canonical.aliases = all_aliases

    # Delete source nodes (except canonical)
    for sn in source_nodes:
        if sn.id != canonical.id:
            await db.delete(sn)

    await db.commit()
    await db.refresh(canonical)
    return _node_out(canonical)
