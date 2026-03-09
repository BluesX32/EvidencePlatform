"""
Integration tests for _fetch_standalone_record and get_next_item metadata path.

These tests require the dev PostgreSQL DB and verify that the SQL used to
fetch record metadata (title, source_names, pmid/pmcid) works against the
real database engine, including the JSONB raw_data handling.

Previously, _fetch_standalone_record used func.min(raw_data) which fails in
PostgreSQL ("function min(jsonb) does not exist"). This test catches that class
of regression.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models.import_job import ImportJob
from app.models.project import Project
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source
from app.models.user import User
from app.repositories.record_repo import RecordRepo
from app.services.direct_screening_service import (
    _fetch_standalone_record,
    get_next_item,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _seed(db):
    """Create a minimal user/project/source/record and return IDs."""
    user = User(email=f"meta-{uuid.uuid4()}@example.com", password_hash="x", name="T")
    db.add(user)
    await db.flush()

    project = Project(name="Meta Test", created_by=user.id)
    db.add(project)
    await db.flush()

    source = Source(project_id=project.id, name="PubMed")
    db.add(source)
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

    return project.id, source.id, job.id, user.id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestFetchStandaloneRecord:
    """Verify _fetch_standalone_record runs without error on PostgreSQL."""

    async def test_returns_metadata_for_existing_record(self, db):
        """The function returns title/source_names/pmid without crashing."""
        project_id, source_id, job_id, _ = await _seed(db)

        parsed = {
            "title": "Test Article About JSONB",
            "abstract": "Some abstract text.",
            "authors": ["Smith, J"],
            "year": 2023,
            "journal": "Test Journal",
            "volume": "10",
            "issue": None,
            "pages": "1-5",
            "doi": "10.9999/meta-test",
            "issn": None,
            "keywords": None,
            "source_format": "ris",
            "raw_data": {"pmid": "99999999", "source_record_id": "SRC-1"},
        }
        await RecordRepo.upsert_and_link(
            db, [parsed], project_id=project_id, source_id=source_id,
            import_job_id=job_id,
        )

        rec = (
            await db.execute(
                select(Record).where(Record.project_id == project_id)
            )
        ).scalars().first()
        assert rec is not None

        meta = await _fetch_standalone_record(db, rec.id, project_id)

        assert meta["title"] == "Test Article About JSONB"
        assert "PubMed" in meta["source_names"]
        assert meta["doi"] == "10.9999/meta-test"
        assert meta["pmid"] == "99999999"
        assert meta["pmcid"] is None

    async def test_returns_nulls_for_missing_record(self, db):
        """A record_id that doesn't exist returns a dict of Nones."""
        project_id, *_ = await _seed(db)
        meta = await _fetch_standalone_record(db, uuid.uuid4(), project_id)
        assert meta["title"] is None
        assert meta["source_names"] == []
        assert meta["pmid"] is None


class TestGetNextItemMetadata:
    """Verify get_next_item returns full metadata (not a 500) for real records."""

    async def test_next_item_includes_title_and_source_names(self, db):
        """get_next_item must return title/source_names for a standalone record."""
        project_id, source_id, job_id, reviewer_id = await _seed(db)

        parsed = {
            "title": "Metadata Integration Test Paper",
            "abstract": "Abstract here.",
            "authors": ["Doe, J"],
            "year": 2022,
            "journal": "J Test",
            "volume": None,
            "issue": None,
            "pages": None,
            "doi": "10.8888/integration",
            "issn": None,
            "keywords": None,
            "source_format": "ris",
            "raw_data": {"accession_number": "PMID-12345678"},
        }
        await RecordRepo.upsert_and_link(
            db, [parsed], project_id=project_id, source_id=source_id,
            import_job_id=job_id,
        )

        result = await get_next_item(
            db,
            project_id=project_id,
            source_id="all",
            mode="screen",
            reviewer_id=reviewer_id,
        )

        assert result.get("done") is not True
        assert result["title"] == "Metadata Integration Test Paper"
        assert "PubMed" in result["source_names"]
        assert result["pmid"] == "PMID-12345678"