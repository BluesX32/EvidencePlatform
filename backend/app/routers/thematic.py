"""Thematic analysis endpoints (Sprint 17).

Themes and codes are ontology_nodes (namespace="theme"|"code").
code_extractions bridges codes to extraction_records.
thematic_history is the immutable audit trail.

GET  /projects/{id}/thematic                           → ThematicMap
POST /projects/{id}/thematic/themes                    → theme node
PATCH /projects/{id}/thematic/themes/{theme_id}        → theme node
DELETE /projects/{id}/thematic/themes/{theme_id}       → {}
POST /projects/{id}/thematic/codes                     → code node
PATCH /projects/{id}/thematic/codes/{code_id}          → code node
DELETE /projects/{id}/thematic/codes/{code_id}         → {}
GET  /projects/{id}/thematic/codes/{code_id}/evidence  → CodeEvidence[]
POST /projects/{id}/thematic/assignments               → {id}
DELETE /projects/{id}/thematic/assignments/{id}        → {}
GET  /projects/{id}/thematic/history                   → ThematicHistoryEntry[]
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import OntologyNode
from app.models.code_extraction import CodeExtraction
from app.models.extraction_record import ExtractionRecord
from app.models.project import Project
from app.models.thematic_history import ThematicHistory
from app.models.user import User
from app.dependencies import get_current_user

router = APIRouter(tags=["thematic"])


# ── Auth helper ───────────────────────────────────────────────────────────────


async def _require_project(
    project_id: str,
    db: AsyncSession,
    user: User,
) -> Project:
    row = await db.get(Project, uuid.UUID(project_id))
    if row is None:
        raise HTTPException(404, "Project not found")
    if str(row.created_by) != str(user.id):
        raise HTTPException(403, "Forbidden")
    return row


# ── Pydantic schemas ───────────────────────────────────────────────────────────


class ThemeCode(BaseModel):
    id: str
    name: str
    description: Optional[str]
    color: Optional[str]
    evidence_count: int


class ThemeItem(BaseModel):
    id: str
    name: str
    description: Optional[str]
    color: Optional[str]
    codes: list[ThemeCode]


class ThematicMap(BaseModel):
    themes: list[ThemeItem]
    ungrouped_codes: list[ThemeCode]


class CodeEvidence(BaseModel):
    assignment_id: str
    extraction_id: str
    record_id: Optional[str]
    cluster_id: Optional[str]
    title: Optional[str]
    year: Optional[int]
    authors: Optional[list[str]]
    snippet_text: Optional[str]
    note: Optional[str]
    assigned_at: str


class ThematicHistoryEntry(BaseModel):
    id: str
    code_id: Optional[str]
    code_name: str
    action: str
    old_theme_name: Optional[str]
    new_theme_name: Optional[str]
    note: Optional[str]
    changed_at: str


class CreateThemeBody(BaseModel):
    name: str
    description: Optional[str] = None
    color: Optional[str] = None


class UpdateThemeBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None


class CreateCodeBody(BaseModel):
    name: str
    theme_id: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None


class UpdateCodeBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    # Provide theme_id to move; omit to keep current; set clear_theme=True to ungroup
    theme_id: Optional[str] = None
    clear_theme: bool = False


class AssignCodeBody(BaseModel):
    code_id: str
    extraction_id: str
    snippet_text: Optional[str] = None
    note: Optional[str] = None


# ── Helper: evidence counts per code ──────────────────────────────────────────


async def _evidence_counts(
    db: AsyncSession,
    project_id: uuid.UUID,
    code_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    if not code_ids:
        return {}
    stmt = (
        select(CodeExtraction.code_id, func.count().label("cnt"))
        .where(
            CodeExtraction.project_id == project_id,
            CodeExtraction.code_id.in_(code_ids),
        )
        .group_by(CodeExtraction.code_id)
    )
    rows = (await db.execute(stmt)).all()
    return {r.code_id: r.cnt for r in rows}


# ── GET /thematic ──────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/thematic", response_model=ThematicMap)
async def get_thematic_map(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ThematicMap:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)

    themes = (
        await db.execute(
            select(OntologyNode)
            .where(OntologyNode.project_id == pid, OntologyNode.namespace == "theme")
            .order_by(OntologyNode.position, OntologyNode.name)
        )
    ).scalars().all()

    codes = (
        await db.execute(
            select(OntologyNode)
            .where(OntologyNode.project_id == pid, OntologyNode.namespace == "code")
            .order_by(OntologyNode.position, OntologyNode.name)
        )
    ).scalars().all()

    counts = await _evidence_counts(db, pid, [c.id for c in codes])
    theme_map = {t.id: t for t in themes}
    theme_codes: dict[uuid.UUID, list[ThemeCode]] = {t.id: [] for t in themes}
    ungrouped: list[ThemeCode] = []

    for code in codes:
        tc = ThemeCode(
            id=str(code.id),
            name=code.name,
            description=code.description,
            color=code.color,
            evidence_count=counts.get(code.id, 0),
        )
        if code.parent_id and code.parent_id in theme_map:
            theme_codes[code.parent_id].append(tc)
        else:
            ungrouped.append(tc)

    return ThematicMap(
        themes=[
            ThemeItem(
                id=str(t.id),
                name=t.name,
                description=t.description,
                color=t.color,
                codes=theme_codes[t.id],
            )
            for t in themes
        ],
        ungrouped_codes=ungrouped,
    )


# ── Theme CRUD ────────────────────────────────────────────────────────────────


@router.post("/projects/{project_id}/thematic/themes")
async def create_theme(
    project_id: str,
    body: CreateThemeBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)

    node = OntologyNode(
        project_id=pid,
        name=body.name,
        description=body.description,
        color=body.color,
        namespace="theme",
        parent_id=None,
    )
    db.add(node)
    await db.flush()

    db.add(
        ThematicHistory(
            project_id=pid,
            code_id=None,
            code_name=body.name,
            action="create_theme",
            new_theme_name=body.name,
            changed_by=user.id,
        )
    )
    await db.commit()
    await db.refresh(node)
    return {"id": str(node.id), "name": node.name, "description": node.description, "color": node.color}


@router.patch("/projects/{project_id}/thematic/themes/{theme_id}")
async def update_theme(
    project_id: str,
    theme_id: str,
    body: UpdateThemeBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    node = await db.get(OntologyNode, uuid.UUID(theme_id))
    if not node or str(node.project_id) != project_id or node.namespace != "theme":
        raise HTTPException(404, "Theme not found")

    if body.name is not None and body.name != node.name:
        db.add(
            ThematicHistory(
                project_id=node.project_id,
                code_id=None,
                code_name=node.name,
                action="rename_theme",
                old_theme_name=node.name,
                new_theme_name=body.name,
                changed_by=user.id,
            )
        )
        node.name = body.name
    if body.description is not None:
        node.description = body.description
    if body.color is not None:
        node.color = body.color

    await db.commit()
    await db.refresh(node)
    return {"id": str(node.id), "name": node.name, "description": node.description, "color": node.color}


@router.delete("/projects/{project_id}/thematic/themes/{theme_id}")
async def delete_theme(
    project_id: str,
    theme_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Delete a theme. Its codes become ungrouped (parent_id → NULL)."""
    await _require_project(project_id, db, user)
    tid = uuid.UUID(theme_id)
    node = await db.get(OntologyNode, tid)
    if not node or str(node.project_id) != project_id or node.namespace != "theme":
        raise HTTPException(404, "Theme not found")

    # Ungroup codes before deleting (FK ondelete=SET NULL only fires on node
    # delete, but we want codes to survive as ungrouped)
    await db.execute(
        update(OntologyNode).where(OntologyNode.parent_id == tid).values(parent_id=None)
    )
    await db.delete(node)
    await db.commit()
    return {}


# ── Code CRUD ─────────────────────────────────────────────────────────────────


@router.post("/projects/{project_id}/thematic/codes")
async def create_code(
    project_id: str,
    body: CreateCodeBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)

    parent_id: Optional[uuid.UUID] = None
    theme_name: Optional[str] = None
    if body.theme_id:
        parent_id = uuid.UUID(body.theme_id)
        theme = await db.get(OntologyNode, parent_id)
        if theme:
            theme_name = theme.name

    node = OntologyNode(
        project_id=pid,
        name=body.name,
        description=body.description,
        color=body.color,
        namespace="code",
        parent_id=parent_id,
    )
    db.add(node)
    await db.flush()

    db.add(
        ThematicHistory(
            project_id=pid,
            code_id=node.id,
            code_name=body.name,
            action="create_code",
            new_theme_id=parent_id,
            new_theme_name=theme_name,
            changed_by=user.id,
        )
    )
    await db.commit()
    await db.refresh(node)
    return {
        "id": str(node.id),
        "name": node.name,
        "description": node.description,
        "color": node.color,
        "theme_id": str(node.parent_id) if node.parent_id else None,
    }


@router.patch("/projects/{project_id}/thematic/codes/{code_id}")
async def update_code(
    project_id: str,
    code_id: str,
    body: UpdateCodeBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)
    node = await db.get(OntologyNode, uuid.UUID(code_id))
    if not node or str(node.project_id) != project_id or node.namespace != "code":
        raise HTTPException(404, "Code not found")

    # Capture old theme for history
    old_parent_id = node.parent_id
    old_theme_name: Optional[str] = None
    if old_parent_id:
        old_theme = await db.get(OntologyNode, old_parent_id)
        if old_theme:
            old_theme_name = old_theme.name

    old_name = node.name
    if body.name is not None:
        node.name = body.name
    if body.description is not None:
        node.description = body.description
    if body.color is not None:
        node.color = body.color

    # Theme reassignment
    theme_changed = False
    new_theme_name: Optional[str] = None
    if body.clear_theme:
        node.parent_id = None
        theme_changed = old_parent_id is not None
    elif body.theme_id is not None:
        new_pid = uuid.UUID(body.theme_id)
        if new_pid != old_parent_id:
            node.parent_id = new_pid
            theme_changed = True
            new_theme = await db.get(OntologyNode, new_pid)
            if new_theme:
                new_theme_name = new_theme.name

    if theme_changed:
        db.add(
            ThematicHistory(
                project_id=pid,
                code_id=node.id,
                code_name=node.name,
                action="assign_theme",
                old_theme_id=old_parent_id,
                old_theme_name=old_theme_name,
                new_theme_id=node.parent_id,
                new_theme_name=new_theme_name,
                changed_by=user.id,
            )
        )
    elif body.name is not None and body.name != old_name:
        db.add(
            ThematicHistory(
                project_id=pid,
                code_id=node.id,
                code_name=body.name,
                action="rename_code",
                old_theme_name=old_name,
                new_theme_name=body.name,
                changed_by=user.id,
            )
        )

    await db.commit()
    await db.refresh(node)
    return {
        "id": str(node.id),
        "name": node.name,
        "description": node.description,
        "color": node.color,
        "theme_id": str(node.parent_id) if node.parent_id else None,
    }


@router.delete("/projects/{project_id}/thematic/codes/{code_id}")
async def delete_code(
    project_id: str,
    code_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    node = await db.get(OntologyNode, uuid.UUID(code_id))
    if not node or str(node.project_id) != project_id or node.namespace != "code":
        raise HTTPException(404, "Code not found")
    await db.delete(node)
    await db.commit()
    return {}


# ── Code evidence (code → supporting papers) ──────────────────────────────────

_EVIDENCE_SQL = text("""
SELECT
    ce.id               AS assignment_id,
    ce.extraction_id,
    er.record_id,
    er.cluster_id,
    ce.snippet_text,
    ce.note,
    ce.assigned_at,
    COALESCE(r.title,   cr.title)           AS title,
    COALESCE(r.year,    cr.year)::int        AS year,
    COALESCE(r.authors, cr.authors)          AS authors
FROM code_extractions ce
JOIN extraction_records er ON er.id = ce.extraction_id
-- Direct record path
LEFT JOIN records r ON r.id = er.record_id
-- Cluster path: pick one representative record alphabetically
LEFT JOIN LATERAL (
    SELECT rec.title, rec.year, rec.authors
    FROM overlap_cluster_members ocm
    JOIN record_sources rs ON rs.id = ocm.record_source_id
    JOIN records rec ON rec.id = rs.record_id
    WHERE ocm.cluster_id = er.cluster_id
    ORDER BY rec.id
    LIMIT 1
) cr ON er.cluster_id IS NOT NULL
WHERE ce.code_id = :code_id
  AND ce.project_id = :project_id
ORDER BY ce.assigned_at DESC
""")


@router.get(
    "/projects/{project_id}/thematic/codes/{code_id}/evidence",
    response_model=list[CodeEvidence],
)
async def get_code_evidence(
    project_id: str,
    code_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CodeEvidence]:
    await _require_project(project_id, db, user)
    rows = (
        await db.execute(
            _EVIDENCE_SQL,
            {"code_id": uuid.UUID(code_id), "project_id": uuid.UUID(project_id)},
        )
    ).all()
    return [
        CodeEvidence(
            assignment_id=str(r.assignment_id),
            extraction_id=str(r.extraction_id),
            record_id=str(r.record_id) if r.record_id else None,
            cluster_id=str(r.cluster_id) if r.cluster_id else None,
            title=r.title,
            year=r.year,
            authors=list(r.authors) if r.authors else None,
            snippet_text=r.snippet_text,
            note=r.note,
            assigned_at=r.assigned_at.isoformat(),
        )
        for r in rows
    ]


# ── Assignments ───────────────────────────────────────────────────────────────


@router.post("/projects/{project_id}/thematic/assignments")
async def assign_code(
    project_id: str,
    body: AssignCodeBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)

    code = await db.get(OntologyNode, uuid.UUID(body.code_id))
    if not code or str(code.project_id) != project_id:
        raise HTTPException(404, "Code not found")

    ext = await db.get(ExtractionRecord, uuid.UUID(body.extraction_id))
    if not ext or str(ext.project_id) != project_id:
        raise HTTPException(404, "Extraction not found")

    assignment = CodeExtraction(
        project_id=pid,
        code_id=uuid.UUID(body.code_id),
        extraction_id=uuid.UUID(body.extraction_id),
        snippet_text=body.snippet_text,
        note=body.note,
        assigned_by=user.id,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)
    return {"id": str(assignment.id)}


@router.delete("/projects/{project_id}/thematic/assignments/{assignment_id}")
async def remove_assignment(
    project_id: str,
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    row = await db.get(CodeExtraction, uuid.UUID(assignment_id))
    if not row or str(row.project_id) != project_id:
        raise HTTPException(404, "Assignment not found")
    await db.delete(row)
    await db.commit()
    return {}


# ── History ───────────────────────────────────────────────────────────────────


@router.get(
    "/projects/{project_id}/thematic/history",
    response_model=list[ThematicHistoryEntry],
)
async def get_history(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ThematicHistoryEntry]:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)
    rows = (
        await db.execute(
            select(ThematicHistory)
            .where(ThematicHistory.project_id == pid)
            .order_by(ThematicHistory.changed_at.desc())
            .limit(500)
        )
    ).scalars().all()
    return [
        ThematicHistoryEntry(
            id=str(r.id),
            code_id=str(r.code_id) if r.code_id else None,
            code_name=r.code_name,
            action=r.action,
            old_theme_name=r.old_theme_name,
            new_theme_name=r.new_theme_name,
            note=r.note,
            changed_at=r.changed_at.isoformat(),
        )
        for r in rows
    ]