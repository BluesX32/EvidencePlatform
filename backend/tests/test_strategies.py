"""
HS1 acceptance tests — E5: Strategy activation.

Tests verify:
- create() always produces is_active=False initially.
- set_active() marks the target strategy active and all others inactive.
- set_active() is idempotent: calling it twice leaves one strategy active.
- A second set_active() call deactivates the first strategy.
"""
import uuid

import pytest
from sqlalchemy import select

from app.models.match_strategy import MatchStrategy
from app.models.project import Project
from app.models.user import User
from app.repositories.strategy_repo import StrategyRepo


# ── helpers ───────────────────────────────────────────────────────────────────

async def _seed_project(db) -> tuple[uuid.UUID, uuid.UUID]:
    """Seed user + project. Returns (project_id, user_id)."""
    user = User(email=f"test-{uuid.uuid4()}@example.com", password_hash="x", name="Test")
    db.add(user)
    await db.flush()

    project = Project(name="Strategy Test", created_by=user.id)
    db.add(project)
    await db.flush()

    return project.id, user.id


async def _active_strategies(db, project_id) -> list[MatchStrategy]:
    result = await db.execute(
        select(MatchStrategy).where(
            MatchStrategy.project_id == project_id,
            MatchStrategy.is_active == True,  # noqa: E712
        )
    )
    return list(result.scalars().all())


# ── E5: strategy creation ──────────────────────────────────────────────────────

async def test_create_strategy_is_inactive_by_default(db):
    """Newly created strategy must have is_active=False."""
    project_id, _ = await _seed_project(db)
    strategy = await StrategyRepo.create(db, project_id, "My Strategy", "doi_first_strict")
    assert strategy.is_active is False


# ── E5: set_active correctness ────────────────────────────────────────────────

async def test_set_active_marks_strategy_active(db):
    """set_active(strategy_id) makes that strategy is_active=True."""
    project_id, _ = await _seed_project(db)
    s = await StrategyRepo.create(db, project_id, "S1", "strict")

    await StrategyRepo.set_active(db, project_id, s.id)
    await db.refresh(s)

    assert s.is_active is True


async def test_set_active_deactivates_previous_strategy(db):
    """
    With two strategies, activating the second deactivates the first.
    At all times exactly one strategy is active.
    """
    project_id, _ = await _seed_project(db)

    s1 = await StrategyRepo.create(db, project_id, "S1", "doi_first_strict")
    s2 = await StrategyRepo.create(db, project_id, "S2", "medium")

    # Activate s1
    await StrategyRepo.set_active(db, project_id, s1.id)
    active = await _active_strategies(db, project_id)
    assert len(active) == 1
    assert active[0].id == s1.id

    # Activate s2 — s1 must become inactive
    await StrategyRepo.set_active(db, project_id, s2.id)
    await db.refresh(s1)
    await db.refresh(s2)

    assert s1.is_active is False
    assert s2.is_active is True

    active = await _active_strategies(db, project_id)
    assert len(active) == 1
    assert active[0].id == s2.id


async def test_set_active_with_three_strategies_leaves_one_active(db):
    """Activating the third strategy deactivates both previous ones."""
    project_id, _ = await _seed_project(db)

    s1 = await StrategyRepo.create(db, project_id, "S1", "doi_first_strict")
    s2 = await StrategyRepo.create(db, project_id, "S2", "strict")
    s3 = await StrategyRepo.create(db, project_id, "S3", "medium")

    await StrategyRepo.set_active(db, project_id, s1.id)
    await StrategyRepo.set_active(db, project_id, s2.id)
    await StrategyRepo.set_active(db, project_id, s3.id)

    active = await _active_strategies(db, project_id)
    assert len(active) == 1
    assert active[0].id == s3.id


async def test_set_active_is_idempotent(db):
    """Calling set_active twice on the same strategy leaves it active."""
    project_id, _ = await _seed_project(db)
    s = await StrategyRepo.create(db, project_id, "S1", "doi_first_strict")

    await StrategyRepo.set_active(db, project_id, s.id)
    await StrategyRepo.set_active(db, project_id, s.id)

    active = await _active_strategies(db, project_id)
    assert len(active) == 1
    assert active[0].id == s.id


async def test_get_active_returns_none_when_no_active_strategy(db):
    """get_active() returns None when no strategy is marked active."""
    project_id, _ = await _seed_project(db)
    # Create a strategy but do not activate it
    await StrategyRepo.create(db, project_id, "S1", "doi_first_strict")

    active = await StrategyRepo.get_active(db, project_id)
    assert active is None


async def test_get_active_returns_the_active_strategy(db):
    """get_active() returns the strategy that was set active."""
    project_id, _ = await _seed_project(db)
    s = await StrategyRepo.create(db, project_id, "S1", "doi_first_strict")

    await StrategyRepo.set_active(db, project_id, s.id)
    active = await StrategyRepo.get_active(db, project_id)

    assert active is not None
    assert active.id == s.id
    assert active.preset == "doi_first_strict"
