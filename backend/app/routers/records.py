import uuid
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.record_repo import RecordRepo

router = APIRouter(prefix="/projects", tags=["records"])

_VALID_SORTS = {"title_asc", "title_desc", "year_asc", "year_desc"}


class RecordItem(BaseModel):
    id: str
    title: Optional[str]
    authors: Optional[List[str]]
    year: Optional[int]
    journal: Optional[str]
    volume: Optional[str]
    issue: Optional[str]
    pages: Optional[str]
    doi: Optional[str]
    source_format: str
    import_job_id: str
    created_at: str

    @classmethod
    def from_orm(cls, r):
        return cls(
            id=str(r.id),
            title=r.title,
            authors=r.authors,
            year=r.year,
            journal=r.journal,
            volume=r.volume,
            issue=r.issue,
            pages=r.pages,
            doi=r.doi,
            source_format=r.source_format,
            import_job_id=str(r.import_job_id),
            created_at=r.created_at.isoformat(),
        )


class PaginatedRecords(BaseModel):
    records: List[RecordItem]
    total: int
    page: int
    per_page: int
    total_pages: int


@router.get("/{project_id}/records", response_model=PaginatedRecords)
async def list_records(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    q: Optional[str] = Query(None),
    sort: str = Query("year_desc"),
):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.created_by != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    if sort not in _VALID_SORTS:
        sort = "year_desc"

    rows, total = await RecordRepo.list_paginated(db, project_id, page, per_page, q, sort)
    total_pages = max(1, (total + per_page - 1) // per_page)

    return PaginatedRecords(
        records=[RecordItem.from_orm(r) for r in rows],
        total=total,
        page=page,
        per_page=per_page,
        total_pages=total_pages,
    )
