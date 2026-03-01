"""
Pure unit tests for VS4 screening workflow helpers.

All tests are DB-free — they exercise:
  - _resolve_canonical_key : canonical key construction
  - Queue deduplication logic (simulated)
  - Saturation counter logic (_update_saturation equivalent)
  - Seed-deterministic shuffle
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from app.services.screening_service import _resolve_canonical_key


# ---------------------------------------------------------------------------
# Helpers mirroring service logic for pure tests
# ---------------------------------------------------------------------------

def _simulate_queue_generation(
    record_ids: List[uuid.UUID],
    cluster_map: Dict[uuid.UUID, uuid.UUID],
    prior_keys: set,
    seed: int,
) -> List[str]:
    """Pure equivalent of generate_queue's dedup + filter + shuffle steps."""
    seen: set = set()
    canonical_keys: List[str] = []
    for rid in record_ids:
        key = _resolve_canonical_key(rid, cluster_map)
        if key not in seen:
            seen.add(key)
            canonical_keys.append(key)
    canonical_keys = [k for k in canonical_keys if k not in prior_keys]
    rng = random.Random(seed)
    rng.shuffle(canonical_keys)
    return canonical_keys


def _simulate_saturation(
    total_extracted: int,
    consecutive_no_novelty: int,
    saturation_threshold: int,
    stopped_at: Optional[datetime],
    novelty_flag: bool,
) -> Dict:
    """Pure equivalent of CorpusRepo.update_saturation."""
    total_extracted += 1
    if novelty_flag:
        consecutive_no_novelty = 0
    else:
        consecutive_no_novelty += 1
    if stopped_at is None and consecutive_no_novelty >= saturation_threshold:
        stopped_at = datetime.now(tz=timezone.utc)
    return {
        "total_extracted": total_extracted,
        "consecutive_no_novelty": consecutive_no_novelty,
        "stopped_at": stopped_at,
    }


# ---------------------------------------------------------------------------
# Canonical key resolution
# ---------------------------------------------------------------------------

class TestResolveCanonicalKey:
    def test_record_in_cluster_map(self):
        rid = uuid.uuid4()
        cluster_id = uuid.uuid4()
        key = _resolve_canonical_key(rid, {rid: cluster_id})
        assert key == f"pg:{cluster_id}"

    def test_record_not_in_cluster_map(self):
        rid = uuid.uuid4()
        key = _resolve_canonical_key(rid, {})
        assert key == f"rec:{rid}"

    def test_prefix_pg_for_clustered(self):
        rid = uuid.uuid4()
        cid = uuid.uuid4()
        key = _resolve_canonical_key(rid, {rid: cid})
        assert key.startswith("pg:")

    def test_prefix_rec_for_standalone(self):
        rid = uuid.uuid4()
        key = _resolve_canonical_key(rid, {})
        assert key.startswith("rec:")

    def test_different_records_same_cluster(self):
        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        cid = uuid.uuid4()
        cluster_map = {rid1: cid, rid2: cid}
        assert _resolve_canonical_key(rid1, cluster_map) == _resolve_canonical_key(rid2, cluster_map)


# ---------------------------------------------------------------------------
# Queue deduplication
# ---------------------------------------------------------------------------

class TestQueueDeduplication:
    def test_excludes_prior_decided_keys(self):
        rid1, rid2, rid3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        cluster_map: Dict[uuid.UUID, uuid.UUID] = {}
        prior_keys = {f"rec:{rid1}"}
        keys = _simulate_queue_generation([rid1, rid2, rid3], cluster_map, prior_keys, seed=42)
        assert f"rec:{rid1}" not in keys
        assert f"rec:{rid2}" in keys
        assert f"rec:{rid3}" in keys

    def test_deduplicates_same_cluster_within_corpus(self):
        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        cid = uuid.uuid4()
        cluster_map = {rid1: cid, rid2: cid}
        keys = _simulate_queue_generation([rid1, rid2], cluster_map, set(), seed=42)
        # Both resolve to same pg: key → only one queue slot
        assert len(keys) == 1
        assert keys[0] == f"pg:{cid}"

    def test_no_prior_keys_keeps_all(self):
        record_ids = [uuid.uuid4() for _ in range(5)]
        keys = _simulate_queue_generation(record_ids, {}, set(), seed=0)
        assert len(keys) == 5

    def test_all_prior_decided_leaves_empty_queue(self):
        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        prior_keys = {f"rec:{rid1}", f"rec:{rid2}"}
        keys = _simulate_queue_generation([rid1, rid2], {}, prior_keys, seed=0)
        assert keys == []


# ---------------------------------------------------------------------------
# Saturation logic
# ---------------------------------------------------------------------------

class TestSaturation:
    def test_novelty_resets_consecutive_counter(self):
        result = _simulate_saturation(
            total_extracted=5,
            consecutive_no_novelty=3,
            saturation_threshold=10,
            stopped_at=None,
            novelty_flag=True,
        )
        assert result["consecutive_no_novelty"] == 0
        assert result["total_extracted"] == 6
        assert result["stopped_at"] is None

    def test_no_novelty_increments_counter(self):
        result = _simulate_saturation(
            total_extracted=5,
            consecutive_no_novelty=2,
            saturation_threshold=10,
            stopped_at=None,
            novelty_flag=False,
        )
        assert result["consecutive_no_novelty"] == 3
        assert result["stopped_at"] is None

    def test_saturation_fires_at_threshold(self):
        result = _simulate_saturation(
            total_extracted=15,
            consecutive_no_novelty=9,  # will become 10 == threshold
            saturation_threshold=10,
            stopped_at=None,
            novelty_flag=False,
        )
        assert result["consecutive_no_novelty"] == 10
        assert result["stopped_at"] is not None

    def test_saturation_does_not_override_existing_stopped_at(self):
        already_stopped = datetime(2026, 1, 1, tzinfo=timezone.utc)
        result = _simulate_saturation(
            total_extracted=20,
            consecutive_no_novelty=10,
            saturation_threshold=10,
            stopped_at=already_stopped,
            novelty_flag=False,
        )
        # stopped_at stays as-is (condition: stopped_at is None)
        assert result["stopped_at"] == already_stopped

    def test_total_extracted_always_increments(self):
        for novelty in (True, False):
            result = _simulate_saturation(
                total_extracted=0,
                consecutive_no_novelty=0,
                saturation_threshold=10,
                stopped_at=None,
                novelty_flag=novelty,
            )
            assert result["total_extracted"] == 1


# ---------------------------------------------------------------------------
# Seed determinism
# ---------------------------------------------------------------------------

class TestSeedDeterminism:
    def test_same_seed_same_order(self):
        record_ids = [uuid.uuid4() for _ in range(20)]
        seed = 12345
        run1 = _simulate_queue_generation(record_ids, {}, set(), seed=seed)
        run2 = _simulate_queue_generation(record_ids, {}, set(), seed=seed)
        assert run1 == run2

    def test_different_seeds_likely_different_order(self):
        record_ids = [uuid.uuid4() for _ in range(20)]
        run1 = _simulate_queue_generation(record_ids, {}, set(), seed=1)
        run2 = _simulate_queue_generation(record_ids, {}, set(), seed=2)
        # With 20 items this should differ; extremely unlikely to be equal by chance
        assert run1 != run2

    def test_shuffle_preserves_all_elements(self):
        record_ids = [uuid.uuid4() for _ in range(10)]
        keys = _simulate_queue_generation(record_ids, {}, set(), seed=99)
        assert sorted(keys) == sorted(f"rec:{r}" for r in record_ids)
