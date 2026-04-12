"""
Citation sourcing (snowballing) service.

Fetches references (backward) and citing papers (forward) for all extracted
papers in a project via the Semantic Scholar API, then stores them as
citation_candidates for researcher review.

Public API
----------
start_citation_search(db, project_id, user_id, direction)
    → CitationSearch   (synchronous — caller enqueues run_citation_search as background task)

run_citation_search(search_id, project_id)
    → None   [background task — opens its own DB session]

list_searches(db, project_id) → List[CitationSearch]
get_search(db, search_id, project_id) → Optional[CitationSearch]
list_candidates(db, search_id, project_id, page, per_page, decision_filter, direction_filter)
    → dict with items/total/page/per_page/total_pages
submit_candidate_decision(db, search_id, candidate_id, project_id, decision, notes, reviewer_id)
    → CitationCandidate
import_included_candidates(search_id, project_id, user_id)
    → None   [background task — opens its own DB session]
get_or_create_citation_source(db, project_id) → Source
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import SessionLocal
from app.models.citation_candidate import CitationCandidate
from app.models.citation_search import CitationSearch
from app.models.extraction_record import ExtractionRecord
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source
from app.repositories.import_repo import ImportRepo
from app.repositories.source_repo import SourceRepo
from app.services.import_service import process_import

logger = logging.getLogger(__name__)

_S2_BASE = "https://api.semanticscholar.org/graph/v1"
_S2_FIELDS = "title,authors,year,externalIds,abstract,journal"
_PAGE_SIZE = 500
# Sleep between API calls to respect rate limits
_SLEEP_NO_KEY = 1.05
_SLEEP_WITH_KEY = 0.02
# asyncpg parameter limit safety margin
_CHUNK_SIZE = 500


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


async def start_citation_search(
    db: AsyncSession,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    direction: str = "both",
) -> CitationSearch:
    """Create a CitationSearch row and return it. Caller enqueues run_citation_search."""
    search = CitationSearch(
        project_id=project_id,
        triggered_by=user_id,
        status="pending",
        direction=direction,
    )
    db.add(search)
    await db.commit()
    await db.refresh(search)
    return search


async def list_searches(
    db: AsyncSession, project_id: uuid.UUID
) -> List[CitationSearch]:
    result = await db.execute(
        select(CitationSearch)
        .where(CitationSearch.project_id == project_id)
        .order_by(CitationSearch.created_at.desc())
    )
    return list(result.scalars().all())


async def get_search(
    db: AsyncSession, search_id: uuid.UUID, project_id: uuid.UUID
) -> Optional[CitationSearch]:
    result = await db.execute(
        select(CitationSearch).where(
            CitationSearch.id == search_id,
            CitationSearch.project_id == project_id,
        )
    )
    return result.scalar_one_or_none()


async def list_candidates(
    db: AsyncSession,
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    page: int = 1,
    per_page: int = 25,
    decision_filter: Optional[str] = None,
    direction_filter: Optional[str] = None,
) -> Dict[str, Any]:
    base_q = select(CitationCandidate).where(
        CitationCandidate.search_id == search_id,
        CitationCandidate.project_id == project_id,
    )
    if decision_filter and decision_filter != "all":
        if decision_filter == "unreviewed":
            base_q = base_q.where(CitationCandidate.decision.is_(None))
        else:
            base_q = base_q.where(CitationCandidate.decision == decision_filter)
    if direction_filter and direction_filter != "both":
        base_q = base_q.where(CitationCandidate.direction == direction_filter)

    # total count
    count_result = await db.execute(
        select(text("count(*)")).select_from(base_q.subquery())
    )
    total = count_result.scalar_one()

    # paginated items
    offset = (page - 1) * per_page
    items_result = await db.execute(
        base_q.order_by(CitationCandidate.direction, CitationCandidate.year.desc().nullslast())
        .limit(per_page)
        .offset(offset)
    )
    items = list(items_result.scalars().all())

    total_pages = max(1, (total + per_page - 1) // per_page)
    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    }


async def submit_candidate_decision(
    db: AsyncSession,
    search_id: uuid.UUID,
    candidate_id: uuid.UUID,
    project_id: uuid.UUID,
    decision: Optional[str],
    notes: Optional[str],
    reviewer_id: uuid.UUID,
) -> CitationCandidate:
    """Set or clear a decision on a candidate. Pass decision=None to un-decide."""
    valid = {"include", "exclude", "already_screened"}
    if decision is not None and decision not in valid:
        raise ValueError(f"decision must be one of {valid} or null")

    result = await db.execute(
        select(CitationCandidate).where(
            CitationCandidate.id == candidate_id,
            CitationCandidate.search_id == search_id,
            CitationCandidate.project_id == project_id,
        )
    )
    candidate = result.scalar_one_or_none()
    if candidate is None:
        raise LookupError("Candidate not found")

    candidate.decision = decision
    candidate.notes = notes
    candidate.decided_by = reviewer_id if decision else None
    candidate.decided_at = datetime.now(timezone.utc) if decision else None
    await db.commit()
    await db.refresh(candidate)
    return candidate


async def get_or_create_citation_source(
    db: AsyncSession, project_id: uuid.UUID
) -> Source:
    """Find or create the project-level 'Citation Sourcing' source.

    record_sources.source_id is non-nullable, so citation imports need a real
    Source row.
    """
    result = await db.execute(
        select(Source).where(
            Source.project_id == project_id,
            Source.name == "Citation Sourcing",
        )
    )
    source = result.scalar_one_or_none()
    if source is None:
        source = await SourceRepo.create(db, project_id, "Citation Sourcing")
    return source


# ---------------------------------------------------------------------------
# Background task: fetch citations from Semantic Scholar
# ---------------------------------------------------------------------------


async def run_citation_search(
    search_id: uuid.UUID,
    project_id: uuid.UUID,
) -> None:
    """Background task. Opens its own DB session (same pattern as process_import)."""
    try:
        await _do_citation_search(search_id, project_id)
    except BaseException as exc:  # noqa: BLE001
        logger.exception("Unhandled exception in run_citation_search %s", search_id)
        try:
            async with SessionLocal() as db:
                await _set_failed(db, search_id, f"Unexpected error: {exc}")
        except Exception:
            logger.exception("Failed to record failure for search %s", search_id)


async def _do_citation_search(
    search_id: uuid.UUID,
    project_id: uuid.UUID,
) -> None:
    api_key: Optional[str] = settings.semantic_scholar_api_key or None
    sleep_interval = _SLEEP_WITH_KEY if api_key else _SLEEP_NO_KEY

    # ── 1. Mark running ────────────────────────────────────────────────────
    async with SessionLocal() as db:
        search = await db.get(CitationSearch, search_id)
        if search is None:
            logger.error("CitationSearch %s not found", search_id)
            return
        direction = search.direction
        search.status = "running"
        await db.commit()

    # ── 2. Load extracted records with DOI/PMID ────────────────────────────
    async with SessionLocal() as db:
        er_result = await db.execute(
            select(ExtractionRecord.record_id, ExtractionRecord.cluster_id)
            .where(ExtractionRecord.project_id == project_id)
        )
        er_rows = er_result.all()

        # Collect unique record_ids (cluster-based extractions: pick rep record later)
        record_ids: List[uuid.UUID] = []
        for row in er_rows:
            if row.record_id is not None:
                record_ids.append(row.record_id)
            # cluster-based: fetch representative record below

        # Also fetch representative records for cluster-based extractions
        cluster_ids = [row.cluster_id for row in er_rows if row.cluster_id is not None]
        if cluster_ids:
            rep_result = await db.execute(
                text("""
                    SELECT DISTINCT ON (ocm.cluster_id) rs.record_id
                    FROM overlap_cluster_members ocm
                    JOIN record_sources rs ON rs.id = ocm.record_source_id
                    WHERE ocm.cluster_id = ANY(:ids)
                    ORDER BY ocm.cluster_id, ocm.id
                """),
                {"ids": cluster_ids},
            )
            for row in rep_result:
                record_ids.append(row.record_id)

        unique_record_ids = list(set(record_ids))
        if not unique_record_ids:
            async with SessionLocal() as db2:
                await _set_completed(db2, search_id, 0, 0)
            return

        # Load records + their raw_data (for PMID extraction)
        records_result = await db.execute(
            select(Record).where(
                Record.id.in_(unique_record_ids),
                Record.project_id == project_id,
            )
        )
        records: List[Record] = list(records_result.scalars().all())

        # Load raw_data per record_id for PMID lookup
        rs_result = await db.execute(
            select(RecordSource.record_id, RecordSource.raw_data)
            .where(RecordSource.record_id.in_(unique_record_ids))
        )
        raw_data_by_record: Dict[uuid.UUID, List[dict]] = {}
        for row in rs_result:
            raw_data_by_record.setdefault(row.record_id, []).append(row.raw_data or {})

    # ── 3. Fetch from Semantic Scholar ─────────────────────────────────────
    # Accumulate candidates in a dict keyed by best identifier (doi > pmid > s2_id)
    # so the same paper from multiple source records is stored once.
    candidates: Dict[str, dict] = {}

    async with httpx.AsyncClient(timeout=30.0) as client:
        for record in records:
            raw_data_rows = raw_data_by_record.get(record.id, [])
            s2_id = await _resolve_s2_id(client, record, raw_data_rows, api_key)
            if s2_id is None:
                continue

            if direction in ("backward", "both"):
                refs = await _fetch_paginated(client, f"{_S2_BASE}/paper/{s2_id}/references", api_key, sleep_interval)
                for item in refs:
                    paper = item.get("citedPaper") or {}
                    _merge_candidate(candidates, paper, "backward", record.id)

            if direction in ("forward", "both"):
                await asyncio.sleep(sleep_interval)
                cits = await _fetch_paginated(client, f"{_S2_BASE}/paper/{s2_id}/citations", api_key, sleep_interval)
                for item in cits:
                    paper = item.get("citingPaper") or {}
                    _merge_candidate(candidates, paper, "forward", record.id)

            await asyncio.sleep(sleep_interval)

    candidate_list = list(candidates.values())

    # ── 4. Check which candidates are already in the project ───────────────
    async with SessionLocal() as db:
        candidate_list = await _dedup_against_project(db, project_id, candidate_list)

    # ── 5. Bulk-insert candidates ──────────────────────────────────────────
    async with SessionLocal() as db:
        if candidate_list:
            # ON CONFLICT DO NOTHING on partial unique indexes (doi, pmid, s2_paper_id)
            # We insert one by one in chunks to handle the partial-unique logic;
            # raw INSERT … ON CONFLICT DO NOTHING respects all three indexes.
            for i in range(0, len(candidate_list), _CHUNK_SIZE):
                chunk = candidate_list[i : i + _CHUNK_SIZE]
                rows = [
                    {
                        "id": uuid.uuid4(),
                        "search_id": search_id,
                        "project_id": project_id,
                        "direction": c["direction"],
                        "source_record_id": c.get("source_record_id"),
                        "s2_paper_id": c.get("s2_paper_id"),
                        "title": c.get("title"),
                        "abstract": c.get("abstract"),
                        "authors": c.get("authors"),
                        "year": c.get("year"),
                        "doi": c.get("doi"),
                        "pmid": c.get("pmid"),
                        "journal": c.get("journal"),
                        "in_project": c.get("in_project", False),
                        "project_record_id": c.get("project_record_id"),
                    }
                    for c in chunk
                ]
                await db.execute(
                    text("""
                        INSERT INTO citation_candidates
                            (id, search_id, project_id, direction, source_record_id,
                             s2_paper_id, title, abstract, authors, year, doi, pmid, journal,
                             in_project, project_record_id)
                        VALUES
                            (:id, :search_id, :project_id, :direction, :source_record_id,
                             :s2_paper_id, :title, :abstract, :authors, :year, :doi, :pmid, :journal,
                             :in_project, :project_record_id)
                        ON CONFLICT DO NOTHING
                    """),
                    rows,
                )
            await db.commit()

        # Recount from DB (ON CONFLICT DO NOTHING may have dropped some)
        count_result = await db.execute(
            text("SELECT COUNT(*) FROM citation_candidates WHERE search_id = :s"),
            {"s": search_id},
        )
        actual_count = count_result.scalar_one()

        in_proj_result = await db.execute(
            text("SELECT COUNT(*) FROM citation_candidates WHERE search_id = :s AND in_project = TRUE"),
            {"s": search_id},
        )
        in_proj_count = in_proj_result.scalar_one()

        await _set_completed(db, search_id, actual_count, in_proj_count)


# ---------------------------------------------------------------------------
# Background task: import included candidates via existing import pipeline
# ---------------------------------------------------------------------------


async def import_included_candidates(
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    """Background task. Imports all decision='include' candidates as a single RIS file."""
    try:
        await _do_import_included(search_id, project_id, user_id)
    except BaseException as exc:  # noqa: BLE001
        logger.exception("Unhandled exception in import_included_candidates %s", search_id)


async def _do_import_included(
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    async with SessionLocal() as db:
        result = await db.execute(
            select(CitationCandidate).where(
                CitationCandidate.search_id == search_id,
                CitationCandidate.project_id == project_id,
                CitationCandidate.decision == "include",
                CitationCandidate.import_job_id.is_(None),
            )
        )
        candidates = list(result.scalars().all())

    if not candidates:
        logger.info("No unimported included candidates for search %s", search_id)
        return

    async with SessionLocal() as db:
        source = await get_or_create_citation_source(db, project_id)
        source_id = source.id

    # Build a single RIS file in memory
    ris_bytes = _build_ris(candidates)
    short_id = str(search_id)[:8]

    async with SessionLocal() as db:
        job = await ImportRepo.create(
            db,
            project_id=project_id,
            user_id=user_id,
            filename=f"citation_search_{short_id}.ris",
            file_format="ris",
            source_id=source_id,
        )
        job_id = job.id

    # Run through the full import pipeline (dedup included)
    await process_import(job_id, project_id, source_id, ris_bytes)

    # Link candidates to the import job
    async with SessionLocal() as db:
        candidate_ids = [c.id for c in candidates]
        for i in range(0, len(candidate_ids), _CHUNK_SIZE):
            chunk = candidate_ids[i : i + _CHUNK_SIZE]
            await db.execute(
                update(CitationCandidate)
                .where(CitationCandidate.id.in_(chunk))
                .values(import_job_id=job_id)
            )
        await db.commit()

    logger.info(
        "Citation import job %s created for search %s (%d candidates)",
        job_id, search_id, len(candidates),
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _resolve_s2_id(
    client: httpx.AsyncClient,
    record: Record,
    raw_data_rows: List[dict],
    api_key: Optional[str],
) -> Optional[str]:
    """Return the Semantic Scholar paperId for a record, or None if not found."""
    if record.doi:
        result = await _s2_get(client, f"{_S2_BASE}/paper/DOI:{record.doi}", {"fields": "paperId"}, api_key)
        if result and result.get("paperId"):
            return result["paperId"]

    # Try PMID from raw_data
    for rd in raw_data_rows:
        pmid = rd.get("pmid") or rd.get("AN") or rd.get("pubmed_id") or rd.get("accession_number")
        if pmid and str(pmid).isdigit():
            result = await _s2_get(client, f"{_S2_BASE}/paper/PMID:{pmid}", {"fields": "paperId"}, api_key)
            if result and result.get("paperId"):
                return result["paperId"]

    logger.debug("Record %s has no resolvable S2 identifier; skipping", record.id)
    return None


async def _fetch_paginated(
    client: httpx.AsyncClient,
    url: str,
    api_key: Optional[str],
    sleep_interval: float,
) -> List[dict]:
    """Fetch all pages from a Semantic Scholar paginated endpoint."""
    results: List[dict] = []
    offset = 0
    while True:
        data = await _s2_get(
            client, url,
            {"fields": _S2_FIELDS, "limit": _PAGE_SIZE, "offset": offset},
            api_key,
        )
        if data is None:
            break
        batch = data.get("data") or []
        results.extend(batch)
        if len(batch) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
        await asyncio.sleep(sleep_interval)
    return results


async def _s2_get(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    api_key: Optional[str],
) -> Optional[dict]:
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key
    try:
        resp = await client.get(url, params=params, headers=headers)
        if resp.status_code == 404:
            return None
        if resp.status_code == 429:
            logger.warning("S2 rate limit hit; backing off 10s")
            await asyncio.sleep(10)
            resp = await client.get(url, params=params, headers=headers)
        if resp.status_code != 200:
            logger.warning("S2 API %s returned %d", url, resp.status_code)
            return None
        return resp.json()
    except httpx.TimeoutException:
        logger.warning("S2 API timeout for %s", url)
        return None
    except Exception as exc:
        logger.warning("S2 API error for %s: %s", url, exc)
        return None


def _merge_candidate(
    candidates: Dict[str, dict],
    paper: dict,
    direction: str,
    source_record_id: uuid.UUID,
) -> None:
    """Insert or update a candidate entry in the accumulator dict.

    Keyed by DOI > PMID > S2 paper ID so the same paper from multiple source
    records collapses into one entry. The first direction seen is kept.
    """
    if not paper:
        return
    doi = (paper.get("externalIds") or {}).get("DOI") or None
    if doi:
        doi = doi.lower().strip()
    pmid = str((paper.get("externalIds") or {}).get("PubMed") or "").strip() or None
    s2_id = paper.get("paperId") or None

    key = doi or pmid or s2_id
    if key is None:
        return  # no usable identifier — skip

    if key in candidates:
        return  # already have this paper

    authors = [a.get("name", "") for a in (paper.get("authors") or []) if a.get("name")]
    journal_info = paper.get("journal") or {}
    journal = journal_info.get("name") if isinstance(journal_info, dict) else None

    candidates[key] = {
        "direction": direction,
        "source_record_id": source_record_id,
        "s2_paper_id": s2_id,
        "title": paper.get("title"),
        "abstract": paper.get("abstract"),
        "authors": authors or None,
        "year": paper.get("year"),
        "doi": doi,
        "pmid": pmid,
        "journal": journal,
        "in_project": False,
        "project_record_id": None,
    }


async def _dedup_against_project(
    db: AsyncSession,
    project_id: uuid.UUID,
    candidates: List[dict],
) -> List[dict]:
    """Flag candidates that already exist in the project by DOI or PMID."""
    doi_candidates = {c["doi"]: c for c in candidates if c.get("doi")}
    pmid_candidates = {c["pmid"]: c for c in candidates if c.get("pmid") and not c.get("doi")}

    # DOI lookup (chunked)
    doi_list = list(doi_candidates.keys())
    for i in range(0, len(doi_list), _CHUNK_SIZE):
        chunk = doi_list[i : i + _CHUNK_SIZE]
        result = await db.execute(
            select(Record.id, Record.doi)
            .where(Record.project_id == project_id, Record.doi.in_(chunk))
        )
        for row in result:
            if row.doi in doi_candidates:
                doi_candidates[row.doi]["in_project"] = True
                doi_candidates[row.doi]["project_record_id"] = row.id

    # PMID lookup via record_sources raw_data
    if pmid_candidates:
        pmid_list = list(pmid_candidates.keys())
        for i in range(0, len(pmid_list), _CHUNK_SIZE):
            chunk = pmid_list[i : i + _CHUNK_SIZE]
            result = await db.execute(
                text("""
                    SELECT DISTINCT rs.record_id,
                           COALESCE(
                               rs.raw_data->>'pmid',
                               rs.raw_data->>'AN',
                               rs.raw_data->>'pubmed_id',
                               rs.raw_data->>'accession_number'
                           ) AS pmid
                    FROM record_sources rs
                    JOIN records r ON r.id = rs.record_id
                    WHERE r.project_id = :project_id
                      AND COALESCE(
                               rs.raw_data->>'pmid',
                               rs.raw_data->>'AN',
                               rs.raw_data->>'pubmed_id',
                               rs.raw_data->>'accession_number'
                          ) = ANY(:pmids)
                """),
                {"project_id": project_id, "pmids": chunk},
            )
            for row in result:
                if row.pmid and row.pmid in pmid_candidates:
                    pmid_candidates[row.pmid]["in_project"] = True
                    pmid_candidates[row.pmid]["project_record_id"] = row.record_id

    return candidates


def _build_ris(candidates: List[CitationCandidate]) -> bytes:
    """Build a RIS-format byte string from CitationCandidate objects."""
    records = []
    for c in candidates:
        lines = ["TY  - JOUR"]
        if c.title:
            lines.append(f"TI  - {c.title}")
        if c.year:
            lines.append(f"PY  - {c.year}")
        if c.doi:
            lines.append(f"DO  - {c.doi}")
        if c.abstract:
            # RIS AB tag — replace newlines with spaces
            lines.append(f"AB  - {c.abstract.replace(chr(10), ' ').replace(chr(13), ' ')}")
        if c.journal:
            lines.append(f"JO  - {c.journal}")
        for author in (c.authors or []):
            lines.append(f"AU  - {author}")
        if c.pmid:
            lines.append(f"AN  - {c.pmid}")
        lines.append("ER  - ")
        records.append("\n".join(lines))
    return ("\n\n".join(records) + "\n").encode("utf-8")


async def _set_completed(
    db: AsyncSession,
    search_id: uuid.UUID,
    candidate_count: int,
    already_in_project_count: int,
) -> None:
    search = await db.get(CitationSearch, search_id)
    if search:
        search.status = "completed"
        search.candidate_count = candidate_count
        search.already_in_project_count = already_in_project_count
        search.completed_at = datetime.now(timezone.utc)
        await db.commit()


async def _set_failed(db: AsyncSession, search_id: uuid.UUID, error_msg: str) -> None:
    search = await db.get(CitationSearch, search_id)
    if search:
        search.status = "failed"
        search.error_msg = error_msg
        search.completed_at = datetime.now(timezone.utc)
        await db.commit()
