import uuid
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.overlap_repo import OverlapRepo
from app.repositories.project_repo import ProjectRepo
from app.repositories.record_repo import RecordRepo

router = APIRouter(prefix="/projects", tags=["records"])

_VALID_SORTS = {
    "title_asc", "title_desc",
    "year_asc", "year_desc",
    "author_asc", "author_desc",
    "journal_asc", "journal_desc",
    "created_asc", "created_desc",
}

_VALID_STATUSES = {"unscreened", "included", "excluded"}


class RecordItem(BaseModel):
    id: str
    title: Optional[str]
    abstract: Optional[str]
    authors: Optional[List[str]]
    year: Optional[int]
    journal: Optional[str]
    volume: Optional[str]
    issue: Optional[str]
    pages: Optional[str]
    doi: Optional[str]
    issn: Optional[str]
    keywords: Optional[List[str]]
    sources: List[str]
    match_basis: Optional[str]
    created_at: str

    @classmethod
    def from_orm(cls, r):
        return cls(
            id=str(r.id),
            title=r.title,
            abstract=r.abstract,
            authors=r.authors,
            year=r.year,
            journal=r.journal,
            volume=r.volume,
            issue=r.issue,
            pages=r.pages,
            doi=r.doi,
            issn=r.issn,
            keywords=r.keywords,
            sources=r.sources or [],
            match_basis=r.match_basis,
            created_at=r.created_at.isoformat(),
        )


class YearRange(BaseModel):
    min: Optional[int]
    max: Optional[int]


class PaginatedRecords(BaseModel):
    records: List[RecordItem]
    total: int
    page: int
    per_page: int
    total_pages: int
    year_range: YearRange


class OverlapSourceItem(BaseModel):
    id: str
    name: str
    total: int
    with_doi: int


class OverlapPair(BaseModel):
    source_a_id: str
    source_a_name: str
    source_b_id: str
    source_b_name: str
    shared_records: int


class OverlapSummary(BaseModel):
    sources: List[OverlapSourceItem]
    pairs: List[OverlapPair]
    strategy_name: Optional[str]


async def _require_project_access(project_id: uuid.UUID, user: User, db: AsyncSession):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return project


@router.get("/{project_id}/records", response_model=PaginatedRecords)
async def list_records(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    q: Optional[str] = Query(None),
    sort: str = Query("year_desc"),
    source_id: Optional[uuid.UUID] = Query(None),
    source_ids: List[uuid.UUID] = Query(default=[]),
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
    ta_status: Optional[str] = Query(None),
    ft_status: Optional[str] = Query(None),
    has_extraction: Optional[bool] = Query(None),
):
    await _require_project_access(project_id, current_user, db)

    if sort not in _VALID_SORTS:
        sort = "year_desc"

    # Silently ignore invalid status values
    effective_ta = ta_status if ta_status in _VALID_STATUSES else None
    effective_ft = ft_status if ft_status in _VALID_STATUSES else None

    rows, total, year_range = await RecordRepo.list_paginated(
        db,
        project_id,
        page,
        per_page,
        q=q,
        sort=sort,
        source_id=source_id,
        source_ids=source_ids or None,
        year_min=year_min,
        year_max=year_max,
        ta_status=effective_ta,
        ft_status=effective_ft,
        has_extraction=has_extraction,
    )
    total_pages = max(1, (total + per_page - 1) // per_page)

    return PaginatedRecords(
        records=[RecordItem.from_orm(r) for r in rows],
        total=total,
        page=page,
        per_page=per_page,
        total_pages=total_pages,
        year_range=YearRange(min=year_range["min"], max=year_range["max"]),
    )


@router.get("/{project_id}/overlap", response_model=OverlapSummary)
async def get_overlap(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _require_project_access(project_id, current_user, db)

    totals = await OverlapRepo.source_totals(db, project_id)
    pairs = await OverlapRepo.pairwise_overlap(db, project_id)
    strategy_name = await OverlapRepo.active_strategy_name(db, project_id)

    return OverlapSummary(
        sources=[
            OverlapSourceItem(
                id=str(row.id),
                name=row.name,
                total=row.total,
                with_doi=row.with_doi,
            )
            for row in totals
        ],
        pairs=[
            OverlapPair(
                source_a_id=str(row.source_a_id),
                source_a_name=row.source_a_name,
                source_b_id=str(row.source_b_id),
                source_b_name=row.source_b_name,
                shared_records=row.shared_records,
            )
            for row in pairs
        ],
        strategy_name=strategy_name,
    )
