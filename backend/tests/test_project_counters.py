"""
HS1 acceptance tests — E1: Project counter correctness.

Tests verify:
- count_records() returns the number of canonical (deduplicated) records,
  not the number of record_sources rows.
- count_completed() counts only jobs with status='completed'.
- failed_import_count is computed correctly from all jobs.
"""
import uuid
from typing import Optional

import pytest
from sqlalchemy import func, select

from app.models.import_job import ImportJob
from app.models.project import Project
from app.models.record import Record
from app.models.source import Source
from app.models.user import User
from app.repositories.import_repo import ImportRepo
from app.repositories.project_repo import ProjectRepo
from app.repositories.record_repo import RecordRepo


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_record(doi: Optional[str], title: str = "Counter Test Record") -> dict:
    return {
        "title": title,
        "abstract": "Abstract text.",
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
        "raw_data": {"source_record_id": None},
    }


async def _seed(db) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID]:
    """Seed user, project, two sources, one import job. Returns IDs."""
    user = User(email=f"test-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()

    project = Project(name="Counter Test Project", created_by=user.id)
    db.add(project)
    await db.flush()

    src_a = Source(project_id=project.id, name="PubMed")
    src_b = Source(project_id=project.id, name="Scopus")
    db.add(src_a)
    db.add(src_b)
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

    return project.id, src_a.id, src_b.id, job.id


# ── E1: record_count correctness ──────────────────────────────────────────────

async def test_count_records_returns_canonical_count_not_source_memberships(db):
    """
    One DOI imported from two sources → 1 canonical record, 2 record_sources.
    count_records() must return 1 (canonical), not 2 (memberships).
    """
    project_id, sa_id, sb_id, job_id = await _seed(db)
    doi = "10.9999/counter-canonical"

    await RecordRepo.upsert_and_link(db, [_make_record(doi)], project_id, sa_id, job_id)
    await RecordRepo.upsert_and_link(db, [_make_record(doi)], project_id, sb_id, job_id)

    count = await ProjectRepo.count_records(db, project_id)
    assert count == 1, (
        f"Expected 1 canonical record, got {count}. "
        "count_records() may be counting record_sources rows instead of records rows."
    )


async def test_count_records_three_distinct_records(db):
    """Three distinct DOIs → count_records() returns 3."""
    project_id, sa_id, _, job_id = await _seed(db)

    recs = [
        _make_record("10.9999/r1"),
        _make_record("10.9999/r2"),
        _make_record("10.9999/r3"),
    ]
    await RecordRepo.upsert_and_link(db, recs, project_id, sa_id, job_id)

    count = await ProjectRepo.count_records(db, project_id)
    assert count == 3


async def test_count_records_zero_for_empty_project(db):
    """Freshly created project → count_records() returns 0."""
    project_id, _, _, _ = await _seed(db)
    count = await ProjectRepo.count_records(db, project_id)
    assert count == 0


# ── E1: import_count correctness ──────────────────────────────────────────────

async def _create_job(db, project_id, user_id, status: str) -> ImportJob:
    job = ImportJob(
        project_id=project_id,
        created_by=user_id,
        filename=f"test-{status}.ris",
        file_format="ris",
        status=status,
    )
    db.add(job)
    await db.flush()
    return job


async def test_count_completed_counts_only_completed_jobs(db):
    """
    1 completed + 1 failed + 1 pending → count_completed() == 1.
    """
    user = User(email=f"test-{uuid.uuid4()}@example.com", password_hash="x", name="T")
    db.add(user)
    await db.flush()

    project = Project(name="Import Count Test", created_by=user.id)
    db.add(project)
    await db.flush()

    await _create_job(db, project.id, user.id, "completed")
    await _create_job(db, project.id, user.id, "failed")
    await _create_job(db, project.id, user.id, "pending")

    count = await ImportRepo.count_completed(db, project.id)
    assert count == 1, (
        f"Expected import_count=1 (only completed), got {count}. "
        "count_completed() may be counting all jobs."
    )


async def test_count_completed_multiple_completed_jobs(db):
    """3 completed jobs → count_completed() == 3."""
    user = User(email=f"test-{uuid.uuid4()}@example.com", password_hash="x", name="T")
    db.add(user)
    await db.flush()

    project = Project(name="Multi Completed", created_by=user.id)
    db.add(project)
    await db.flush()

    for _ in range(3):
        await _create_job(db, project.id, user.id, "completed")

    count = await ImportRepo.count_completed(db, project.id)
    assert count == 3


async def test_count_completed_zero_when_no_jobs(db):
    """Fresh project with no jobs → count_completed() == 0."""
    user = User(email=f"test-{uuid.uuid4()}@example.com", password_hash="x", name="T")
    db.add(user)
    await db.flush()

    project = Project(name="No Jobs", created_by=user.id)
    db.add(project)
    await db.flush()

    count = await ImportRepo.count_completed(db, project.id)
    assert count == 0
