"""
Unit tests for manual overlap linking logic.

All tests are pure — no DB required.
Tests cover:
- _plan_manual_link(): all seven decision branches
- compute_overlap_matrix(): NxN symmetric matrix computation
- compute_top_intersections(): intersection counting and ranking
"""
from __future__ import annotations

import uuid
from typing import Optional

import pytest

from app.services.overlap_service import (
    MembershipInfo,
    _plan_manual_link,
    compute_overlap_matrix,
    compute_top_intersections,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mi(
    rsid: Optional[uuid.UUID] = None,
    cid: Optional[uuid.UUID] = None,
    origin: Optional[str] = None,
    locked: Optional[bool] = None,
) -> MembershipInfo:
    """Build a MembershipInfo with sensible defaults."""
    return MembershipInfo(
        record_source_id=rsid or uuid.uuid4(),
        cluster_id=cid,
        cluster_origin=origin,
        cluster_locked=locked,
        cluster_scope="cross_source" if cid else None,
    )


# ---------------------------------------------------------------------------
# _plan_manual_link — NOOP
# ---------------------------------------------------------------------------

class TestPlanNoop:
    def test_noop_two_same_cluster(self):
        """Both records in the same cluster → noop."""
        cid = uuid.uuid4()
        memberships = [_mi(cid=cid, origin="auto", locked=False),
                       _mi(cid=cid, origin="auto", locked=False)]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "noop"
        assert plan["cluster_id"] == cid

    def test_noop_three_same_cluster(self):
        """Three records in the same cluster → noop."""
        cid = uuid.uuid4()
        memberships = [_mi(cid=cid, origin="manual", locked=True) for _ in range(3)]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "noop"
        assert plan["cluster_id"] == cid


# ---------------------------------------------------------------------------
# _plan_manual_link — MERGE
# ---------------------------------------------------------------------------

class TestPlanMerge:
    def test_merge_two_unlocked_clusters(self):
        """Two distinct unlocked clusters → merge."""
        cid_a = uuid.uuid4()
        cid_b = uuid.uuid4()
        memberships = [_mi(cid=cid_a, origin="auto", locked=False),
                       _mi(cid=cid_b, origin="auto", locked=False)]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "merge"
        assert plan["origin"] == "mixed"
        assert plan["locked"] is True
        # keep is lex-min
        assert str(plan["keep_cluster_id"]) == min(str(cid_a), str(cid_b))
        assert str(plan["delete_cluster_id"]) == max(str(cid_a), str(cid_b))

    def test_merge_keep_is_lex_min(self):
        """Deterministic: smaller UUID string is kept."""
        # Force specific UUID values where ordering is predictable
        cid_small = uuid.UUID("00000000-0000-0000-0000-000000000001")
        cid_large = uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff")
        memberships = [_mi(cid=cid_large, origin="auto", locked=False),
                       _mi(cid=cid_small, origin="auto", locked=False)]
        plan = _plan_manual_link(memberships, locked_param=False)
        assert plan["action"] == "merge"
        assert plan["keep_cluster_id"] == cid_small
        assert plan["delete_cluster_id"] == cid_large

    def test_merge_locked_param_false_propagates(self):
        """locked_param=False → resulting cluster is not locked."""
        cid_a, cid_b = uuid.uuid4(), uuid.uuid4()
        memberships = [_mi(cid=cid_a, origin="auto", locked=False),
                       _mi(cid=cid_b, origin="auto", locked=False)]
        plan = _plan_manual_link(memberships, locked_param=False)
        assert plan["action"] == "merge"
        assert plan["locked"] is False


# ---------------------------------------------------------------------------
# _plan_manual_link — CREATE_NEW (locked cluster present)
# ---------------------------------------------------------------------------

class TestPlanCreateNewLocked:
    def test_create_new_one_cluster_locked(self):
        """One cluster is locked → cannot merge, create new."""
        cid_a, cid_b = uuid.uuid4(), uuid.uuid4()
        memberships = [_mi(cid=cid_a, origin="auto", locked=True),
                       _mi(cid=cid_b, origin="auto", locked=False)]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "create_new"
        assert plan["origin"] == "manual"
        assert plan["locked"] is True
        assert len(plan["member_ids"]) == 2

    def test_create_new_both_clusters_locked(self):
        """Both clusters are locked → create new."""
        cid_a, cid_b = uuid.uuid4(), uuid.uuid4()
        memberships = [_mi(cid=cid_a, origin="manual", locked=True),
                       _mi(cid=cid_b, origin="manual", locked=True)]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "create_new"
        assert plan["origin"] == "manual"

    def test_create_new_three_unlocked_clusters(self):
        """3 distinct clusters (even if unlocked) → create_new, not merge."""
        cid_a, cid_b, cid_c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        memberships = [_mi(cid=cid_a, origin="auto", locked=False),
                       _mi(cid=cid_b, origin="auto", locked=False),
                       _mi(cid=cid_c, origin="auto", locked=False)]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "create_new"
        assert len(plan["member_ids"]) == 3


# ---------------------------------------------------------------------------
# _plan_manual_link — ADD_TO_EXISTING
# ---------------------------------------------------------------------------

class TestPlanAddToExisting:
    def test_add_to_existing_auto_becomes_mixed(self):
        """Existing 'auto' cluster + unclustered records → add_to_existing, origin mixed."""
        cid = uuid.uuid4()
        r_unclustered = _mi()
        memberships = [_mi(cid=cid, origin="auto", locked=False), r_unclustered]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "add_to_existing"
        assert plan["cluster_id"] == cid
        assert plan["origin"] == "mixed"
        assert r_unclustered.record_source_id in plan["new_member_ids"]

    def test_add_to_existing_manual_stays_manual(self):
        """Existing 'manual' cluster + unclustered → origin stays 'manual'."""
        cid = uuid.uuid4()
        memberships = [_mi(cid=cid, origin="manual", locked=False), _mi()]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "add_to_existing"
        assert plan["origin"] == "manual"

    def test_add_to_existing_multiple_unclustered(self):
        """1 clustered + 2 unclustered → new_member_ids has 2 items."""
        cid = uuid.uuid4()
        r1, r2 = _mi(), _mi()
        memberships = [_mi(cid=cid, origin="auto", locked=False), r1, r2]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "add_to_existing"
        assert len(plan["new_member_ids"]) == 2
        assert r1.record_source_id in plan["new_member_ids"]
        assert r2.record_source_id in plan["new_member_ids"]


# ---------------------------------------------------------------------------
# _plan_manual_link — LOCKED + UNCLUSTERED → CREATE_NEW
# ---------------------------------------------------------------------------

class TestPlanLockedPlusUnclustered:
    def test_locked_cluster_plus_unclustered_creates_new(self):
        """Locked cluster + unclustered records → create_new (do not mutate locked)."""
        cid = uuid.uuid4()
        memberships = [_mi(cid=cid, origin="auto", locked=True), _mi()]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "create_new"
        assert plan["origin"] == "manual"
        assert len(plan["member_ids"]) == 2


# ---------------------------------------------------------------------------
# _plan_manual_link — ALL UNCLUSTERED
# ---------------------------------------------------------------------------

class TestPlanAllUnclustered:
    def test_all_unclustered_creates_new(self):
        """All records unclustered → create new manual cluster."""
        memberships = [_mi(), _mi(), _mi()]
        plan = _plan_manual_link(memberships, locked_param=True)
        assert plan["action"] == "create_new"
        assert plan["origin"] == "manual"
        assert plan["locked"] is True
        assert len(plan["member_ids"]) == 3

    def test_all_unclustered_locked_param_false(self):
        """locked_param=False → resulting cluster not locked."""
        memberships = [_mi(), _mi()]
        plan = _plan_manual_link(memberships, locked_param=False)
        assert plan["action"] == "create_new"
        assert plan["locked"] is False


# ---------------------------------------------------------------------------
# compute_overlap_matrix
# ---------------------------------------------------------------------------

class TestComputeOverlapMatrix:
    def test_empty_clusters(self):
        """No clusters → all-zero NxN matrix."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [])
        assert m == [[0, 0], [0, 0]]

    def test_single_pair(self):
        """One cluster with two sources → matrix cell = 1."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [[sa, sb]])
        assert m[0][1] == 1
        assert m[1][0] == 1
        assert m[0][0] == 0
        assert m[1][1] == 0

    def test_matrix_symmetric(self):
        """Matrix is always symmetric."""
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        cluster_sets = [[sa, sb], [sb, sc], [sa, sb, sc]]
        m = compute_overlap_matrix([sa, sb, sc], cluster_sets)
        n = len(m)
        for i in range(n):
            for j in range(n):
                assert m[i][j] == m[j][i], f"Not symmetric at [{i}][{j}]"

    def test_three_sources_two_clusters(self):
        """Multiple clusters accumulate correctly."""
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        # cluster1: sa+sb; cluster2: sa+sb (another cluster, same pair)
        m = compute_overlap_matrix([sa, sb, sc], [[sa, sb], [sa, sb]])
        assert m[0][1] == 2
        assert m[1][0] == 2
        assert m[0][2] == 0  # sc not in any cluster

    def test_source_not_in_cluster_stays_zero(self):
        """Source not present in any cluster row/col = all zeros."""
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        # Only sa+sb clusters; sc is isolated
        m = compute_overlap_matrix([sa, sb, sc], [[sa, sb]])
        assert m[2][0] == 0
        assert m[2][1] == 0
        assert m[0][2] == 0
        assert m[1][2] == 0

    def test_diagonal_always_zero(self):
        """Diagonal cells are always 0 (unique_counts handled separately)."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [[sa, sb], [sa, sb, sa]])
        assert m[0][0] == 0
        assert m[1][1] == 0


# ---------------------------------------------------------------------------
# compute_top_intersections
# ---------------------------------------------------------------------------

class TestComputeTopIntersections:
    def test_empty_returns_empty(self):
        """No clusters → empty list."""
        result = compute_top_intersections({}, [])
        assert result == []

    def test_single_pair_intersection(self):
        """One cluster with two sources → one intersection entry."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "PubMed", sb: "Embase"}
        result = compute_top_intersections(id_to_name, [[sa, sb]])
        assert len(result) == 1
        assert result[0]["count"] == 1
        assert set(result[0]["source_ids"]) == {str(sa), str(sb)}

    def test_three_way_intersection(self):
        """Three-source cluster counted separately from two-source clusters."""
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B", sc: "C"}
        sets = [[sa, sb], [sa, sb], [sa, sb, sc]]
        result = compute_top_intersections(id_to_name, sets)
        counts = {frozenset(e["source_ids"]): e["count"] for e in result}
        assert counts[frozenset([str(sa), str(sb)])] == 2
        assert counts[frozenset([str(sa), str(sb), str(sc)])] == 1

    def test_top_n_limit(self):
        """Returns at most top_n groups."""
        sources = [uuid.uuid4() for _ in range(6)]
        id_to_name = {s: f"S{i}" for i, s in enumerate(sources)}
        # Create 6 distinct pairs each with different counts
        sets = []
        for i in range(6):
            for _ in range(i + 1):  # pair i appears i+1 times
                sets.append([sources[i], sources[(i + 1) % 6]])
        result = compute_top_intersections(id_to_name, sets, top_n=3)
        assert len(result) <= 3
        # Verify sorted descending
        for i in range(len(result) - 1):
            assert result[i]["count"] >= result[i + 1]["count"]

    def test_single_source_clusters_excluded(self):
        """Clusters with only one distinct source are not counted."""
        sa = uuid.uuid4()
        id_to_name = {sa: "PubMed"}
        result = compute_top_intersections(id_to_name, [[sa]])
        assert result == []

    def test_identical_source_sets_counted_together(self):
        """Two clusters with the same source pair → count=2."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B"}
        result = compute_top_intersections(id_to_name, [[sa, sb], [sa, sb]])
        assert result[0]["count"] == 2

    def test_results_sorted_descending(self):
        """Intersections are sorted by count, highest first."""
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B", sc: "C"}
        # sa+sb appears 3 times, sa+sc appears 1 time
        sets = [[sa, sb]] * 3 + [[sa, sc]]
        result = compute_top_intersections(id_to_name, sets)
        assert result[0]["count"] == 3
        assert result[1]["count"] == 1
