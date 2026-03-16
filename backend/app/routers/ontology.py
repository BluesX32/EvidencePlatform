"""Ontology / taxonomy management endpoints (Sprint 17 / migration 014).

All nodes are scoped to a project and form an arbitrary-depth forest.

Node CRUD:
  GET    /projects/{id}/ontology                  → flat list (depth-first order)
  POST   /projects/{id}/ontology                  → create node
  PATCH  /projects/{id}/ontology/{node_id}        → update node
  DELETE /projects/{id}/ontology/{node_id}        → delete; promote children to grandparent

Bulk operations:
  POST   /projects/{id}/ontology/sync-levels      → import project criteria.levels as nodes
  GET    /projects/{id}/ontology/export           → JSON tree export
  POST   /projects/{id}/ontology/import           → bulk import from JSON tree
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE
from app.models.ontology_node import OntologyNode
from app.models.record_concept import RecordConcept
from app.models.user import User
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects/{project_id}/ontology", tags=["ontology"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

VALID_NAMESPACES = {"level", "dimension", "relationships", "thematic"}


async def _require_project(project_id: uuid.UUID, current_user: User, db: AsyncSession):
    await require_project_role(db, project_id, current_user.id, allowed=REVIEWER_ROLE)
    project = await ProjectRepo.get_by_id(db, project_id)
    return project


def _node_out(n: OntologyNode) -> Dict[str, Any]:
    return {
        "id": str(n.id),
        "project_id": str(n.project_id),
        "parent_id": str(n.parent_id) if n.parent_id else None,
        "name": n.name,
        "description": n.description,
        "namespace": n.namespace,
        "color": n.color,
        "position": n.position,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    }


# Recursive CTE: returns all nodes for a project in depth-first order.
# The path array guarantees depth-first (parent before children, siblings by position).
_TREE_ORDER_SQL = text(
    """
    WITH RECURSIVE tree AS (
        SELECT
            id, project_id, parent_id, name, description,
            namespace, color, position, created_at, updated_at,
            0 AS depth,
            ARRAY[position, 0] AS sort_path
        FROM ontology_nodes
        WHERE project_id = :project_id AND parent_id IS NULL

        UNION ALL

        SELECT
            n.id, n.project_id, n.parent_id, n.name, n.description,
            n.namespace, n.color, n.position, n.created_at, n.updated_at,
            t.depth + 1,
            t.sort_path || ARRAY[n.position, 0]
        FROM ontology_nodes n
        JOIN tree t ON n.parent_id = t.id
        WHERE n.project_id = :project_id
    )
    SELECT * FROM tree ORDER BY sort_path
    """
)


async def _load_tree_flat(project_id: uuid.UUID, db: AsyncSession) -> List[Dict[str, Any]]:
    """Return all nodes in depth-first order with depth information."""
    rows = (await db.execute(_TREE_ORDER_SQL, {"project_id": str(project_id)})).mappings().all()
    return [
        {
            "id": str(r["id"]),
            "project_id": str(r["project_id"]),
            "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
            "name": r["name"],
            "description": r["description"],
            "namespace": r["namespace"],
            "color": r["color"],
            "position": r["position"],
            "depth": r["depth"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


def _build_json_tree(flat: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert flat depth-first list into nested JSON tree."""
    by_id: Dict[str, Dict[str, Any]] = {}
    roots: List[Dict[str, Any]] = []
    for node in flat:
        node = dict(node)
        node["children"] = []
        by_id[node["id"]] = node
        if node["parent_id"] and node["parent_id"] in by_id:
            by_id[node["parent_id"]]["children"].append(node)
        else:
            roots.append(node)
    return roots


async def _next_position(project_id: uuid.UUID, parent_id: Optional[uuid.UUID], db: AsyncSession) -> int:
    """Return position = count of existing siblings (append to end)."""
    q = select(OntologyNode).where(OntologyNode.project_id == project_id)
    if parent_id is None:
        q = q.where(OntologyNode.parent_id.is_(None))
    else:
        q = q.where(OntologyNode.parent_id == parent_id)
    siblings = (await db.execute(q)).scalars().all()
    return len(siblings)


async def _is_ancestor(candidate_id: uuid.UUID, node_id: uuid.UUID, db: AsyncSession) -> bool:
    """Return True if candidate_id is an ancestor of node_id (cycle check)."""
    # Walk up from candidate toward root; if we reach node_id, cycle detected.
    current = candidate_id
    visited: set = set()
    while current is not None:
        if current == node_id:
            return True
        if current in visited:
            break
        visited.add(current)
        row = (
            await db.execute(
                select(OntologyNode.parent_id).where(OntologyNode.id == current)
            )
        ).scalar_one_or_none()
        if row is None:
            break
        current = row
    return False


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class NodeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    parent_id: Optional[uuid.UUID] = None
    namespace: str = Field("level", pattern=r"^[a-z_]+$")
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")


class NodeUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    parent_id: Optional[uuid.UUID] = None
    clear_parent: bool = False  # set True to make the node a root
    namespace: Optional[str] = Field(None, pattern=r"^[a-z_]+$")
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    clear_color: bool = False
    position: Optional[int] = None


class SyncLevelsRequest(BaseModel):
    namespace: str = Field("level", pattern=r"^[a-z_]+$")  # level | dimension | relationships
    under_node_id: Optional[uuid.UUID] = None  # attach under this parent; None = root


class ImportRequest(BaseModel):
    nodes: List[Dict[str, Any]]  # JSON tree (same format as export)
    merge: bool = True  # if True, skip nodes whose name+parent already exist


# ---------------------------------------------------------------------------
# Node CRUD
# ---------------------------------------------------------------------------


@router.get("")
async def list_nodes(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Return all nodes in depth-first order (includes `depth` field)."""
    await _require_project(project_id, current_user, db)
    return await _load_tree_flat(project_id, db)


@router.post("", status_code=201)
async def create_node(
    project_id: uuid.UUID,
    body: NodeCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Create a new ontology node. parent_id=null creates a root node."""
    await _require_project(project_id, current_user, db)

    if body.namespace not in VALID_NAMESPACES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid namespace. Choose from: {sorted(VALID_NAMESPACES)}",
        )

    # Verify parent exists in this project
    if body.parent_id is not None:
        p = (
            await db.execute(
                select(OntologyNode).where(
                    OntologyNode.id == body.parent_id,
                    OntologyNode.project_id == project_id,
                )
            )
        ).scalar_one_or_none()
        if p is None:
            raise HTTPException(status_code=404, detail="Parent node not found")

    pos = await _next_position(project_id, body.parent_id, db)
    node = OntologyNode(
        project_id=project_id,
        parent_id=body.parent_id,
        name=body.name.strip(),
        description=body.description,
        namespace=body.namespace,
        color=body.color,
        position=pos,
    )
    db.add(node)
    try:
        await db.flush()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A sibling named '{body.name}' already exists under this parent",
        )
    return _node_out(node)


@router.patch("/{node_id}")
async def update_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    body: NodeUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Update node metadata or reparent it. Validates no cycles when reparenting."""
    await _require_project(project_id, current_user, db)

    node = (
        await db.execute(
            select(OntologyNode).where(
                OntologyNode.id == node_id,
                OntologyNode.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")

    if body.name is not None:
        node.name = body.name.strip()
    if body.description is not None:
        node.description = body.description
    if body.namespace is not None:
        if body.namespace not in VALID_NAMESPACES:
            raise HTTPException(status_code=422, detail="Invalid namespace")
        node.namespace = body.namespace
    if body.clear_color:
        node.color = None
    elif body.color is not None:
        node.color = body.color
    if body.position is not None:
        node.position = body.position

    # Reparent
    if body.clear_parent:
        node.parent_id = None
    elif body.parent_id is not None:
        if body.parent_id == node_id:
            raise HTTPException(status_code=422, detail="A node cannot be its own parent")
        # Cycle check: new parent must not be a descendant of this node
        if await _is_ancestor(body.parent_id, node_id, db):
            raise HTTPException(
                status_code=422,
                detail="Cannot reparent: new parent is a descendant of this node",
            )
        # Verify parent in project
        p = (
            await db.execute(
                select(OntologyNode).where(
                    OntologyNode.id == body.parent_id,
                    OntologyNode.project_id == project_id,
                )
            )
        ).scalar_one_or_none()
        if p is None:
            raise HTTPException(status_code=404, detail="Parent node not found")
        node.parent_id = body.parent_id

    try:
        await db.flush()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A sibling named '{body.name}' already exists under this parent",
        )
    return _node_out(node)


@router.delete("/{node_id}", status_code=204)
async def delete_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a node. Its children are promoted to the deleted node's parent (SET NULL cascade)."""
    await _require_project(project_id, current_user, db)

    node = (
        await db.execute(
            select(OntologyNode).where(
                OntologyNode.id == node_id,
                OntologyNode.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")

    # Promote children: update their parent_id to node's parent_id before deleting
    grandparent_id = node.parent_id
    await db.execute(
        update(OntologyNode)
        .where(
            OntologyNode.parent_id == node_id,
            OntologyNode.project_id == project_id,
        )
        .values(parent_id=grandparent_id)
    )
    await db.delete(node)
    await db.commit()


# ---------------------------------------------------------------------------
# Sync from extraction levels
# ---------------------------------------------------------------------------


@router.post("/sync-levels", status_code=200)
async def sync_levels(
    project_id: uuid.UUID,
    body: SyncLevelsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Import project criteria.levels into the ontology tree.

    Each level becomes a node under `under_node_id` (or as a root).
    Levels already present as siblings are skipped (idempotent).
    Returns { created: int, skipped: int }.
    """
    project = await _require_project(project_id, current_user, db)

    criteria = project.criteria or {}
    levels: List[str] = criteria.get("levels", [])

    if not levels:
        return {"created": 0, "skipped": 0, "message": "No levels found in project criteria"}

    # Validate under_node_id
    if body.under_node_id is not None:
        anchor = (
            await db.execute(
                select(OntologyNode).where(
                    OntologyNode.id == body.under_node_id,
                    OntologyNode.project_id == project_id,
                )
            )
        ).scalar_one_or_none()
        if anchor is None:
            raise HTTPException(status_code=404, detail="Anchor node not found")

    # Fetch existing siblings to detect duplicates
    q = select(OntologyNode.name).where(OntologyNode.project_id == project_id)
    if body.under_node_id is None:
        q = q.where(OntologyNode.parent_id.is_(None))
    else:
        q = q.where(OntologyNode.parent_id == body.under_node_id)
    existing_names = {r for r in (await db.execute(q)).scalars().all()}

    pos_offset = await _next_position(project_id, body.under_node_id, db)
    created = 0
    skipped = 0
    for i, level in enumerate(levels):
        level = level.strip()
        if not level or level in existing_names:
            skipped += 1
            continue
        node = OntologyNode(
            project_id=project_id,
            parent_id=body.under_node_id,
            name=level,
            namespace=body.namespace,
            position=pos_offset + i,
        )
        db.add(node)
        existing_names.add(level)
        created += 1

    await db.commit()
    return {"created": created, "skipped": skipped}


# ---------------------------------------------------------------------------
# Export / Import
# ---------------------------------------------------------------------------


@router.get("/export")
async def export_tree(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Export the full ontology as a nested JSON tree."""
    await _require_project(project_id, current_user, db)
    flat = await _load_tree_flat(project_id, db)
    tree = _build_json_tree(flat)
    return {
        "project_id": str(project_id),
        "format": "evidence-platform-ontology-v1",
        "nodes": tree,
    }


@router.post("/import", status_code=201)
async def import_tree(
    project_id: uuid.UUID,
    body: ImportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Bulk-import nodes from a JSON tree (same format as /export).

    With merge=true (default), existing nodes with the same name+parent are skipped.
    """
    await _require_project(project_id, current_user, db)

    created = 0
    skipped = 0

    async def _import_nodes(
        nodes: List[Dict[str, Any]], parent_id: Optional[uuid.UUID]
    ) -> None:
        nonlocal created, skipped
        for i, node_data in enumerate(nodes):
            name = str(node_data.get("name", "")).strip()
            if not name:
                continue

            existing: Optional[OntologyNode] = None
            if body.merge:
                q = select(OntologyNode).where(
                    OntologyNode.project_id == project_id,
                    OntologyNode.name == name,
                )
                if parent_id is None:
                    q = q.where(OntologyNode.parent_id.is_(None))
                else:
                    q = q.where(OntologyNode.parent_id == parent_id)
                existing = (await db.execute(q)).scalar_one_or_none()

            if existing is not None:
                skipped += 1
                node_id = existing.id
            else:
                node = OntologyNode(
                    project_id=project_id,
                    parent_id=parent_id,
                    name=name,
                    description=node_data.get("description"),
                    namespace=node_data.get("namespace", "concept"),
                    color=node_data.get("color"),
                    position=i,
                )
                db.add(node)
                await db.flush()
                node_id = node.id
                created += 1

            children = node_data.get("children", [])
            if children:
                await _import_nodes(children, node_id)

    await _import_nodes(body.nodes, parent_id=None)
    await db.commit()
    return {"created": created, "skipped": skipped}


# ---------------------------------------------------------------------------
# Concept assignments (record_concepts)
# ---------------------------------------------------------------------------


class ConceptAssignBody(BaseModel):
    record_id: Optional[uuid.UUID] = None
    cluster_id: Optional[uuid.UUID] = None
    node_id: uuid.UUID


@router.post("/concepts/assign", status_code=201)
async def assign_concept(
    project_id: uuid.UUID,
    body: ConceptAssignBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Assign an ontology node to a record or cluster."""
    await _require_project(project_id, current_user, db)

    if (body.record_id is None) == (body.cluster_id is None):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of record_id or cluster_id",
        )

    # Verify node belongs to this project
    node = (
        await db.execute(
            select(OntologyNode).where(
                OntologyNode.id == body.node_id,
                OntologyNode.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if node is None:
        raise HTTPException(status_code=404, detail="Ontology node not found")

    rc = RecordConcept(
        project_id=project_id,
        record_id=body.record_id,
        cluster_id=body.cluster_id,
        node_id=body.node_id,
        assigned_by=current_user.id,
    )
    db.add(rc)
    try:
        await db.flush()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Concept already assigned to this item")

    return {"id": str(rc.id), "node_id": str(rc.node_id)}


@router.delete("/concepts/assign", status_code=204)
async def unassign_concept(
    project_id: uuid.UUID,
    body: ConceptAssignBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove an ontology node assignment from a record or cluster."""
    await _require_project(project_id, current_user, db)

    q = select(RecordConcept).where(
        RecordConcept.project_id == project_id,
        RecordConcept.node_id == body.node_id,
    )
    if body.record_id is not None:
        q = q.where(RecordConcept.record_id == body.record_id)
    else:
        q = q.where(RecordConcept.cluster_id == body.cluster_id)

    rc = (await db.execute(q)).scalar_one_or_none()
    if rc is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    await db.delete(rc)
    await db.commit()


@router.get("/concepts/item")
async def get_item_concepts(
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID] = None,
    cluster_id: Optional[uuid.UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Return all ontology nodes assigned to a specific record or cluster."""
    await _require_project(project_id, current_user, db)

    if record_id is None and cluster_id is None:
        raise HTTPException(
            status_code=422, detail="Provide record_id or cluster_id"
        )

    q = (
        select(OntologyNode)
        .join(RecordConcept, RecordConcept.node_id == OntologyNode.id)
        .where(RecordConcept.project_id == project_id)
    )
    if record_id is not None:
        q = q.where(RecordConcept.record_id == record_id)
    else:
        q = q.where(RecordConcept.cluster_id == cluster_id)

    nodes = (await db.execute(q)).scalars().all()
    return [_node_out(n) for n in nodes]
