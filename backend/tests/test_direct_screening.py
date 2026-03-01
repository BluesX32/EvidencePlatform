"""
Pure unit tests for direct project-level screening logic.

All tests are DB-free — they exercise simulated versions of the service helpers.

Covers:
  1. canonical_key_standalone  — standalone record → record_id set, cluster_id None
  2. canonical_key_clustered   — clustered record → cluster_id set, record_id None
  3. next_screen_excludes_decided — decided slots excluded from available pool
  4. next_extract_requires_ft_include — extract mode: only FT-included items available
  5. dual_reviewer_isolation   — reviewer A's decisions don't block reviewer B's queue
  6. done_when_all_decided     — empty available pool → done: True
  7. multi_source_dedup        — two records in same cluster → one screening slot
  8. claim_blocks_concurrent   — claimed item excluded from second reviewer's query
  9. mixed_mode                — TA+FT in one session; priority ordering; auto-TA-include
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Set

import pytest

from app.services.direct_screening_service import _resolve_canonical_key


# ---------------------------------------------------------------------------
# Pure simulation helpers (mirror service SQL logic without a DB)
# ---------------------------------------------------------------------------

def _make_slot(record_id=None, cluster_id=None) -> dict:
    """Create a screening slot dict (mirrors available_standalone/available_clusters rows)."""
    assert (record_id is None) != (cluster_id is None), "Exactly one must be set"
    return {"record_id": record_id, "cluster_id": cluster_id}


def _make_decision(slot: dict, stage: str, decision: str, reviewer_id=None) -> dict:
    return {
        "record_id": slot["record_id"],
        "cluster_id": slot["cluster_id"],
        "stage": stage,
        "decision": decision,
        "reviewer_id": reviewer_id,
    }


def _make_claim(slot: dict, age_minutes: int = 0) -> dict:
    claimed_at = datetime.now(tz=timezone.utc) - timedelta(minutes=age_minutes)
    return {
        "record_id": slot["record_id"],
        "cluster_id": slot["cluster_id"],
        "claimed_at": claimed_at,
    }


def _is_active_claim(claim: dict) -> bool:
    """Claims older than 30 minutes are stale."""
    return (datetime.now(tz=timezone.utc) - claim["claimed_at"]).total_seconds() < 1800


def _slot_decisions(
    slot: dict,
    decisions: List[dict],
    stage_filter: str,
    reviewer_id=None,
    decision_filter: Optional[str] = None,
) -> List[dict]:
    """Return decisions matching slot + stage (+ optional reviewer + decision)."""
    return [
        d for d in decisions
        if d["record_id"] == slot["record_id"]
        and d["cluster_id"] == slot["cluster_id"]
        and d["stage"] == stage_filter
        and (reviewer_id is None or d["reviewer_id"] == reviewer_id)
        and (decision_filter is None or d["decision"] == decision_filter)
    ]


def _simulate_next_item(
    slots: List[dict],
    decisions: List[dict],
    claims: List[dict],
    mode: str,
    reviewer_id=None,
) -> Optional[dict]:
    """
    Pure equivalent of get_next_item's CTE logic.

    Supports modes: screen, fulltext, extract, mixed.
    For mixed: returns slots ordered by priority (unscreened=0 before TA-included=1).
    Returns the first available slot (by list order = created_at order) or None.
    """
    active_claims = {
        (c["record_id"], c["cluster_id"])
        for c in claims
        if _is_active_claim(c)
    }

    if mode == "mixed":
        # Build candidate list with priority
        candidates = []
        for slot in slots:
            key = (slot["record_id"], slot["cluster_id"])
            if key in active_claims:
                continue
            ta_excl = _slot_decisions(slot, decisions, "TA", reviewer_id, "exclude")
            ft_any  = _slot_decisions(slot, decisions, "FT", reviewer_id)
            if ta_excl or ft_any:
                continue  # excluded or FT done
            ta_incl = _slot_decisions(slot, decisions, "TA", reviewer_id, "include")
            priority = 1 if ta_incl else 0
            candidates.append((priority, slot))
        # Sort by priority (0 = unscreened first, 1 = TA-included second)
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1] if candidates else None

    for slot in slots:
        key = (slot["record_id"], slot["cluster_id"])
        if key in active_claims:
            continue

        if mode == "screen":
            if not _slot_decisions(slot, decisions, "TA", reviewer_id):
                return slot
        elif mode == "fulltext":
            if (_slot_decisions(slot, decisions, "TA", reviewer_id, "include")
                    and not _slot_decisions(slot, decisions, "FT", reviewer_id)):
                return slot
        elif mode == "extract":
            if _slot_decisions(slot, decisions, "FT", reviewer_id, "include"):
                return slot

    return None


def _simulate_auto_ta_include(
    slot: dict,
    decisions: List[dict],
    reviewer_id,
) -> List[dict]:
    """
    Simulate auto-TA-include: if no TA decision exists for this reviewer+slot,
    insert a TA=include decision. Returns updated decisions list.
    """
    existing = _slot_decisions(slot, decisions, "TA", reviewer_id)
    if not existing:
        decisions = decisions + [_make_decision(slot, "TA", "include", reviewer_id)]
    return decisions


def _simulate_get_sources_slots(
    record_ids: List[uuid.UUID],
    cluster_map: Dict[uuid.UUID, uuid.UUID],
) -> List[dict]:
    """Build unique screening slots from a list of records + cluster map."""
    seen: Set[tuple] = set()
    slots: List[dict] = []
    for rid in record_ids:
        cid = cluster_map.get(rid)
        if cid is not None:
            key = (None, cid)
        else:
            key = (rid, None)
        if key not in seen:
            seen.add(key)
            slots.append({"record_id": key[0], "cluster_id": key[1]})
    return slots


# ---------------------------------------------------------------------------
# 1. Canonical key helpers
# ---------------------------------------------------------------------------

class TestCanonicalKey:
    def test_canonical_key_standalone(self):
        """Standalone record → record_id set, cluster_id None."""
        rid = uuid.uuid4()
        key = _resolve_canonical_key(rid, {})
        assert key == f"rec:{rid}"
        # Equivalent slot representation
        slot = _make_slot(record_id=rid)
        assert slot["record_id"] == rid
        assert slot["cluster_id"] is None

    def test_canonical_key_clustered(self):
        """Clustered record → cluster_id set, record_id None."""
        rid = uuid.uuid4()
        cid = uuid.uuid4()
        key = _resolve_canonical_key(rid, {rid: cid})
        assert key == f"pg:{cid}"
        # Equivalent slot representation
        slot = _make_slot(cluster_id=cid)
        assert slot["cluster_id"] == cid
        assert slot["record_id"] is None

    def test_different_records_same_cluster_same_slot(self):
        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        cid = uuid.uuid4()
        cluster_map = {rid1: cid, rid2: cid}
        key1 = _resolve_canonical_key(rid1, cluster_map)
        key2 = _resolve_canonical_key(rid2, cluster_map)
        assert key1 == key2 == f"pg:{cid}"


# ---------------------------------------------------------------------------
# 2. Screen mode excludes decided slots
# ---------------------------------------------------------------------------

class TestNextScreenExcludesDecided:
    def test_next_screen_excludes_decided(self):
        """TA-decided slots are excluded from screen mode."""
        slot_a = _make_slot(record_id=uuid.uuid4())
        slot_b = _make_slot(record_id=uuid.uuid4())
        # Reviewer decides slot_a
        reviewer = uuid.uuid4()
        decisions = [_make_decision(slot_a, "TA", "include", reviewer)]

        result = _simulate_next_item([slot_a, slot_b], decisions, [], "screen", reviewer)
        assert result is not None
        assert result["record_id"] == slot_b["record_id"]

    def test_done_when_all_ta_decided(self):
        """All slots decided → None."""
        reviewer = uuid.uuid4()
        slots = [_make_slot(record_id=uuid.uuid4()) for _ in range(3)]
        decisions = [_make_decision(s, "TA", "include", reviewer) for s in slots]
        result = _simulate_next_item(slots, decisions, [], "screen", reviewer)
        assert result is None


# ---------------------------------------------------------------------------
# 3. Extract mode requires FT include
# ---------------------------------------------------------------------------

class TestExtractRequiresFTInclude:
    def test_next_extract_requires_ft_include(self):
        """Extract mode only returns FT-included slots."""
        reviewer = uuid.uuid4()
        slot_ta_only = _make_slot(record_id=uuid.uuid4())
        slot_ft_included = _make_slot(record_id=uuid.uuid4())
        slot_ft_excluded = _make_slot(record_id=uuid.uuid4())

        decisions = [
            _make_decision(slot_ta_only, "TA", "include", reviewer),
            _make_decision(slot_ft_included, "TA", "include", reviewer),
            _make_decision(slot_ft_included, "FT", "include", reviewer),
            _make_decision(slot_ft_excluded, "TA", "include", reviewer),
            _make_decision(slot_ft_excluded, "FT", "exclude", reviewer),
        ]

        # slots in list order: ta_only first, then ft_included, then ft_excluded
        slots = [slot_ta_only, slot_ft_included, slot_ft_excluded]
        result = _simulate_next_item(slots, decisions, [], "extract", reviewer)
        assert result is not None
        assert result["record_id"] == slot_ft_included["record_id"]

    def test_extract_skips_ft_excluded(self):
        """FT-excluded slots are not available in extract mode."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions = [
            _make_decision(slot, "TA", "include", reviewer),
            _make_decision(slot, "FT", "exclude", reviewer),
        ]
        result = _simulate_next_item([slot], decisions, [], "extract", reviewer)
        assert result is None


# ---------------------------------------------------------------------------
# 4. Dual-reviewer isolation
# ---------------------------------------------------------------------------

class TestDualReviewerIsolation:
    def test_reviewer_a_decisions_do_not_block_reviewer_b(self):
        """Reviewer A's TA include doesn't remove the slot for reviewer B's screen queue."""
        reviewer_a = uuid.uuid4()
        reviewer_b = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())

        # Reviewer A has decided
        decisions = [_make_decision(slot, "TA", "include", reviewer_a)]

        # Reviewer B should still see the slot
        result = _simulate_next_item([slot], decisions, [], "screen", reviewer_b)
        assert result is not None
        assert result["record_id"] == slot["record_id"]

    def test_reviewer_own_decision_blocks_themselves(self):
        """A reviewer's own TA decision removes the slot from their own screen queue."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions = [_make_decision(slot, "TA", "include", reviewer)]

        result = _simulate_next_item([slot], decisions, [], "screen", reviewer)
        assert result is None


# ---------------------------------------------------------------------------
# 5. Done when all decided
# ---------------------------------------------------------------------------

class TestDoneWhenAllDecided:
    def test_done_when_all_decided(self):
        """Empty available pool returns None (→ done: True)."""
        reviewer = uuid.uuid4()
        slots = [_make_slot(record_id=uuid.uuid4()) for _ in range(5)]
        decisions = [_make_decision(s, "TA", "exclude", reviewer) for s in slots]
        assert _simulate_next_item(slots, decisions, [], "screen", reviewer) is None

    def test_not_done_with_one_undecided(self):
        """One undecided slot → not done."""
        reviewer = uuid.uuid4()
        slots = [_make_slot(record_id=uuid.uuid4()) for _ in range(3)]
        decisions = [_make_decision(slots[0], "TA", "exclude", reviewer),
                     _make_decision(slots[1], "TA", "include", reviewer)]
        result = _simulate_next_item(slots, decisions, [], "screen", reviewer)
        assert result is not None
        assert result["record_id"] == slots[2]["record_id"]


# ---------------------------------------------------------------------------
# 6. Multi-source deduplication: two records → one slot
# ---------------------------------------------------------------------------

class TestMultiSourceDedup:
    def test_two_records_same_cluster_one_slot(self):
        """Two records in the same cross-source cluster produce exactly one screening slot."""
        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        cid = uuid.uuid4()
        cluster_map = {rid1: cid, rid2: cid}

        slots = _simulate_get_sources_slots([rid1, rid2], cluster_map)
        assert len(slots) == 1
        assert slots[0]["cluster_id"] == cid
        assert slots[0]["record_id"] is None

    def test_standalone_records_each_get_own_slot(self):
        """Records not in any cluster each get their own screening slot."""
        record_ids = [uuid.uuid4() for _ in range(4)]
        slots = _simulate_get_sources_slots(record_ids, {})
        assert len(slots) == 4


# ---------------------------------------------------------------------------
# 7. Claim blocks concurrent reviewer
# ---------------------------------------------------------------------------

class TestClaimBlocksConcurrent:
    def test_active_claim_blocks_reviewer(self):
        """An active (fresh) claim prevents another reviewer from getting the same item."""
        slot = _make_slot(record_id=uuid.uuid4())
        claim = _make_claim(slot, age_minutes=0)  # just claimed

        result = _simulate_next_item([slot], [], [claim], "screen")
        assert result is None

    def test_stale_claim_does_not_block(self):
        """A stale claim (>30 min) is ignored."""
        slot = _make_slot(record_id=uuid.uuid4())
        claim = _make_claim(slot, age_minutes=31)  # older than 30 min

        result = _simulate_next_item([slot], [], [claim], "screen")
        assert result is not None
        assert result["record_id"] == slot["record_id"]

    def test_claim_does_not_block_if_other_slot_available(self):
        """A claimed slot doesn't prevent getting the next unclaimed slot."""
        slot_a = _make_slot(record_id=uuid.uuid4())
        slot_b = _make_slot(record_id=uuid.uuid4())
        claim = _make_claim(slot_a, age_minutes=0)

        result = _simulate_next_item([slot_a, slot_b], [], [claim], "screen")
        assert result is not None
        assert result["record_id"] == slot_b["record_id"]


# ---------------------------------------------------------------------------
# 8. Mixed mode: TA + FT in same session
# ---------------------------------------------------------------------------

class TestMixedMode:
    def test_mixed_shows_unscreened_before_ta_included(self):
        """Unscreened item has lower priority than TA-included-no-FT in mixed queue."""
        reviewer = uuid.uuid4()
        slot_unscreened = _make_slot(record_id=uuid.uuid4())
        slot_ta_included = _make_slot(record_id=uuid.uuid4())

        decisions = [_make_decision(slot_ta_included, "TA", "include", reviewer)]

        # List TA-included first, but unscreened should come first (priority 0 < 1)
        result = _simulate_next_item(
            [slot_ta_included, slot_unscreened], decisions, [], "mixed", reviewer
        )
        assert result is not None
        assert result["record_id"] == slot_unscreened["record_id"]

    def test_mixed_excludes_ta_excluded(self):
        """TA-excluded items do not appear in mixed queue."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions = [_make_decision(slot, "TA", "exclude", reviewer)]

        result = _simulate_next_item([slot], decisions, [], "mixed", reviewer)
        assert result is None

    def test_mixed_excludes_ft_decided(self):
        """Items with any FT decision are removed from mixed queue."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions = [
            _make_decision(slot, "TA", "include", reviewer),
            _make_decision(slot, "FT", "include", reviewer),
        ]

        result = _simulate_next_item([slot], decisions, [], "mixed", reviewer)
        assert result is None

    def test_mixed_shows_ta_included_no_ft(self):
        """TA-included items with no FT decision appear in mixed queue (priority 1)."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions = [_make_decision(slot, "TA", "include", reviewer)]

        result = _simulate_next_item([slot], decisions, [], "mixed", reviewer)
        assert result is not None
        assert result["record_id"] == slot["record_id"]

    def test_auto_ta_include_inserts_when_no_ta_exists(self):
        """_simulate_auto_ta_include adds TA=include when none exists for reviewer."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions: list = []

        decisions = _simulate_auto_ta_include(slot, decisions, reviewer)

        ta_decisions = _slot_decisions(slot, decisions, "TA", reviewer, "include")
        assert len(ta_decisions) == 1

    def test_auto_ta_include_skips_when_ta_already_exists(self):
        """_simulate_auto_ta_include does not duplicate if TA decision already present."""
        reviewer = uuid.uuid4()
        slot = _make_slot(record_id=uuid.uuid4())
        decisions = [_make_decision(slot, "TA", "include", reviewer)]

        decisions = _simulate_auto_ta_include(slot, decisions, reviewer)

        ta_decisions = _slot_decisions(slot, decisions, "TA", reviewer)
        assert len(ta_decisions) == 1  # still only one
