"""
Integration tests for multi-source import: canonical dedup, idempotency, overlap.

These tests require the dev PostgreSQL DB (localhost:5433) to be running.
Each test is wrapped in a rolled-back transaction so it leaves no side effects.

Covered behaviours
------------------
- Same DOI imported from two sources → 1 records row, 2 record_sources rows
- Same DOI + same source re-imported → fully idempotent (0 new rows anywhere)
- No-DOI records are NOT deduplicated across sources
- Overlap endpoint returns correct per-source totals and pairwise shared count
- source_record_id always present in raw_data (null when absent in file)
"""
import uuid
from typing import Optional

import pytest
from sqlalchemy import select, func

from app.models.import_job import ImportJob
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source
from app.models.project import Project
from app.models.user import User
from app.repositories.record_repo import RecordRepo
from app.repositories.overlap_repo import OverlapRepo


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_record(doi: Optional[str], title: str = "Test Record") -> dict:
    """Minimal parsed record dict as produced by the RIS parser."""
    return {
        "title": title,
        "abstract": None,
        "authors": ["Author, A"],
        "year": 2024,
        "journal": "Test Journal",
        "volume": None,
        "issue": None,
        "pages": None,
        "doi": doi,
        "issn": None,
        "keywords": None,
        "source_format": "ris",
        "raw_data": {"source_record_id": "PMID123" if doi else None},
    }


async def _seed_project_and_sources(db) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID]:
    """
    Create a user, project, and two sources.
    Returns (project_id, source_a_id, source_b_id, import_job_id).
    """
    user = User(
        email=f"test-{uuid.uuid4()}@example.com",
        password_hash="x",
        name="Test",
    )
    db.add(user)
    await db.flush()

    project = Project(name="Test Project", created_by=user.id)
    db.add(project)
    await db.flush()

    source_a = Source(project_id=project.id, name="PubMed")
    source_b = Source(project_id=project.id, name="Scopus")
    db.add(source_a)
    db.add(source_b)
    await db.flush()

    job = ImportJob(
        project_id=project.id,
        created_by=user.id,
        filename="test.ris",
        file_format="ris",
        status="completed",
    )
    db.add(job)
    await db.flush()

    return project.id, source_a.id, source_b.id, job.id


# ── dedup tests ───────────────────────────────────────────────────────────────

async def test_same_doi_two_sources_one_canonical_record(db):
    """DOI imported from Source A then Source B → 1 record, 2 record_sources."""
    project_id, sa_id, sb_id, job_id = await _seed_project_and_sources(db)
    doi = "10.1234/test-dedup"
    rec = _make_record(doi)

    count_a = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sa_id, import_job_id=job_id
    )
    count_b = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sb_id, import_job_id=job_id
    )

    # Each import should have added 1 new record_sources row.
    assert count_a == 1
    assert count_b == 1

    # Only one canonical record in `records`.
    total_records = (
        await db.execute(
            select(func.count()).where(
                Record.project_id == project_id,
                Record.normalized_doi == doi,
            )
        )
    ).scalar_one()
    assert total_records == 1

    # Two join rows in record_sources.
    total_links = (
        await db.execute(
            select(func.count()).select_from(RecordSource).join(Record).where(
                Record.project_id == project_id
            )
        )
    ).scalar_one()
    assert total_links == 2


async def test_same_doi_same_source_reimport_is_idempotent(db):
    """Re-importing the same file for the same source → 0 new rows."""
    project_id, sa_id, _, job_id = await _seed_project_and_sources(db)
    doi = "10.1234/test-idempotent"
    rec = _make_record(doi)

    count_first = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sa_id, import_job_id=job_id
    )
    count_second = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sa_id, import_job_id=job_id
    )

    assert count_first == 1
    assert count_second == 0  # idempotent: no new rows on re-import

    total_records = (
        await db.execute(
            select(func.count()).where(
                Record.project_id == project_id,
                Record.normalized_doi == doi,
            )
        )
    ).scalar_one()
    assert total_records == 1

    total_links = (
        await db.execute(
            select(func.count()).select_from(RecordSource).join(Record).where(
                Record.project_id == project_id
            )
        )
    ).scalar_one()
    assert total_links == 1


async def test_no_doi_no_title_records_not_deduplicated(db):
    """Records with no DOI and no title (match_key=None) are never deduplicated.

    In Slice 3, records without a DOI *can* be deduplicated if they have title+author+year.
    Records that lack required fields for any preset remain isolated (match_key=None).
    """
    project_id, sa_id, sb_id, job_id = await _seed_project_and_sources(db)

    # Record with no DOI and no title → no match key under any preset
    rec = {
        "title": None,
        "abstract": None,
        "authors": None,
        "year": 2024,
        "journal": "Some Journal",
        "volume": None,
        "issue": None,
        "pages": None,
        "doi": None,
        "issn": None,
        "keywords": None,
        "source_format": "ris",
        "raw_data": {"source_record_id": None},
    }

    count_a = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sa_id, import_job_id=job_id
    )
    count_b = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sb_id, import_job_id=job_id
    )

    assert count_a == 1
    assert count_b == 1

    # Two separate canonical rows because match_key=NULL → no dedup possible.
    total_records = (
        await db.execute(
            select(func.count()).where(
                Record.project_id == project_id,
                Record.match_key.is_(None),
            )
        )
    ).scalar_one()
    assert total_records == 2


async def test_no_doi_with_title_author_year_is_deduplicated(db):
    """No-DOI records with complete title+author+year deduplicate under doi_first_strict."""
    project_id, sa_id, sb_id, job_id = await _seed_project_and_sources(db)
    rec = _make_record(doi=None, title="Mindfulness and Depression: A Systematic Review")

    count_a = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sa_id, import_job_id=job_id
    )
    count_b = await RecordRepo.upsert_and_link(
        db, [rec], project_id=project_id, source_id=sb_id, import_job_id=job_id
    )

    assert count_a == 1
    assert count_b == 1  # idempotent — same record_sources conflict

    # 1 canonical record — deduplicated by title+author+year fallback
    total_records = (
        await db.execute(
            select(func.count()).where(
                Record.project_id == project_id,
                Record.match_basis == "title_author_year",
            )
        )
    ).scalar_one()
    assert total_records == 1


# ── overlap tests ─────────────────────────────────────────────────────────────

async def test_overlap_source_totals(db):
    """source_totals returns correct total and with_doi counts."""
    project_id, sa_id, sb_id, job_id = await _seed_project_and_sources(db)

    records_a = [
        _make_record("10.1234/a1"),
        _make_record("10.1234/a2"),
        _make_record(None, "No DOI A"),
    ]
    records_b = [
        _make_record("10.1234/a1"),  # overlaps with source A
        _make_record("10.1234/b1"),
    ]

    await RecordRepo.upsert_and_link(db, records_a, project_id, sa_id, job_id)
    await RecordRepo.upsert_and_link(db, records_b, project_id, sb_id, job_id)

    totals = await OverlapRepo.source_totals(db, project_id)
    totals_by_name = {row.name: row for row in totals}

    assert totals_by_name["PubMed"].total == 3
    assert totals_by_name["PubMed"].with_doi == 2
    assert totals_by_name["Scopus"].total == 2
    assert totals_by_name["Scopus"].with_doi == 2


async def test_pairwise_overlap_shared_records(db):
    """pairwise_overlap counts canonical records claimed by both sources."""
    project_id, sa_id, sb_id, job_id = await _seed_project_and_sources(db)

    shared_doi = "10.1234/shared"
    records_a = [_make_record(shared_doi), _make_record("10.1234/only-a")]
    records_b = [_make_record(shared_doi), _make_record("10.1234/only-b")]

    await RecordRepo.upsert_and_link(db, records_a, project_id, sa_id, job_id)
    await RecordRepo.upsert_and_link(db, records_b, project_id, sb_id, job_id)

    pairs = await OverlapRepo.pairwise_overlap(db, project_id)
    assert len(pairs) == 1
    assert pairs[0].shared_records == 1


async def test_pairwise_overlap_no_overlap(db):
    """Pairwise overlap returns empty when sources share no records."""
    project_id, sa_id, sb_id, job_id = await _seed_project_and_sources(db)

    await RecordRepo.upsert_and_link(db, [_make_record("10.1234/x")], project_id, sa_id, job_id)
    await RecordRepo.upsert_and_link(db, [_make_record("10.1234/y")], project_id, sb_id, job_id)

    pairs = await OverlapRepo.pairwise_overlap(db, project_id)
    assert pairs == []


# ── parser: source_record_id ──────────────────────────────────────────────────

def test_source_record_id_always_in_raw_data():
    """raw_data must always contain the 'source_record_id' key (null when absent)."""
    from app.parsers.ris import _normalize

    entry_with_an = {"accession_number": "PMID12345678", "title": "Some Article"}
    entry_without_an = {"title": "No AN Article", "doi": "10.1234/x"}

    rec_with = _normalize(entry_with_an)
    rec_without = _normalize(entry_without_an)

    assert "source_record_id" in rec_with["raw_data"]
    assert rec_with["raw_data"]["source_record_id"] == "PMID12345678"

    assert "source_record_id" in rec_without["raw_data"]
    assert rec_without["raw_data"]["source_record_id"] is None


def test_source_record_id_from_pubmed_id_field():
    """Falls back to pubmed_id when accession_number is absent."""
    from app.parsers.ris import _normalize

    entry = {"pubmed_id": "87654321", "title": "PubMed article"}
    rec = _normalize(entry)
    assert rec["raw_data"]["source_record_id"] == "87654321"


def test_source_record_id_prefers_accession_number():
    """accession_number takes priority over pubmed_id."""
    from app.parsers.ris import _normalize

    entry = {"accession_number": "AN001", "pubmed_id": "PM999", "title": "Both fields"}
    rec = _normalize(entry)
    assert rec["raw_data"]["source_record_id"] == "AN001"
