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

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Response, UploadFile

logger = logging.getLogger(__name__)
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


@router.post("/searches/manual", status_code=201)
async def manual_import(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    direction: str = Form(...),
    source_record_id: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CitationSearchResponse:
    """Import a citation file (RIS or MEDLINE) manually as a citation source.

    Unlike the automatic Semantic Scholar search, this endpoint accepts a
    user-uploaded file and creates a completed CitationSearch synchronously.
    Each record in the file becomes a CitationCandidate tagged with the
    given direction (backward = references of the source paper; forward =
    papers citing it) and optionally linked to a specific extracted paper.

    Accepts: RIS (.ris) or MEDLINE/PubMed-tagged (.txt) files.
    Returns: 201 with the completed CitationSearch (status='completed').
    """
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)

    if direction not in {"backward", "forward"}:
        raise HTTPException(
            status_code=400,
            detail="direction must be 'backward' or 'forward'",
        )

    src_rec_id: Optional[uuid.UUID] = None
    if source_record_id and source_record_id.strip():
        try:
            src_rec_id = uuid.UUID(source_record_id.strip())
        except ValueError:
            raise HTTPException(
                status_code=400, detail="source_record_id is not a valid UUID"
            )

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        search = await citation_service.create_manual_search(
            db, project_id, current_user.id, direction, src_rec_id, file_bytes
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

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


@router.delete("/searches/{search_id}")
async def delete_search(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Delete a citation search and all its candidates."""
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)
    deleted = await citation_service.delete_search(db, search_id, project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Citation search not found")
    return Response(status_code=204)


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


class BulkDecisionBody(BaseModel):
    decision: Optional[str] = None   # "include" | null (clears all)
    direction: Optional[str] = None  # filter: backward | forward | null = both
    source_record_id: Optional[str] = None  # filter by source paper


@router.post("/searches/{search_id}/candidates/bulk-select")
async def bulk_select_candidates(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    body: BulkDecisionBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Select or deselect all candidates matching the given filters.

    Pass decision='include' to select all, decision=null to deselect all.
    Optionally filter by direction or source_record_id.
    """
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)
    count = await citation_service.bulk_select_candidates(
        db,
        search_id=search_id,
        project_id=project_id,
        decision=body.decision,
        direction_filter=body.direction,
        source_record_id_filter=uuid.UUID(body.source_record_id) if body.source_record_id else None,
        reviewer_id=current_user.id,
    )
    return {"updated": count}


@router.delete("/searches/{search_id}/candidates/{candidate_id}")
async def delete_candidate(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    candidate_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Delete a single candidate from a search."""
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)
    deleted = await citation_service.delete_candidate(db, search_id, candidate_id, project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return Response(status_code=204)


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


@router.post("/searches/{search_id}/candidates/upload", status_code=200)
async def upload_candidates_to_search(
    project_id: uuid.UUID,
    search_id: uuid.UUID,
    file: UploadFile = File(...),
    direction: str = Form(...),
    source_record_id: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Append candidates from a citation file to an existing search.

    Parses a RIS or MEDLINE file and inserts the records as additional candidates
    in the specified search.  Duplicates already present in this search are silently
    skipped (unique indexes on doi/pmid/s2_paper_id per search+direction).  The
    search's candidate_count is updated automatically.

    Returns: {"added": N, "already_in_project": M, "duplicates_skipped": K}
    """
    await _require_project(project_id, current_user, db, allowed=REVIEWER_ROLE)

    if direction not in {"backward", "forward"}:
        raise HTTPException(
            status_code=400,
            detail="direction must be 'backward' or 'forward'",
        )

    src_rec_id: Optional[uuid.UUID] = None
    if source_record_id and source_record_id.strip():
        try:
            src_rec_id = uuid.UUID(source_record_id.strip())
        except ValueError:
            raise HTTPException(status_code=400, detail="source_record_id is not a valid UUID")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        result = await citation_service.append_manual_candidates(
            db, search_id, project_id, direction, src_rec_id, file_bytes
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception(
            "append_manual_candidates failed for search %s project %s: %s",
            search_id, project_id, exc,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Upload failed ({type(exc).__name__}): {exc}",
        )

    return result


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
