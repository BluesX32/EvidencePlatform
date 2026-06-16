"""Full-text PDF upload/download endpoints (Sprint 18 / migration 016+044).

One PDF file may be stored per article (record or cluster), shared across all
team members. Freehand drawing annotations are stored per-reviewer in the
pdf_drawing_annotations table (migration 044) so each reviewer's strokes never
overwrite another's.

POST   /projects/{id}/fulltext                        → FulltextPdfMeta   (upload; replace guarded to uploader/admin)
GET    /projects/{id}/fulltext                        → FulltextPdfMeta | null  (metadata + current user's drawings)
GET    /projects/{id}/fulltext/links                  → list[FulltextLink]
GET    /projects/{id}/fulltext/{pdf_id}/download      → FileResponse
DELETE /projects/{id}/fulltext/{pdf_id}               → {}  (uploader/admin only)
PATCH  /projects/{id}/fulltext/{pdf_id}/drawing       → FulltextPdfMeta  (per-reviewer UPSERT)
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func as sqlfunc, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import (
    ADMIN_ROLE,
    REVIEWER_ROLE,
    get_current_user,
    require_project_role,
)
from app.models.fulltext_pdf import FulltextPdf
from app.models.pdf_drawing_annotation import PdfDrawingAnnotation
from app.models.project import Project
from app.models.user import User
from app.services.fulltext_link_service import FulltextLink, resolve_links

router = APIRouter(tags=["fulltext"])

# Resolve UPLOADS_ROOT to an absolute path at startup so it is stable regardless
# of process working directory. Override with UPLOADS_DIR env var in production.
def _resolve_uploads_root() -> Path:
    if settings.uploads_dir:
        return Path(settings.uploads_dir).resolve()
    # Default: <backend_dir>/uploads/  (one level up from this file's package)
    return (Path(__file__).parent.parent.parent / "uploads").resolve()

UPLOADS_ROOT: Path = _resolve_uploads_root()


# ── Auth helper ───────────────────────────────────────────────────────────────


async def _require_project(project_id: str, db: AsyncSession, user: User) -> Project:
    pid = uuid.UUID(project_id)
    await require_project_role(db, pid, user.id, allowed=REVIEWER_ROLE)
    row = await db.get(Project, pid)
    return row


async def _get_role(project_id: str, db: AsyncSession, user: User) -> str:
    """Return the user's role string without raising on reviewer access."""
    pid = uuid.UUID(project_id)
    return await require_project_role(db, pid, user.id, allowed=REVIEWER_ROLE)


# ── Schema ────────────────────────────────────────────────────────────────────


class FulltextPdfMeta(BaseModel):
    id: str
    original_filename: str
    file_size: int
    content_type: str
    uploaded_at: str
    uploaded_by: Optional[str] = None
    drawing_data: Optional[Any] = None


# ── Helpers ───────────────────────────────────────────────────────────────────


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


async def _find_drawing(
    db: AsyncSession,
    pdf_id: uuid.UUID,
    reviewer_id: uuid.UUID,
) -> Optional[PdfDrawingAnnotation]:
    stmt = select(PdfDrawingAnnotation).where(
        PdfDrawingAnnotation.fulltext_pdf_id == pdf_id,
        PdfDrawingAnnotation.reviewer_id == reviewer_id,
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def _to_meta(row: FulltextPdf, drawing_data: Optional[Any] = None) -> FulltextPdfMeta:
    return FulltextPdfMeta(
        id=str(row.id),
        original_filename=row.original_filename,
        file_size=row.file_size,
        content_type=row.content_type,
        uploaded_at=row.uploaded_at.isoformat(),
        uploaded_by=str(row.uploaded_by) if row.uploaded_by else None,
        drawing_data=drawing_data,
    )


def _is_uploader_or_admin(row: FulltextPdf, user: User, role: str) -> bool:
    return role in ADMIN_ROLE or (row.uploaded_by is not None and row.uploaded_by == user.id)


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
    role = await _get_role(project_id, db, user)

    if not record_id and not cluster_id:
        raise HTTPException(400, "Provide record_id or cluster_id")
    if record_id and cluster_id:
        raise HTTPException(400, "Provide only one of record_id / cluster_id")

    pid = uuid.UUID(project_id)
    rid = uuid.UUID(record_id) if record_id else None
    cid = uuid.UUID(cluster_id) if cluster_id else None

    existing = await _find(db, pid, rid, cid)
    if existing:
        # Only the original uploader or an owner/admin may replace the shared PDF.
        if not _is_uploader_or_admin(existing, user, role):
            raise HTTPException(
                403,
                "Only the uploader or a project admin can replace this PDF.",
            )
        old_path = Path(existing.storage_path)
        if old_path.exists():
            old_path.unlink()
        await db.delete(existing)
        await db.flush()

    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file")

    safe_name = Path(file.filename or "upload.pdf").name
    if len(safe_name) > 200:
        safe_name = safe_name[-200:]

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
    """Return a ranked list of candidate full-text URLs for a paper."""
    await _require_project(project_id, db, user)
    return await resolve_links(doi=doi, pmid=pmid, pmcid=pmcid, title=title)


# ── Get metadata (with current user's drawing layer) ─────────────────────────


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
    if row is None:
        return None
    drawing = await _find_drawing(db, row.id, user.id)
    return _to_meta(row, drawing_data=drawing.drawing_data if drawing else None)


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
    # Try the stored path first, then fall back to resolving it under UPLOADS_ROOT
    # (handles servers where the path was stored as a relative path before the fix)
    path = Path(row.storage_path)
    if not path.is_absolute():
        path = (UPLOADS_ROOT.parent / row.storage_path).resolve()
    if not path.exists():
        raise HTTPException(
            404,
            f"PDF file is no longer available on the server. "
            f"The file '{row.original_filename}' was uploaded but the server "
            f"storage may have been reset. Please re-upload the PDF.",
        )
    from urllib.parse import quote
    safe_ascii = row.original_filename.encode("latin-1", errors="replace").decode("latin-1")
    encoded = quote(row.original_filename, safe="")
    content_disposition = f'inline; filename="{safe_ascii}"; filename*=UTF-8\'\'{encoded}'
    return FileResponse(
        path=str(path),
        media_type=row.content_type,
        headers={"Content-Disposition": content_disposition},
    )


# ── Delete (uploader/admin only) ──────────────────────────────────────────────


@router.delete("/projects/{project_id}/fulltext/{pdf_id}")
async def delete_pdf(
    project_id: str,
    pdf_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    role = await _get_role(project_id, db, user)
    row = await db.get(FulltextPdf, uuid.UUID(pdf_id))
    if not row or str(row.project_id) != project_id:
        raise HTTPException(404, "PDF not found")
    if not _is_uploader_or_admin(row, user, role):
        raise HTTPException(
            403,
            "Only the uploader or a project admin can delete this PDF.",
        )
    path = Path(row.storage_path)
    if path.exists():
        path.unlink()
    await db.delete(row)
    await db.commit()
    return {}


# ── Save drawing (per-reviewer UPSERT) ───────────────────────────────────────


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

    # UPSERT into pdf_drawing_annotations keyed by (fulltext_pdf_id, reviewer_id)
    stmt = (
        pg_insert(PdfDrawingAnnotation)
        .values(
            fulltext_pdf_id=row.id,
            reviewer_id=user.id,
            drawing_data=body.drawing_data,
        )
        .on_conflict_do_update(
            index_elements=["fulltext_pdf_id", "reviewer_id"],
            set_={
                "drawing_data": body.drawing_data,
                "updated_at": sqlfunc.now(),
            },
        )
    )
    await db.execute(stmt)
    await db.commit()
    return _to_meta(row, drawing_data=body.drawing_data)
