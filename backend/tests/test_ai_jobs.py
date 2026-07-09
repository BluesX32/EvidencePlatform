"""Tests for persistent AI Pilot batch jobs (ai_jobs table).

Covers the job lifecycle helpers in app/routers/ai_pilot.py: latest-job
lookup, payload shape, progress updates, and stale-heartbeat reaping.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update

from app.models.ai_job import AiJob
from app.models.project import Project
from app.models.user import User
from app.routers.ai_pilot import (
    _current_job_payload,
    _job_payload,
    _latest_job,
    _reap_if_stale,
)


async def _seed_project(db):
    user = User(email=f"aijob-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()
    project = Project(name="AI Job Test", created_by=user.id)
    db.add(project)
    await db.flush()
    return user, project


def test_idle_payload_when_no_job():
    assert _job_payload(None) == {"status": "idle"}


@pytest.mark.asyncio
async def test_job_lifecycle_and_latest(db):
    user, project = await _seed_project(db)

    # created_at uses server_default=func.now(), which is transaction start
    # time in Postgres — both rows would tie if inserted in one transaction,
    # so older must be committed (ending its transaction) before newer starts.
    older = AiJob(project_id=project.id, job_type="extract", status="done",
                  total=5, done=5, model="claude-sonnet-4-6", triggered_by=user.id,
                  completed_at=datetime.now(tz=timezone.utc))
    db.add(older)
    await db.commit()
    newer = AiJob(project_id=project.id, job_type="extract", status="running",
                  total=10, done=3, errors=1, model="claude-sonnet-4-6",
                  triggered_by=user.id)
    db.add(newer)
    await db.commit()

    latest = await _latest_job(db, project.id, "extract")
    assert latest.id == newer.id

    payload = _job_payload(latest)
    assert payload["status"] == "running"
    assert payload["done"] == 3
    assert payload["total"] == 10
    assert payload["errors"] == 1
    assert payload["job_id"] == str(newer.id)
    assert payload["job_type"] == "extract"

    # Different job type is tracked independently
    assert await _latest_job(db, project.id, "concepts") is None
    assert (await _current_job_payload(db, project.id, "concepts")) == {"status": "idle"}


@pytest.mark.asyncio
async def test_fresh_running_job_blocks_new_run(db):
    _, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="extract", status="running")
    db.add(job)
    await db.commit()

    assert await _reap_if_stale(db, job) is True
    assert job.status == "running"


@pytest.mark.asyncio
async def test_stale_running_job_is_reaped(db):
    _, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="extract", status="running",
                total=10, done=2)
    db.add(job)
    await db.commit()
    # Simulate a heartbeat older than the staleness threshold
    await db.execute(
        update(AiJob).where(AiJob.id == job.id).values(
            updated_at=datetime.now(tz=timezone.utc) - timedelta(minutes=10)
        )
    )
    await db.commit()
    await db.refresh(job)

    assert await _reap_if_stale(db, job) is False
    assert job.status == "failed"
    assert "Interrupted" in job.error_message
    assert job.completed_at is not None

    # The status payload now reflects the interruption instead of blocking forever
    payload = await _current_job_payload(db, project.id, "extract")
    assert payload["status"] == "failed"
    assert payload["done"] == 2


@pytest.mark.asyncio
async def test_completed_job_never_reaped(db):
    _, project = await _seed_project(db)
    job = AiJob(project_id=project.id, job_type="concepts", status="done",
                total=4, done=4, completed_at=datetime.now(tz=timezone.utc))
    db.add(job)
    await db.commit()

    assert await _reap_if_stale(db, job) is False
    assert job.status == "done"
