"""Tests for AI job stop/resume control and per-job results (migration 053).

Covers app/routers/ai_pilot.py's generic stop/results endpoints and the
shared helpers used by every batch job (extract, concepts, resolve_conflicts):
_resolve_record_for_item, _stop_flag_set/_finish_job cooperative-stop
bookkeeping, and result linkage via ai_job_id.
"""
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models.ai_job import AiJob
from app.models.concept_extraction import ConceptExtraction
from app.models.consensus_decision import ConsensusDecision
from app.models.extraction_record import ExtractionRecord
from app.models.overlap_cluster import OverlapCluster
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.project import Project
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.source import Source
from app.models.user import User
from app.routers import ai_pilot
from app.routers.ai_pilot import (
    _RUNNING_TASKS,
    _STOP_REQUESTS,
    _finish_job,
    _resolve_record_for_item,
    _stop_flag_set,
    get_ai_job_results,
    stop_ai_job,
)


@pytest.fixture
async def own_session_factory(monkeypatch):
    """_update_job/_finish_job use the module-level SessionLocal (its own
    session, on purpose — so a caller rollback doesn't lose progress writes).
    Bind that to this test's event loop, matching test_llm_client.py's
    pattern for the same reason (conftest.py: the global engine is bound to
    whichever event loop first touched it)."""
    engine = create_async_engine(settings.database_url, echo=False)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(ai_pilot, "SessionLocal", factory)
    yield factory
    await engine.dispose()


async def _seed_project(db):
    user = User(email=f"aijobctl-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()
    project = Project(name="AI Job Control Test", created_by=user.id)
    db.add(project)
    await db.flush()
    return user, project


async def _seed_record(db, project, title="Paper"):
    record = Record(project_id=project.id, title=title, source_format="ris")
    db.add(record)
    await db.flush()
    return record


@pytest.mark.asyncio
async def test_stop_endpoint_sets_flag(db):
    user, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="extract", status="running", triggered_by=user.id)
    db.add(job)
    await db.commit()

    out = await stop_ai_job(project_id=project.id, job_id=job.id, db=db, user=user)
    assert out["status"] == "stopping"
    await db.refresh(job)
    assert job.stop_requested is True
    assert job.id in _STOP_REQUESTS
    _STOP_REQUESTS.discard(job.id)
    await db.rollback()


@pytest.mark.asyncio
async def test_stop_endpoint_rejects_non_running_job(db):
    user, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="extract", status="done", triggered_by=user.id)
    db.add(job)
    await db.commit()

    with pytest.raises(HTTPException) as excinfo:
        await stop_ai_job(project_id=project.id, job_id=job.id, db=db, user=user)
    assert excinfo.value.status_code == 400
    await db.rollback()


@pytest.mark.asyncio
async def test_stop_endpoint_cancels_registered_task(db):
    user, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="draft_setup", status="running", triggered_by=user.id)
    db.add(job)
    await db.commit()

    import asyncio

    async def _forever():
        await asyncio.sleep(100)

    task = asyncio.ensure_future(_forever())
    _RUNNING_TASKS[job.id] = task
    try:
        await stop_ai_job(project_id=project.id, job_id=job.id, db=db, user=user)
        assert task.cancelled() or task.cancelling() > 0
    finally:
        task.cancel()
        _RUNNING_TASKS.pop(job.id, None)
        _STOP_REQUESTS.discard(job.id)
        await db.rollback()


@pytest.mark.asyncio
async def test_finish_job_reports_stopped_when_flag_set(db, own_session_factory):
    user, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="extract", status="running", triggered_by=user.id)
    db.add(job)
    await db.commit()

    _STOP_REQUESTS.add(job.id)
    _RUNNING_TASKS[job.id] = object()  # any truthy sentinel; _finish_job just pops it
    await _finish_job(job.id)

    assert job.id not in _STOP_REQUESTS
    assert job.id not in _RUNNING_TASKS
    await db.refresh(job)
    assert job.status == "stopped"
    await db.rollback()


@pytest.mark.asyncio
async def test_finish_job_reports_done_when_not_stopped(db, own_session_factory):
    user, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="extract", status="running", triggered_by=user.id)
    db.add(job)
    await db.commit()

    assert not _stop_flag_set(job.id)
    await _finish_job(job.id)

    await db.refresh(job)
    assert job.status == "done"
    await db.rollback()


@pytest.mark.asyncio
async def test_resolve_record_for_item_handles_record_and_cluster(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)

    via_record = await _resolve_record_for_item(db, record.id, None)
    assert via_record is not None
    assert via_record.id == record.id

    source = Source(project_id=project.id, name="PubMed")
    db.add(source)
    await db.flush()
    from app.models.import_job import ImportJob
    job_row = ImportJob(
        project_id=project.id, source_id=source.id, filename="x.ris", file_format="ris",
        status="completed", created_by=user.id,
    )
    db.add(job_row)
    await db.flush()
    rs = RecordSource(record_id=record.id, source_id=source.id, import_job_id=job_row.id, raw_data={})
    db.add(rs)
    await db.flush()
    cluster = OverlapCluster(project_id=project.id, scope="cross_source", match_tier=1, match_basis="tier1_doi")
    db.add(cluster)
    await db.flush()
    ocm = OverlapClusterMember(cluster_id=cluster.id, record_source_id=rs.id, source_id=source.id, role="canonical")
    db.add(ocm)
    await db.commit()

    via_cluster = await _resolve_record_for_item(db, None, cluster.id)
    assert via_cluster is not None
    assert via_cluster.id == record.id
    await db.rollback()


@pytest.mark.asyncio
async def test_results_endpoint_lists_extract_job_output(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)
    job = AiJob(project_id=project.id, job_type="extract", status="done", triggered_by=user.id)
    db.add(job)
    await db.flush()
    db.add(ExtractionRecord(
        project_id=project.id, record_id=record.id, extracted_json={"table": {}},
        reviewer_id=user.id, origin="ai", ai_job_id=job.id,
    ))
    await db.commit()

    out = await get_ai_job_results(project_id=project.id, job_id=job.id, db=db, user=user)
    assert out["job"]["job_id"] == str(job.id)
    assert len(out["items"]) == 1
    assert out["items"][0]["record_id"] == str(record.id)
    assert out["items"][0]["title"] == record.title
    await db.rollback()


@pytest.mark.asyncio
async def test_results_endpoint_lists_resolve_conflicts_output(db):
    user, project = await _seed_project(db)
    record = await _seed_record(db, project)
    job = AiJob(project_id=project.id, job_type="resolve_conflicts", status="done", triggered_by=user.id)
    db.add(job)
    await db.flush()
    db.add(ConsensusDecision(
        project_id=project.id, record_id=record.id, stage="TA", decision="include",
        notes="[AI] test rationale", adjudicator_id=user.id, origin="ai", ai_job_id=job.id,
    ))
    await db.commit()

    out = await get_ai_job_results(project_id=project.id, job_id=job.id, db=db, user=user)
    assert len(out["items"]) == 1
    assert out["items"][0]["decision"] == "include"
    assert out["items"][0]["stage"] == "TA"
    await db.rollback()


@pytest.mark.asyncio
async def test_results_endpoint_returns_stored_result_for_oneshot_jobs(db):
    user, project = await _seed_project(db)
    job = AiJob(
        project_id=project.id, job_type="suggest_themes", status="done", triggered_by=user.id,
        result_json={"themes": [{"name": "Access to care"}]},
    )
    db.add(job)
    await db.commit()

    out = await get_ai_job_results(project_id=project.id, job_id=job.id, db=db, user=user)
    assert out["items"] is None
    assert out["job"]["result"] == {"themes": [{"name": "Access to care"}]}
    await db.rollback()
