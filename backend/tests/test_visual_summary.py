"""
Unit tests for visual overlap summary helpers.

All tests are pure — no DB required.
Tests cover:
- compute_overlap_matrix(): additional edge cases
- compute_top_intersections(): additional edge cases
"""
from __future__ import annotations

import uuid

import pytest

from app.services.overlap_service import (
    compute_overlap_matrix,
    compute_top_intersections,
)


# ---------------------------------------------------------------------------
# compute_overlap_matrix — additional edge cases
# ---------------------------------------------------------------------------

class TestMatrixEdgeCases:
    def test_empty_sources(self):
        """No sources → empty matrix."""
        m = compute_overlap_matrix([], [[]])
        assert m == []

    def test_single_source_no_clusters(self):
        """One source, no cross-source clusters → [[0]]."""
        sa = uuid.uuid4()
        m = compute_overlap_matrix([sa], [])
        assert m == [[0]]

    def test_source_ids_not_in_list_skipped(self):
        """source_ids in cluster that are not in source_uuids list are ignored."""
        sa, sb, sc_unknown = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        # sc_unknown is NOT in the source_uuids list
        m = compute_overlap_matrix([sa, sb], [[sa, sb, sc_unknown]])
        assert m[0][1] == 1
        assert m[1][0] == 1

    def test_cluster_with_single_source_only_skipped(self):
        """Cluster with only one unique source does not increment matrix."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        # Cluster has sa twice (deduped to one unique source)
        m = compute_overlap_matrix([sa, sb], [[sa, sa]])
        assert m[0][1] == 0
        assert m[1][0] == 0

    def test_three_source_cluster_increments_all_pairs(self):
        """A cluster with 3 sources increments all 3 pairs."""
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb, sc], [[sa, sb, sc]])
        n = 3
        for i in range(n):
            for j in range(n):
                if i != j:
                    assert m[i][j] == 1, f"Expected 1 at [{i}][{j}]"
                else:
                    assert m[i][j] == 0

    def test_accumulates_multiple_clusters(self):
        """Multiple clusters with same source pair accumulate to correct count."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [[sa, sb]] * 5)
        assert m[0][1] == 5
        assert m[1][0] == 5

    def test_diagonal_zero_even_with_same_source_repeated(self):
        """Diagonal is always 0 regardless of inputs."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [[sa, sb], [sa, sb]])
        assert m[0][0] == 0
        assert m[1][1] == 0


# ---------------------------------------------------------------------------
# compute_top_intersections — additional edge cases
# ---------------------------------------------------------------------------

class TestIntersectionEdgeCases:
    def test_top_n_zero_returns_empty(self):
        """top_n=0 → empty result."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B"}
        result = compute_top_intersections(id_to_name, [[sa, sb]], top_n=0)
        assert result == []

    def test_source_names_populated(self):
        """source_names list matches source_ids using id_to_name dict."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "PubMed", sb: "Scopus"}
        result = compute_top_intersections(id_to_name, [[sa, sb]])
        assert len(result) == 1
        names_set = set(result[0]["source_names"])
        assert names_set == {"PubMed", "Scopus"}

    def test_unknown_source_id_falls_back_to_str(self):
        """source_ids not in id_to_name dict → str(uuid) used as name."""
        sa, sb_unknown = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "PubMed"}  # sb_unknown not present
        result = compute_top_intersections(id_to_name, [[sa, sb_unknown]])
        assert str(sb_unknown) in result[0]["source_names"]

    def test_sorted_descending_multiple_groups(self):
        """Multiple groups sorted by count descending."""
        sa, sb, sc, sd = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B", sc: "C", sd: "D"}
        sets = [[sa, sb]] * 10 + [[sc, sd]] * 3 + [[sa, sc]] * 7
        result = compute_top_intersections(id_to_name, sets)
        counts = [r["count"] for r in result]
        assert counts == sorted(counts, reverse=True)
        assert counts[0] == 10

    def test_empty_cluster_list(self):
        """Empty cluster_source_sets → empty list regardless of id_to_name."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B"}
        result = compute_top_intersections(id_to_name, [])
        assert result == []

    def test_source_ids_in_result_are_strings(self):
        """source_ids in each result entry are strings."""
        sa, sb = uuid.uuid4(), uuid.uuid4()
        id_to_name = {sa: "A", sb: "B"}
        result = compute_top_intersections(id_to_name, [[sa, sb]])
        for sid in result[0]["source_ids"]:
            assert isinstance(sid, str)

    def test_all_single_source_clusters_no_result(self):
        """All clusters have only 1 distinct source → no intersections."""
        sa = uuid.uuid4()
        result = compute_top_intersections({sa: "A"}, [[sa], [sa], [sa]])
        assert result == []
