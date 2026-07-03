"""Tests for structured AI provenance (migration 049).

Every table AI can write to carries an `origin` column ('human' | 'ai'),
replacing the old implicit conventions (reviewer_id IS NULL, "[AI]" note
prefixes). These tests exercise the write paths that set it.
"""
import uuid

import pytest

from app.models.project import Project
from app.models.record import Record
from app.models.user import User
from app.services.consensus_service import adjudicate
from app.services.direct_screening_service import submit_decision


async def _seed(db):
    user = User(email=f"prov-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()
    project = Project(name="Provenance Test", created_by=user.id)
    db.add(project)
    await db.flush()
    record = Record(project_id=project.id, title="Paper A", source_format="ris")
    db.add(record)
    await db.flush()
    return user, project, record


@pytest.mark.asyncio
async def test_human_decision_gets_human_origin(db):
    user, project, record = await _seed(db)
    out = await submit_decision(
        db, project.id, record.id, None,
        stage="TA", decision="include", reason_code=None, notes=None,
        reviewer_id=user.id,
    )
    assert out["origin"] == "human"
    await db.rollback()


@pytest.mark.asyncio
async def test_synthetic_decision_gets_ai_origin(db):
    _, project, record = await _seed(db)
    out = await submit_decision(
        db, project.id, record.id, None,
        stage="TA", decision="exclude", reason_code=None, notes="LLM: test-model",
        reviewer_id=None,
    )
    assert out["origin"] == "ai"
    await db.rollback()


@pytest.mark.asyncio
async def test_adjudicate_records_origin(db):
    user, project, record = await _seed(db)

    human = await adjudicate(
        db, project.id, record.id, None,
        stage="TA", decision="include", adjudicator_id=user.id,
    )
    assert human.origin == "human"

    # AI bulk resolution overwrites with origin='ai'
    ai = await adjudicate(
        db, project.id, record.id, None,
        stage="TA", decision="exclude", adjudicator_id=user.id,
        notes="[AI] criteria exclude this design", origin="ai",
    )
    assert ai.origin == "ai"
    assert ai.id == human.id  # overwrote the same consensus slot
    await db.rollback()
