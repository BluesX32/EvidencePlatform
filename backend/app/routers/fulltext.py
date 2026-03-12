"""Full-text PDF upload/download endpoints (Sprint 18).

One PDF may be stored per article (record or cluster). Files are saved to
the local filesystem under uploads/{project_id}/.

POST /projects/{id}/fulltext               → FulltextPdfMeta   (upload)
GET  /projects/{id}/fulltext               → FulltextPdfMeta | null  (metadata by item key)
GET  /projects/{id}/fulltext/links         → list[FulltextLink]  (candidate URLs)
GET  /projects/{id}/fulltext/{pdf_id}/download → FileResponse
DELETE /projects/{id}/fulltext/{pdf_id}   → {}
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Any

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, REVIEWER_ROLE
from app.models.fulltext_pdf import FulltextPdf
from app.models.project import Project
from app.models.user import User
from app.services.fulltext_link_service import FulltextLink, resolve_links

router = APIRouter(tags=["fulltext"])

# Files stored under backend/uploads/<project_id>/<pdf_id>_<original_name>
UPLOADS_ROOT = Path("uploads")


# ── Auth helper ───────────────────────────────────────────────────────────────


async def _require_project(project_id: str, db: AsyncSession, user: User) -> Project:
    pid = uuid.UUID(project_id)
    await require_project_role(db, pid, user.id, allowed=REVIEWER_ROLE)
    row = await db.get(Project, pid)
    return row


# ── Schema ────────────────────────────────────────────────────────────────────


class FulltextPdfMeta(BaseModel):
    id: str
    original_filename: str
    file_size: int
    content_type: str
    uploaded_at: str
    drawing_data: Optional[Any] = None


# ── Helper ────────────────────────────────────────────────────────────────────


async def _find(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID],
    cluster_id: Optional[uuid.UUID],
) -> Optional[FulltextPdf]:
    if record_id:
        stmt = select(FulltextPdf).where(
            FulltextPdf.project_id == project_id,
            FulltextPdf.record_id == record_id,
        )
    elif cluster_id:
        stmt = select(FulltextPdf).where(
            FulltextPdf.project_id == project_id,
            FulltextPdf.cluster_id == cluster_id,
        )
    else:
        return None
    return (await db.execute(stmt)).scalar_one_or_none()


def _to_meta(row: FulltextPdf) -> FulltextPdfMeta:
    return FulltextPdfMeta(
        id=str(row.id),
        original_filename=row.original_filename,
        file_size=row.file_size,
        content_type=row.content_type,
        uploaded_at=row.uploaded_at.isoformat(),
        drawing_data=row.drawing_data,
    )


# ── Upload ────────────────────────────────────────────────────────────────────


@router.post("/projects/{project_id}/fulltext", response_model=FulltextPdfMeta)
async def upload_pdf(
    project_id: str,
    file: UploadFile = File(...),
    record_id: Optional[str] = Form(None),
    cluster_id: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FulltextPdfMeta:
    await _require_project(project_id, db, user)

    if not record_id and not cluster_id:
        raise HTTPException(400, "Provide record_id or cluster_id")
    if record_id and cluster_id:
        raise HTTPException(400, "Provide only one of record_id / cluster_id")

    pid = uuid.UUID(project_id)
    rid = uuid.UUID(record_id) if record_id else None
    cid = uuid.UUID(cluster_id) if cluster_id else None

    # If one already exists, delete the old file first
    existing = await _find(db, pid, rid, cid)
    if existing:
        old_path = Path(existing.storage_path)
        if old_path.exists():
            old_path.unlink()
        await db.delete(existing)
        await db.flush()

    # Read file
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file")

    # Sanitise filename
    safe_name = Path(file.filename or "upload.pdf").name
    if len(safe_name) > 200:
        safe_name = safe_name[-200:]

    # Persist to disk
    pdf_id = uuid.uuid4()
    project_dir = UPLOADS_ROOT / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    storage_path = project_dir / f"{pdf_id}_{safe_name}"
    storage_path.write_bytes(content)

    content_type = file.content_type or "application/pdf"

    row = FulltextPdf(
        id=pdf_id,
        project_id=pid,
        record_id=rid,
        cluster_id=cid,
        original_filename=safe_name,
        storage_path=str(storage_path),
        file_size=len(content),
        content_type=content_type,
        uploaded_by=user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_meta(row)


# ── Candidate links ───────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/fulltext/links", response_model=list[FulltextLink])
async def get_fulltext_links(
    project_id: str,
    doi: Optional[str] = None,
    pmid: Optional[str] = None,
    pmcid: Optional[str] = None,
    title: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[FulltextLink]:
    """Return a ranked list of candidate full-text URLs for a paper.

    The caller supplies whatever identifiers it has (doi/pmid/pmcid/title) and
    the service queries Unpaywall plus constructs static links for PMC, the
    publisher DOI resolver, PubMed, and Google Scholar.
    """
    await _require_project(project_id, db, user)
    return await resolve_links(doi=doi, pmid=pmid, pmcid=pmcid, title=title)


# ── Get metadata ──────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/fulltext")
async def get_pdf_meta(
    project_id: str,
    record_id: Optional[str] = None,
    cluster_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Optional[FulltextPdfMeta]:
    await _require_project(project_id, db, user)
    pid = uuid.UUID(project_id)
    rid = uuid.UUID(record_id) if record_id else None
    cid = uuid.UUID(cluster_id) if cluster_id else None
    row = await _find(db, pid, rid, cid)
    return _to_meta(row) if row else None


# ── Download ──────────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/fulltext/{pdf_id}/download")
async def download_pdf(
    project_id: str,
    pdf_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    await _require_project(project_id, db, user)
    row = await db.get(FulltextPdf, uuid.UUID(pdf_id))
    if not row or str(row.project_id) != project_id:
        raise HTTPException(404, "PDF not found")
    path = Path(row.storage_path)
    if not path.exists():
        raise HTTPException(404, "File missing from storage")
    return FileResponse(
        path=str(path),
        media_type=row.content_type,
        filename=row.original_filename,
        headers={"Content-Disposition": f'inline; filename="{row.original_filename}"'},
    )


# ── Delete ────────────────────────────────────────────────────────────────────


@router.delete("/projects/{project_id}/fulltext/{pdf_id}")
async def delete_pdf(
    project_id: str,
    pdf_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _require_project(project_id, db, user)
    row = await db.get(FulltextPdf, uuid.UUID(pdf_id))
    if not row or str(row.project_id) != project_id:
        raise HTTPException(404, "PDF not found")
    path = Path(row.storage_path)
    if path.exists():
        path.unlink()
    await db.delete(row)
    await db.commit()
    return {}


# ── Save drawing ──────────────────────────────────────────────────────────────


class DrawingSaveBody(BaseModel):
    drawing_data: Any


@router.patch("/projects/{project_id}/fulltext/{pdf_id}/drawing", response_model=FulltextPdfMeta)
async def save_drawing(
    project_id: str,
    pdf_id: str,
    body: DrawingSaveBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FulltextPdfMeta:
    await _require_project(project_id, db, user)
    row = await db.get(FulltextPdf, uuid.UUID(pdf_id))
    if not row or str(row.project_id) != project_id:
        raise HTTPException(404, "PDF not found")
    row.drawing_data = body.drawing_data
    await db.commit()
    await db.refresh(row)
    return _to_meta(row)