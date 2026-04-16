"""
Citation sourcing (snowballing) service.

Fetches references (backward) and citing papers (forward) for extracted papers in a
project via the Semantic Scholar API, then stores them as citation_candidates for
researcher review.

Citation searches always operate on the Extraction Library cohort: papers that have
both a TA=include and FT=include screening decision AND a completed extraction record.
This ensures the snowball starts from the same set the researcher has already validated.

Scope controls which cohort of extracted papers is used as source:
  "all"    – every paper currently in the Extraction Library (default)
  "new"    – only papers not used as source in any prior completed search
  "custom" – caller passes a specific list of record_ids

Public API
----------
start_citation_search(db, project_id, user_id, direction, scope, record_ids)
    → CitationSearch   (synchronous — caller enqueues run_citation_search)

run_citation_search(search_id, project_id)
    → None   [background task — opens its own DB session]

list_searches(db, project_id) → List[CitationSearch]
get_search(db, search_id, project_id) → Optional[CitationSearch]
delete_search(db, search_id, project_id) → bool

list_candidates(db, search_id, project_id, page, per_page, decision_filter,
                direction_filter, source_record_id_filter)
    → dict with items/total/page/per_page/total_pages

list_source_articles(db, search_id, project_id)
    → List[dict]  (source records used as input for this search)

submit_candidate_decision(db, search_id, candidate_id, project_id, decision, notes, reviewer_id)
    → CitationCandidate

delete_candidate(db, search_id, candidate_id, project_id) → bool

import_selected_candidates(search_id, project_id, user_id)
    → None   [background task — opens its own DB session]
    Imports decision='include' candidates grouped by source article;
    each group gets its own named Source so the origin is visible in the Extraction Library.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import quote as _url_quote

import httpx
from sqlalchemy import delete, select, text, update
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
_SLEEP_NO_KEY = 1.05
_SLEEP_WITH_KEY = 0.02
_CHUNK_SIZE = 500

# Regex to extract a bare 5-10 digit PMID from formats like:
#   "12345678"  "12345678 [pubmed]"  "MEDLINE:12345678"  "pubmed/12345678"
_PMID_RE = re.compile(r"\b(\d{5,10})\b")

# DOI URL prefixes that must be stripped before sending to S2
_DOI_PREFIXES = (
    "https://doi.org/",
    "http://doi.org/",
    "https://dx.doi.org/",
    "http://dx.doi.org/",
    "doi:",
)


def _clean_doi(doi: Optional[str]) -> Optional[str]:
    """Normalise a DOI for use in a Semantic Scholar lookup URL.

    Strips common URL prefixes (doi.org, dx.doi.org, doi:), removes trailing
    whitespace and stray punctuation, then percent-encodes characters that
    are valid in a DOI but would otherwise corrupt an HTTP path segment
    (parentheses, angle brackets, hash, etc.).

    Returns None for blank/None input.
    """
    if not doi:
        return None
    doi = doi.strip()
    doi_lower = doi.lower()
    for prefix in _DOI_PREFIXES:
        if doi_lower.startswith(prefix):
            doi = doi[len(prefix):]
            break
    doi = doi.strip().rstrip(".,; ")
    if not doi:
        return None
    # Percent-encode characters that are valid inside a DOI but break URL paths.
    # We keep the '/' that separates registrant from suffix (e.g. 10.1000/xyz).
    return _url_quote(doi, safe="-./_:@!$&'()*+,;=~")


def _extract_pmid(raw_value: Any) -> Optional[str]:
    """Extract a numeric PMID string from a raw_data field value.

    Handles plain integers, pure-digit strings, and annotated strings such as:
    "12345678 [pubmed]", "MEDLINE:12345678", "pubmed/12345678".

    Returns the digit string (e.g. "12345678") or None.
    """
    if raw_value is None:
        return None
    s = str(raw_value).strip()
    # Fast path: already a bare integer
    if s.isdigit() and 5 <= len(s) <= 10:
        return s
    # Regex path: extract first 5-10 digit run from annotated strings
    m = _PMID_RE.search(s)
    if m:
        return m.group(1)
    return None


# ---------------------------------------------------------------------------
# SQL helper: extraction-library records (TA+FT included AND extracted)
# ---------------------------------------------------------------------------

_EXTRACTION_LIBRARY_SQL = text("""
    SELECT er.record_id, er.cluster_id
    FROM extraction_records er
    WHERE er.project_id = :project_id
      AND EXISTS (
          SELECT 1 FROM screening_decisions sd
          WHERE sd.project_id = :project_id AND sd.stage = 'TA' AND sd.decision = 'include'
            AND (
              (er.record_id IS NOT NULL AND sd.record_id = er.record_id) OR
              (er.cluster_id IS NOT NULL AND sd.cluster_id = er.cluster_id)
            )
      )
      AND EXISTS (
          SELECT 1 FROM screening_decisions sd
          WHERE sd.project_id = :project_id AND sd.stage = 'FT' AND sd.decision = 'include'
            AND (
              (er.record_id IS NOT NULL AND sd.record_id = er.record_id) OR
              (er.cluster_id IS NOT NULL AND sd.cluster_id = er.cluster_id)
            )
      )
""")


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


async def start_citation_search(
    db: AsyncSession,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    direction: str = "both",
    scope: str = "all",
    record_ids: Optional[List[uuid.UUID]] = None,
) -> CitationSearch:
    """Create a CitationSearch row and return it. Caller enqueues run_citation_search."""
    search = CitationSearch(
        project_id=project_id,
        triggered_by=user_id,
        status="pending",
        direction=direction,
        scope=scope,
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


async def delete_search(
    db: AsyncSession, search_id: uuid.UUID, project_id: uuid.UUID
) -> bool:
    """Delete a citation search and all its candidates. Returns True if deleted."""
    result = await db.execute(
        select(CitationSearch).where(
            CitationSearch.id == search_id,
            CitationSearch.project_id == project_id,
        )
    )
    search = result.scalar_one_or_none()
    if search is None:
        return False
    await db.delete(search)
    await db.commit()
    return True


async def list_candidates(
    db: AsyncSession,
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    page: int = 1,
    per_page: int = 25,
    decision_filter: Optional[str] = None,
    direction_filter: Optional[str] = None,
    source_record_id_filter: Optional[uuid.UUID] = None,
) -> Dict[str, Any]:
    base_q = select(CitationCandidate).where(
        CitationCandidate.search_id == search_id,
        CitationCandidate.project_id == project_id,
    )
    if decision_filter and decision_filter != "all":
        if decision_filter == "unselected":
            base_q = base_q.where(CitationCandidate.decision.is_(None))
        else:
            base_q = base_q.where(CitationCandidate.decision == decision_filter)
    if direction_filter and direction_filter != "both":
        base_q = base_q.where(CitationCandidate.direction == direction_filter)
    if source_record_id_filter is not None:
        base_q = base_q.where(CitationCandidate.source_record_id == source_record_id_filter)

    count_result = await db.execute(
        select(text("count(*)")).select_from(base_q.subquery())
    )
    total = count_result.scalar_one()

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


async def list_source_articles(
    db: AsyncSession,
    search_id: uuid.UUID,
    project_id: uuid.UUID,
) -> List[Dict[str, Any]]:
    """Return the distinct source records used as input for this search.

    Loads the source_record_ids stored on the CitationSearch row and returns
    basic metadata (id, title, year, authors) for each record so the frontend
    can render a filter UI grouped by origin paper.
    """
    search = await get_search(db, search_id, project_id)
    if search is None or not search.source_record_ids:
        return []

    raw_ids = search.source_record_ids  # list of UUID strings
    if not raw_ids:
        return []

    try:
        uuids = [uuid.UUID(str(r)) for r in raw_ids]
    except Exception:
        return []

    result = await db.execute(
        select(Record).where(Record.id.in_(uuids))
    )
    records = list(result.scalars().all())

    out = []
    for r in records:
        # Candidate count for this source record within the search
        cnt_result = await db.execute(
            select(text("count(*)")).select_from(
                select(CitationCandidate).where(
                    CitationCandidate.search_id == search_id,
                    CitationCandidate.source_record_id == r.id,
                ).subquery()
            )
        )
        cnt = cnt_result.scalar_one()
        out.append({
            "record_id": str(r.id),
            "title": r.title,
            "year": r.year,
            "candidate_count": cnt,
        })
    return out


async def submit_candidate_decision(
    db: AsyncSession,
    search_id: uuid.UUID,
    candidate_id: uuid.UUID,
    project_id: uuid.UUID,
    decision: Optional[str],
    notes: Optional[str],
    reviewer_id: uuid.UUID,
) -> CitationCandidate:
    """Set or clear a selection on a candidate. Pass decision=None to deselect."""
    valid = {"include"}
    if decision is not None and decision not in valid:
        raise ValueError(f"decision must be 'include' or null")

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


async def bulk_select_candidates(
    db: AsyncSession,
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    decision: Optional[str],
    direction_filter: Optional[str],
    source_record_id_filter: Optional[uuid.UUID],
    reviewer_id: uuid.UUID,
) -> int:
    """Set or clear decision on all candidates matching the filters. Returns count updated."""
    if decision is not None and decision != "include":
        raise ValueError("decision must be 'include' or null")

    stmt = (
        update(CitationCandidate)
        .where(
            CitationCandidate.search_id == search_id,
            CitationCandidate.project_id == project_id,
            CitationCandidate.import_job_id.is_(None),
        )
    )
    if direction_filter and direction_filter != "both":
        stmt = stmt.where(CitationCandidate.direction == direction_filter)
    if source_record_id_filter is not None:
        stmt = stmt.where(CitationCandidate.source_record_id == source_record_id_filter)

    now = datetime.now(timezone.utc)
    stmt = stmt.values(
        decision=decision,
        decided_by=reviewer_id if decision else None,
        decided_at=now if decision else None,
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount


async def delete_candidate(
    db: AsyncSession,
    search_id: uuid.UUID,
    candidate_id: uuid.UUID,
    project_id: uuid.UUID,
) -> bool:
    """Delete a single candidate. Returns True if deleted."""
    result = await db.execute(
        select(CitationCandidate).where(
            CitationCandidate.id == candidate_id,
            CitationCandidate.search_id == search_id,
            CitationCandidate.project_id == project_id,
        )
    )
    candidate = result.scalar_one_or_none()
    if candidate is None:
        return False
    await db.delete(candidate)
    await db.commit()
    return True


# ---------------------------------------------------------------------------
# Background task: fetch citations from Semantic Scholar
# ---------------------------------------------------------------------------


async def run_citation_search(
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    scope: str = "all",
    record_ids: Optional[List[uuid.UUID]] = None,
) -> None:
    """Background task. Opens its own DB session (same pattern as process_import)."""
    try:
        await _do_citation_search(search_id, project_id, scope, record_ids)
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
    scope: str,
    explicit_record_ids: Optional[List[uuid.UUID]],
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

    # ── 2. Load source records from the Extraction Library cohort ──────────
    #
    # The Extraction Library shows papers with:
    #   - an extraction_record
    #   - TA=include AND FT=include screening decisions
    #
    # This is the same filter used by the Extraction Library page, ensuring
    # citation sourcing always starts from fully validated, extracted papers.
    #
    async with SessionLocal() as db:
        if explicit_record_ids:
            # Custom scope: caller provided a specific list of record IDs.
            # Still validate they are in the extraction library.
            er_result = await db.execute(
                text("""
                    SELECT er.record_id, er.cluster_id
                    FROM extraction_records er
                    WHERE er.project_id = :project_id
                      AND er.record_id = ANY(:ids)
                      AND EXISTS (
                          SELECT 1 FROM screening_decisions sd
                          WHERE sd.project_id = :project_id AND sd.stage = 'TA'
                            AND sd.decision = 'include' AND sd.record_id = er.record_id
                      )
                      AND EXISTS (
                          SELECT 1 FROM screening_decisions sd
                          WHERE sd.project_id = :project_id AND sd.stage = 'FT'
                            AND sd.decision = 'include' AND sd.record_id = er.record_id
                      )
                """),
                {"project_id": project_id, "ids": explicit_record_ids},
            )
        else:
            er_result = await db.execute(
                _EXTRACTION_LIBRARY_SQL, {"project_id": project_id}
            )
        er_rows = er_result.all()

        # Collect unique record_ids (cluster-based: pick representative record)
        record_ids_set: List[uuid.UUID] = []
        for row in er_rows:
            if row.record_id is not None:
                record_ids_set.append(row.record_id)

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
                record_ids_set.append(row.record_id)

        # For scope='new': exclude records already used as source in any prior
        # completed search for this project.
        if scope == "new" and not explicit_record_ids:
            prior_result = await db.execute(
                text("""
                    SELECT source_record_ids
                    FROM citation_searches
                    WHERE project_id = :project_id
                      AND status = 'completed'
                      AND id != :search_id
                      AND source_record_ids IS NOT NULL
                """),
                {"project_id": project_id, "search_id": search_id},
            )
            prior_ids: set = set()
            for row in prior_result:
                if row.source_record_ids:
                    for rid in row.source_record_ids:
                        try:
                            prior_ids.add(uuid.UUID(str(rid)))
                        except Exception:
                            pass
            record_ids_set = [r for r in record_ids_set if r not in prior_ids]
            logger.info(
                "Scope=new for search %s: %d records after excluding prior cohorts",
                search_id, len(record_ids_set),
            )

        unique_record_ids = list(set(record_ids_set))

        if not unique_record_ids:
            async with SessionLocal() as db2:
                search2 = await db2.get(CitationSearch, search_id)
                if search2:
                    search2.source_record_count = 0
                    search2.source_record_ids = []
                    await db2.commit()
            await _set_completed(
                await _open_db(), search_id, 0, 0
            )
            return

        # Store which records are being used
        async with SessionLocal() as db2:
            search2 = await db2.get(CitationSearch, search_id)
            if search2:
                search2.source_record_ids = [str(r) for r in unique_record_ids]
                search2.source_record_count = len(unique_record_ids)
                await db2.commit()

        # Load records + raw_data for PMID lookup
        records_result = await db.execute(
            select(Record).where(
                Record.id.in_(unique_record_ids),
                Record.project_id == project_id,
            )
        )
        records: List[Record] = list(records_result.scalars().all())

        rs_result = await db.execute(
            select(RecordSource.record_id, RecordSource.raw_data)
            .where(RecordSource.record_id.in_(unique_record_ids))
        )
        raw_data_by_record: Dict[uuid.UUID, List[dict]] = {}
        for row in rs_result:
            raw_data_by_record.setdefault(row.record_id, []).append(row.raw_data or {})

    # ── 3. Fetch from Semantic Scholar ─────────────────────────────────────
    candidates: Dict[str, dict] = {}
    skipped_records = 0
    failed_records = 0

    # Separate connect / read timeouts: reads can take longer for large result pages.
    _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)

    async with httpx.AsyncClient(timeout=_timeout) as client:
        for record in records:
            try:
                raw_data_rows = raw_data_by_record.get(record.id, [])
                s2_id = await _resolve_s2_id(client, record, raw_data_rows, api_key)
                if s2_id is None:
                    skipped_records += 1
                    continue

                if direction in ("backward", "both"):
                    refs = await _fetch_paginated(
                        client, f"{_S2_BASE}/paper/{s2_id}/references", api_key, sleep_interval
                    )
                    for item in refs:
                        paper = item.get("citedPaper") or {}
                        _merge_candidate(candidates, paper, "backward", record.id)
                    logger.info(
                        "Record %s (%r): %d backward refs fetched",
                        record.id, record.title and record.title[:40], len(refs),
                    )

                if direction in ("forward", "both"):
                    await asyncio.sleep(sleep_interval)
                    cits = await _fetch_paginated(
                        client, f"{_S2_BASE}/paper/{s2_id}/citations", api_key, sleep_interval
                    )
                    for item in cits:
                        paper = item.get("citingPaper") or {}
                        _merge_candidate(candidates, paper, "forward", record.id)
                    logger.info(
                        "Record %s (%r): %d forward citations fetched",
                        record.id, record.title and record.title[:40], len(cits),
                    )

                await asyncio.sleep(sleep_interval)

            except Exception as exc:  # noqa: BLE001
                # Isolate per-record failures so one bad record never kills the loop
                failed_records += 1
                logger.warning(
                    "Unhandled error processing record %s in search %s: %s",
                    record.id, search_id, exc,
                )

    if skipped_records or failed_records:
        logger.warning(
            "Search %s: %d record(s) skipped (no S2 ID), %d record(s) failed",
            search_id, skipped_records, failed_records,
        )

    candidate_list = list(candidates.values())

    # ── 4. Check which candidates are already in the project ───────────────
    async with SessionLocal() as db:
        candidate_list = await _dedup_against_project(db, project_id, candidate_list)

    # ── 5. Bulk-insert candidates ──────────────────────────────────────────
    async with SessionLocal() as db:
        if candidate_list:
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


async def _open_db():
    """Helper to open a session for the edge-case early-return path."""
    async with SessionLocal() as db:
        return db


# ---------------------------------------------------------------------------
# Background task: import selected candidates via existing import pipeline
# ---------------------------------------------------------------------------


async def import_selected_candidates(
    search_id: uuid.UUID,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    """Background task. Imports decision='include' candidates.

    Groups candidates by (source_record_id, direction) so each group gets a
    descriptively named Source — e.g. '← Refs: Smith (2020)' or '→ Citing: Jones (2021)'.
    This name appears in the Extraction Library's Sources column, making the origin
    of each imported paper visible.
    """
    try:
        await _do_import_selected(search_id, project_id, user_id)
    except BaseException as exc:  # noqa: BLE001
        logger.exception("Unhandled exception in import_selected_candidates %s", search_id)


async def _do_import_selected(
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
        logger.info("No unimported selected candidates for search %s", search_id)
        return

    # ── Group by (source_record_id, direction) ────────────────────────────
    groups: Dict[tuple, List[CitationCandidate]] = {}
    for c in candidates:
        key = (c.source_record_id, c.direction)
        groups.setdefault(key, []).append(c)

    # ── Load source record titles for naming ──────────────────────────────
    source_record_ids = list({k[0] for k in groups if k[0] is not None})
    record_titles: Dict[uuid.UUID, str] = {}
    if source_record_ids:
        async with SessionLocal() as db:
            recs_result = await db.execute(
                select(Record).where(Record.id.in_(source_record_ids))
            )
            for rec in recs_result.scalars().all():
                record_titles[rec.id] = _short_record_name(rec)

    # ── Import each group with a named source ─────────────────────────────
    short_id = str(search_id)[:8]
    all_candidate_ids: List[uuid.UUID] = []
    job_id: Optional[uuid.UUID] = None  # track last job for logging

    for (src_rec_id, direction), group in groups.items():
        source_name = _build_source_name(src_rec_id, direction, record_titles, short_id)

        async with SessionLocal() as db:
            source = await _find_or_create_named_source(db, project_id, source_name)
            source_id = source.id

        ris_bytes = _build_ris(group)

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

        await process_import(job_id, project_id, source_id, ris_bytes)

        async with SessionLocal() as db:
            chunk_ids = [c.id for c in group]
            for i in range(0, len(chunk_ids), _CHUNK_SIZE):
                chunk = chunk_ids[i : i + _CHUNK_SIZE]
                await db.execute(
                    update(CitationCandidate)
                    .where(CitationCandidate.id.in_(chunk))
                    .values(import_job_id=job_id)
                )
            await db.commit()

        all_candidate_ids.extend(c.id for c in group)

    logger.info(
        "Citation import complete for search %s: %d candidates across %d sources",
        search_id, len(all_candidate_ids), len(groups),
    )


def _short_record_name(rec: Record) -> str:
    """Derive a short 'Author (Year)' label from a Record."""
    year = f" ({rec.year})" if rec.year else ""
    # Try to extract first author last name from title or record.title
    # Authors are not on the Record model directly — use title as fallback
    title = (rec.title or "")[:40]
    if title:
        return f"{title}{year}"
    return f"Record{year}"


def _build_source_name(
    src_rec_id: Optional[uuid.UUID],
    direction: str,
    record_titles: Dict[uuid.UUID, str],
    search_short_id: str,
) -> str:
    """Build a descriptive source name for the import batch."""
    arrow = "←" if direction == "backward" else "→"
    if src_rec_id and src_rec_id in record_titles:
        title_short = record_titles[src_rec_id][:50]
        label = "Refs" if direction == "backward" else "Citing"
        return f"{arrow} {label}: {title_short}"
    return f"{arrow} Citation Search {search_short_id}"


async def _find_or_create_named_source(
    db: AsyncSession, project_id: uuid.UUID, name: str
) -> Source:
    """Find or create a Source with this exact name under the project."""
    result = await db.execute(
        select(Source).where(
            Source.project_id == project_id,
            Source.name == name,
        )
    )
    source = result.scalar_one_or_none()
    if source is None:
        source = await SourceRepo.create(db, project_id, name)
    return source


async def get_or_create_citation_source(
    db: AsyncSession, project_id: uuid.UUID
) -> Source:
    """Fallback: find or create the generic 'Citation Sourcing' source."""
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
# Internal helpers
# ---------------------------------------------------------------------------


async def _resolve_s2_id(
    client: httpx.AsyncClient,
    record: Record,
    raw_data_rows: List[dict],
    api_key: Optional[str],
) -> Optional[str]:
    """Resolve a project Record to a Semantic Scholar paper ID.

    Resolution order:
      1. DOI  — cleaned and URL-safe-encoded before use in the S2 path
      2. PMID — extracted from raw_data with regex to handle annotated formats
      3. Title + year search — up to 10 candidates, ±2-year tolerance, then
         ±5-year fallback so online-first / pre-print year gaps don't block resolution
    """
    # 1. DOI
    cleaned_doi = _clean_doi(record.doi)
    if cleaned_doi:
        result = await _s2_get(
            client, f"{_S2_BASE}/paper/DOI:{cleaned_doi}", {"fields": "paperId"}, api_key
        )
        if result and result.get("paperId"):
            logger.debug("Record %s resolved via DOI: %s", record.id, result["paperId"])
            return result["paperId"]

    # 2. PMID — check all raw_data rows; use regex to handle annotated formats
    #    (e.g. "12345678 [pubmed]", "MEDLINE:12345678", plain integers)
    seen_pmids: set = set()
    for rd in raw_data_rows:
        for key in ("pmid", "AN", "pubmed_id", "accession_number"):
            pmid = _extract_pmid(rd.get(key))
            if pmid and pmid not in seen_pmids:
                seen_pmids.add(pmid)
                result = await _s2_get(
                    client,
                    f"{_S2_BASE}/paper/PMID:{pmid}",
                    {"fields": "paperId"},
                    api_key,
                )
                if result and result.get("paperId"):
                    logger.debug("Record %s resolved via PMID %s: %s", record.id, pmid, result["paperId"])
                    return result["paperId"]

    # 3. Title + year search
    if record.title:
        query = record.title.strip()
        result = await _s2_get(
            client,
            f"{_S2_BASE}/paper/search",
            {"query": query, "fields": "paperId,title,year", "limit": 10},
            api_key,
        )
        if result:
            hits = result.get("data") or []

            # Pass 1: strict ±2-year window (handles online-first vs print-year gaps)
            for hit in hits:
                hit_year = hit.get("year")
                if record.year and hit_year and abs(hit_year - record.year) > 2:
                    continue
                if hit.get("paperId"):
                    logger.debug(
                        "Record %s resolved via title search (±2yr): %s",
                        record.id, hit["paperId"],
                    )
                    return hit["paperId"]

            # Pass 2: looser ±5-year window (pre-prints, conference→journal pipeline)
            for hit in hits:
                hit_year = hit.get("year")
                if record.year and hit_year and abs(hit_year - record.year) > 5:
                    continue
                if hit.get("paperId"):
                    logger.info(
                        "Record %s resolved via title search (±5yr loose match): %s",
                        record.id, hit["paperId"],
                    )
                    return hit["paperId"]

            # Pass 3: best-ranked S2 result regardless of year
            #         Only use this if the record has no year at all (year=None)
            if not record.year:
                for hit in hits:
                    if hit.get("paperId"):
                        logger.info(
                            "Record %s (no year) resolved via top title-search result: %s",
                            record.id, hit["paperId"],
                        )
                        return hit["paperId"]

    logger.info(
        "Record %s (title=%r, doi=%r) could not be resolved to an S2 identifier — "
        "no backward/forward sourcing will be performed for this paper",
        record.id,
        record.title and record.title[:60],
        record.doi,
    )
    return None


async def _fetch_paginated(
    client: httpx.AsyncClient,
    url: str,
    api_key: Optional[str],
    sleep_interval: float,
) -> List[dict]:
    """Fetch all pages from an S2 bulk endpoint using the API's own `next` cursor.

    S2 returns {"offset": N, "next": M, "data": [...]} where `next` is the offset
    for the following page and is ABSENT when there are no more results.  Using the
    `next` field is more reliable than checking ``len(batch) < PAGE_SIZE``: S2 can
    return fewer items than the page size on intermediate pages (due to server-side
    filtering) and that used to cause early termination.
    """
    results: List[dict] = []
    offset = 0
    page_num = 0
    while True:
        data = await _s2_get(
            client, url,
            {"fields": _S2_FIELDS, "limit": _PAGE_SIZE, "offset": offset},
            api_key,
        )
        if data is None:
            if page_num == 0:
                logger.warning("S2 returned no data for %s (first page)", url)
            else:
                logger.warning(
                    "S2 returned no data for %s at offset %d — stopping pagination "
                    "with %d items collected so far",
                    url, offset, len(results),
                )
            break

        batch = data.get("data") or []
        results.extend(batch)
        page_num += 1

        # Use the S2 `next` cursor to drive pagination.  When `next` is absent
        # the API has no more pages to offer.
        next_offset = data.get("next")
        if next_offset is None:
            break
        offset = next_offset
        await asyncio.sleep(sleep_interval)

    return results


_S2_RATE_LIMIT_BACKOFFS = (30, 60, 120)  # seconds between successive 429 retries


async def _s2_get(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    api_key: Optional[str],
) -> Optional[dict]:
    """Make one S2 API GET request with automatic 429 retry (up to 3 attempts).

    Retry schedule on rate-limit: 30 s → 60 s → 120 s.  After three consecutive
    429 responses the call gives up and returns None so the caller can decide
    whether to break pagination or skip the record.
    """
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key

    try:
        resp = await client.get(url, params=params, headers=headers)

        # Retry loop for rate limiting
        for backoff in _S2_RATE_LIMIT_BACKOFFS:
            if resp.status_code != 429:
                break
            logger.warning("S2 rate limit hit for %s; backing off %ds", url, backoff)
            await asyncio.sleep(backoff)
            resp = await client.get(url, params=params, headers=headers)
        else:
            # All retries exhausted
            logger.error(
                "S2 rate limit persists after %d retries for %s; giving up",
                len(_S2_RATE_LIMIT_BACKOFFS), url,
            )
            return None

        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            logger.warning("S2 API %s returned HTTP %d", url, resp.status_code)
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
    """Insert a candidate into the accumulator dict, keyed by (direction, DOI|PMID|S2ID).

    The direction is included in the key so the same paper can appear as both a
    backward reference and a forward citation — two separate candidate rows.
    Within the same direction, the same paper referenced by multiple source records
    collapses to one entry (first source_record_id wins).
    """
    if not paper:
        return
    doi = (paper.get("externalIds") or {}).get("DOI") or None
    if doi:
        doi = doi.lower().strip()
    pmid = str((paper.get("externalIds") or {}).get("PubMed") or "").strip() or None
    s2_id = paper.get("paperId") or None

    paper_id = doi or pmid or s2_id
    if paper_id is None:
        return  # no usable identifier — skip

    # Direction-scoped key: same paper in different directions → separate rows
    key = f"{direction}:{paper_id}"

    if key in candidates:
        return  # already have this paper for this direction (first-seen wins)

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


# ---------------------------------------------------------------------------
# Manual import: parse a user-uploaded citation file
# ---------------------------------------------------------------------------


async def create_manual_search(
    db: AsyncSession,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    direction: str,
    source_record_id: Optional[uuid.UUID],
    file_bytes: bytes,
) -> CitationSearch:
    """Parse a user-uploaded citation file and create a completed CitationSearch immediately.

    Supports the same formats as the import pipeline (RIS, MEDLINE/PubMed-tagged).
    Each parsed record becomes a CitationCandidate tagged with the given direction
    (backward = references of the source paper; forward = papers citing it) and
    optionally linked to a specific extracted paper via source_record_id.

    The search is created with scope='manual' and status='completed' synchronously —
    no background task is needed because file parsing is fast.

    Raises ValueError if the file cannot be parsed or contains no valid records.
    """
    from app.parsers import parse_file
    from app.parsers.base import normalize_doi

    parse_result = parse_file(file_bytes)
    if parse_result.valid_count == 0:
        raise ValueError(
            parse_result.error_summary()
            or "No valid records found in uploaded file. "
               "Please use RIS (.ris) or MEDLINE/PubMed-tagged (.txt) format."
        )

    # Convert parsed records to candidate dicts, dedup within the file
    candidates: List[dict] = []
    seen_keys: set = set()

    for rec in parse_result.records:
        doi = normalize_doi(rec.get("doi"))
        # PMID lives in raw_data (MEDLINE: pmid; RIS: AN / pubmed_id / accession_number)
        raw = rec.get("raw_data") or {}
        pmid = None
        for key in ("pmid", "AN", "pubmed_id", "accession_number"):
            pmid = _extract_pmid(raw.get(key))
            if pmid:
                break

        # Dedup key within this file (direction-scoped, same as automatic search)
        paper_id = doi or pmid or rec.get("title")
        if not paper_id:
            continue  # no usable identifier
        key = f"{direction}:{paper_id}"
        if key in seen_keys:
            continue
        seen_keys.add(key)

        authors = rec.get("authors") or []
        if isinstance(authors, str):
            authors = [a.strip() for a in authors.split(";") if a.strip()]

        candidates.append(
            {
                "direction": direction,
                "source_record_id": source_record_id,
                "s2_paper_id": None,
                "title": rec.get("title"),
                "abstract": rec.get("abstract"),
                "authors": authors or None,
                "year": rec.get("year"),
                "doi": doi,
                "pmid": pmid,
                "journal": rec.get("journal") or rec.get("secondary_title"),
                "in_project": False,
                "project_record_id": None,
            }
        )

    # Flag candidates already present in the project
    candidates = await _dedup_against_project(db, project_id, candidates)

    source_ids_json = [str(source_record_id)] if source_record_id else []

    search = CitationSearch(
        project_id=project_id,
        triggered_by=user_id,
        status="completed",
        direction=direction,
        scope="manual",
        source_record_count=1 if source_record_id else 0,
        source_record_ids=source_ids_json,
        candidate_count=len(candidates),
        already_in_project_count=sum(1 for c in candidates if c.get("in_project")),
        completed_at=datetime.now(timezone.utc),
    )
    db.add(search)
    await db.flush()  # obtain search.id before inserting candidates

    if candidates:
        for i in range(0, len(candidates), _CHUNK_SIZE):
            chunk = candidates[i : i + _CHUNK_SIZE]
            rows = [
                {
                    "id": uuid.uuid4(),
                    "search_id": search.id,
                    "project_id": project_id,
                    "direction": c["direction"],
                    "source_record_id": c.get("source_record_id"),
                    "s2_paper_id": None,
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
    await db.refresh(search)
    return search
