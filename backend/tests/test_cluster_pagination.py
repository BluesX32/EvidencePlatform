"""
Pure unit tests for cluster pagination math and matrix count sanity.

All tests are DB-free — they exercise helper logic directly.
"""
from __future__ import annotations

import math
import uuid

import pytest

from app.services.overlap_service import compute_overlap_matrix


# ---------------------------------------------------------------------------
# Pagination math helpers (mirrors what the /clusters endpoint does inline)
# ---------------------------------------------------------------------------

def _total_pages(total_items: int, page_size: int) -> int:
    """Replicate the total_pages formula used in list_overlap_clusters."""
    if total_items == 0:
        return 1
    return max(1, math.ceil(total_items / page_size))


def _offset(page: int, page_size: int) -> int:
    """Replicate offset = (page - 1) * page_size."""
    return (page - 1) * page_size


# ---------------------------------------------------------------------------
# total_pages edge cases
# ---------------------------------------------------------------------------

class TestTotalPages:
    def test_zero_items_returns_1(self):
        assert _total_pages(0, 50) == 1

    def test_exactly_one_page(self):
        assert _total_pages(50, 50) == 1

    def test_one_over_page_boundary(self):
        assert _total_pages(51, 50) == 2

    def test_two_full_pages(self):
        assert _total_pages(100, 50) == 2

    def test_two_full_pages_plus_one(self):
        assert _total_pages(101, 50) == 3

    def test_page_size_25(self):
        assert _total_pages(100, 25) == 4
        assert _total_pages(101, 25) == 5

    def test_page_size_100(self):
        assert _total_pages(100, 100) == 1
        assert _total_pages(101, 100) == 2

    def test_single_item(self):
        assert _total_pages(1, 50) == 1

    def test_large_dataset(self):
        assert _total_pages(1000, 50) == 20
        assert _total_pages(1001, 50) == 21


# ---------------------------------------------------------------------------
# Offset / page boundary
# ---------------------------------------------------------------------------

class TestOffsetCalculation:
    def test_page1_offset_0(self):
        assert _offset(1, 50) == 0

    def test_page2_offset_50(self):
        assert _offset(2, 50) == 50

    def test_page3_offset_100(self):
        assert _offset(3, 50) == 100

    def test_page_size_25_page3(self):
        assert _offset(3, 25) == 50

    def test_page_size_100_page2(self):
        assert _offset(2, 100) == 100


# ---------------------------------------------------------------------------
# Matrix pair-sum sanity (cross-checks compute_overlap_matrix correctness)
# ---------------------------------------------------------------------------

class TestMatrixPairSumSanity:
    """
    For a cluster containing N distinct sources, the number of unique
    pairs it contributes to the matrix is N*(N-1)/2.  The total
    off-diagonal sum of the symmetric matrix should equal
    2 * sum_of_pair_contributions.
    """

    def _off_diagonal_sum(self, m: list) -> int:
        n = len(m)
        return sum(m[i][j] for i in range(n) for j in range(n) if i != j)

    def test_two_source_cluster_contributes_one_pair(self):
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [[sa, sb]])
        assert self._off_diagonal_sum(m) == 2  # 1 pair × 2 (symmetry)

    def test_three_source_cluster_contributes_three_pairs(self):
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb, sc], [[sa, sb, sc]])
        # 3 pairs × 2 = 6
        assert self._off_diagonal_sum(m) == 6

    def test_four_source_cluster_contributes_six_pairs(self):
        sources = [uuid.uuid4() for _ in range(4)]
        m = compute_overlap_matrix(sources, [sources])
        # 4*(4-1)/2 = 6 pairs × 2 = 12
        assert self._off_diagonal_sum(m) == 12

    def test_two_clusters_same_pair_accumulate(self):
        sa, sb = uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb], [[sa, sb], [sa, sb]])
        assert self._off_diagonal_sum(m) == 4  # 2 clusters × 2

    def test_diagonal_never_included(self):
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb, sc], [[sa, sb, sc]])
        for i in range(3):
            assert m[i][i] == 0

    def test_matrix_symmetry(self):
        sa, sb, sc = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        m = compute_overlap_matrix([sa, sb, sc], [[sa, sb], [sb, sc]])
        n = len(m)
        for i in range(n):
            for j in range(n):
                assert m[i][j] == m[j][i], f"Symmetry violated at [{i}][{j}]"
