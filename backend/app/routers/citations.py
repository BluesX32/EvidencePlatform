"""Citation sourcing (snowballing) endpoints.

POST   /projects/{id}/citations/searches                               → start a search (202)
GET    /projects/{id}/citations/searches                               → list search history
GET    /projects/{id}/citations/searches/{search_id}                   → single search status
DELETE /projects/{id}/citations/searches/{search_id}                   → delete a search + all candidates
GET    /projects/{id}/citations/searches/{search_id}/candidates        → paginated candidates
DELETE /projects/{id}/citations/searches/{search_id}/candidates/{cid} → delete one candidate
PATCH  /projects/{id}/citations/searches/{search_id}/candidates/{cid} → select/deselect
POST   /projects/{id}/citations/searches/{search_id}/import            → import selected candidates (202)
GET    /projects/{id}/citations/searches/{search_id}/sources           → source articles for this search
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import (
    ADMIN_ROLE,
    ANY_ROLE,
    REVIEWER_ROLE,
    get_current_user,
    require_project_role,
)
from app.models.user import User
from app.services import citation_service

router = APIRouter(
    prefix="/projects/{project_id}/citations",
    tags=["citations"],
)


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class StartSearchBody(BaseModel):
    direction: str = "both"          # backward | forward | both
    scope: str = "all"               # all | new | custom
    record_ids: Optional[List[str]] = None  # UUIDs when scope='custom'


class DecisionBody(BaseModel):
    decision: Optional[str] = None   # include | null (clears selection)
    notes: Optional[str] = None


class CitationSearchResponse(BaseModel):
    id: str
    project_id: str
    triggered_by: Optional[str]
    status: str
    direction: str
    scope: Optional[str]
    candidate_count: Optional[int]
    already_in_project_count: Optional[int]
    source_record_count: Optional[int]
    source_record_ids: Optional[List[str]]
    error_msg: Optional[str]
    created_at: str
    completed_at: Optional[str]


class CitationCandidateResponse(BaseModel):
    id: str
    search_id: str
    direction: str
    source_record_id: Optional[str]
    s2_paper_id: Optional[str]
    title: Optional[str]
    abstract: Optional[str]
    authors: Optional[List[str]]
    year: Optional[int]
    doi: Optional[str]
    pmid: Optional[str]
    journal: Optional[str]
    in_project: bool
    project_record_id: Optional[str]
    decision: Optional[str]
    decided_by: Optional[str]
    decided_at: Optional[str]
    notes: Optional[str]
    import_job_id: Optional[str]
    created_at: str


class PaginatedCandidatesResponse(BaseModel):
    items: List[CitationCandidateResponse]
    total: int
    page: int
    per_page: int
    total_pages: int


class SourceArticleResponse(BaseModel):
    record_id: str
    title: Optional[str]
    year: Optional[int]
    candidate_count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _search_to_response(s: Any, project_id: uuid.UUID) -> CitationSearchResponse:
    return CitationSearchResponse(
        id=str(s.id),
        project_id=str(project_id),
        triggered_by=str(s.triggered_by) if s.triggered_by else None,
        status=s.status,
        direction=s.direction,
        scope=s.scope,
        candidate_count=s.candidate_count,
        already_in_project_count=s.already_in_project_count,
        source_record_count=s.source_record_count,
        source_record_ids=[str(r) for r in s.source_record_ids] if s.source_record_ids else None,
        error_msg=s.error_msg,
        created_at=s.created_at.isoformat(),
        completed_at=s.completed_at.isoformat() if s.completed_at else None,
    )


def _candidate_to_response(c: Any) -> CitationCandidateResponse:
    return CitationCandidateResponse(
        id=str(c.id),
        search_id=str(c.search_id),
        direction=c.direction,
        source_record_id=str(c.source_record_id) if c.source_record_id else None,
        s2_paper_id=c.s2_paper_id,
        title=c.title,
        abstract=c.abstract,
        authors=list(c.authors) if c.authors else None,
        year=c.year,
        doi=c.doi,
        pmid=c.pmid,
        journal=c.journal,
        in_project=c.in_project,
        project_record_id=str(c.project_record_id) if c.project_record_id else None,
        decision=c.decision,
        decided_by=str(c.decided_by) if c.decided_by else None,
        decided_at=c.decided_at.isoformat() if c.decided_at else None,
        notes=c.notes,
        import_job_id=str(c.import_job_id) if c.import_job_id else None,
        created_at=c.created_at.isoformat(),
    )


async def _require_project(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
    allowed=ANY_ROLE,
) -> None:
    await require_project_role(db, project_id, current_user.id, allowed=allowed)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/searches", status_code=202)
async def start_search(
    project_id: uuid.UUID,
    body: StartSearchBody,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CitationSearchResponse:
    """Start a citation snowballing search. Returns immediately; runs in background.

    How it works: the platform resolves each extracted paper's Semantic Scholar ID
    (via DOI or PMID), then fetches the complete reference list (backward sourcing)
    and/or the papers that cite it (forward sourcing) from the Semantic Scholar Graph
    API. Results are cross-deduplicated so each unique paper appears once, checked
    against records already in the project, and stored for researcher review.
    Selecting papers and clicking Import sends them through the standard import
    pipeline — including deduplication and overlap detection — so they enter the
    screening workflow exactly like database imports.
    """
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)

    valid_directions = {"backward", "forward", "both"}
    if body.direction not in valid_directions:
        raise HTTPException(
            status_code=400,
            detail=f"direction must be one of {sorted(valid_directions)}",
        )

    valid_scopes = {"all", "new", "custom"}
    if body.scope not in valid_scopes:
        raise HTTPException(
            status_code=400,
            detail=f"scope must be one of {sorted(valid_scopes)}",
        )

    record_ids: Optional[list] = None
    if body.scope == "custom" and body.record_ids:
        try:
            record_ids = [uuid.UUID(r) for r in body.record_ids]
        except ValueError:
            raise HTTPException(status_code=400, detail="record_ids contains invalid UUIDs")

    search = await citation_service.start_citation_search(
        db, project_id, current_user.id, body.direction, body.scope, record_ids
    )
    background_tasks.add_task(
        citation_service.run_citation_search,
        search.id,
        project_id,
        body.scope,
        record_ids,
    )
    return _search_to_response(search, project_id)


@router.get("/searches")
async def list_searches(
    project_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[CitationSearchResponse]:
    """Return search history for the project."""
    await _require_project(project_id, current_user, db)
    searches = await citation_service.list_searches(db, project_id)
    return [_search_to_response(s, project_id) for s in searches]


@router.get("/searches/{search_id}")
async def get_search(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CitationSearchResponse:
    """Return a single search (including live status while running)."""
    await _require_project(project_id, current_user, db)
    search = await citation_service.get_search(db, search_id, project_id)
    if search is None:
        raise HTTPException(status_code=404, detail="Citation search not found")
    return _search_to_response(search, project_id)


@router.delete("/searches/{search_id}", status_code=204)
async def delete_search(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a citation search and all its candidates."""
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)
    deleted = await citation_service.delete_search(db, search_id, project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Citation search not found")


@router.get("/searches/{search_id}/candidates")
async def list_candidates(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    page: int = 1,
    per_page: int = 25,
    decision: Optional[str] = None,
    direction: Optional[str] = None,
    source_record_id: Optional[uuid.UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginatedCandidatesResponse:
    """Return paginated candidates for a search.

    Query params:
      decision         — all | unselected | include
      direction        — both | backward | forward
      source_record_id — filter to candidates discovered from one specific source paper
    """
    await _require_project(project_id, current_user, db)
    if page < 1:
        page = 1
    if per_page < 1 or per_page > 100:
        per_page = 25

    result = await citation_service.list_candidates(
        db,
        search_id=search_id,
        project_id=project_id,
        page=page,
        per_page=per_page,
        decision_filter=decision,
        direction_filter=direction,
        source_record_id_filter=source_record_id,
    )
    return PaginatedCandidatesResponse(
        items=[_candidate_to_response(c) for c in result["items"]],
        total=result["total"],
        page=result["page"],
        per_page=result["per_page"],
        total_pages=result["total_pages"],
    )


@router.delete("/searches/{search_id}/candidates/{candidate_id}", status_code=204)
async def delete_candidate(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    candidate_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a single candidate from a search."""
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)
    deleted = await citation_service.delete_candidate(db, search_id, candidate_id, project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Candidate not found")


@router.patch("/searches/{search_id}/candidates/{candidate_id}")
async def decide_candidate(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    candidate_id: uuid.UUID,
    body: DecisionBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CitationCandidateResponse:
    """Select (include) or deselect a candidate. Pass decision=null to deselect."""
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)
    try:
        candidate = await citation_service.submit_candidate_decision(
            db,
            search_id=search_id,
            candidate_id=candidate_id,
            project_id=project_id,
            decision=body.decision,
            notes=body.notes,
            reviewer_id=current_user.id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _candidate_to_response(candidate)


@router.post("/searches/{search_id}/import", status_code=202)
async def import_selected(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Import all selected (decision='include') candidates into the project.

    Each group of candidates originating from the same source paper is imported
    under its own named source (e.g. '← Refs: Smith 2020'), so the origin of
    each imported paper is visible in the Extraction Library's Sources column.
    """
    await _require_project(project_id, current_user, db, allowed=ADMIN_ROLE)

    search = await citation_service.get_search(db, search_id, project_id)
    if search is None:
        raise HTTPException(status_code=404, detail="Citation search not found")
    if search.status != "completed":
        raise HTTPException(
            status_code=400, detail="Search must be completed before importing"
        )

    from sqlalchemy import select as sa_select
    from app.models.citation_candidate import CitationCandidate

    count_result = await db.execute(
        sa_select(CitationCandidate).where(
            CitationCandidate.search_id == search_id,
            CitationCandidate.project_id == project_id,
            CitationCandidate.decision == "include",
            CitationCandidate.import_job_id.is_(None),
        )
    )
    pending = list(count_result.scalars().all())
    if not pending:
        raise HTTPException(status_code=400, detail="No selected candidates to import")

    background_tasks.add_task(
        citation_service.import_selected_candidates,
        search_id,
        project_id,
        current_user.id,
    )
    return {"message": f"Import started for {len(pending)} candidates"}


@router.get("/searches/{search_id}/sources")
async def list_source_articles(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[SourceArticleResponse]:
    """Return the extracted papers that were used as source for this search.

    Useful for filtering candidates by origin paper.
    """
    await _require_project(project_id, current_user, db)
    sources = await citation_service.list_source_articles(db, search_id, project_id)
    return [
        SourceArticleResponse(
            record_id=s["record_id"],
            title=s["title"],
            year=s["year"],
            candidate_count=s["candidate_count"],
        )
        for s in sources
    ]
