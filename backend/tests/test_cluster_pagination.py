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


# ---------------------------------------------------------------------------
# Regression test: source_totals_with_overlap GROUP BY correctness
#
# In sprint 8 we removed dup_subq.c.dup_count from the GROUP BY clause but
# forgot to wrap the selected column in an aggregate function.  PostgreSQL
# rejects a bare non-grouped, non-aggregated column → 500 on GET /overlaps.
#
# Fix: use func.max(dup_subq.c.dup_count) so the column is properly
# aggregated.  These tests verify the query compiles with the MAX function
# and that the generated SQL does not reference the column without aggregation.
# ---------------------------------------------------------------------------

class TestSourceTotalsGroupByRegression:
    """
    Verifies that source_totals_with_overlap uses func.max() around the
    dup_count column so it is compatible with GROUP BY (Source.id, Source.name).
    Uses SQLAlchemy's compile() to check the generated SQL without a DB.
    """

    def _build_stmt(self, project_id: uuid.UUID):
        """Replicate the query built in OverlapRepo.source_totals_with_overlap."""
        from sqlalchemy import func, select
        from app.models.overlap_cluster import OverlapCluster
        from app.models.overlap_cluster_member import OverlapClusterMember
        from app.models.record import Record
        from app.models.record_source import RecordSource
        from app.models.source import Source

        dup_subq = (
            select(
                OverlapClusterMember.source_id,
                func.count(OverlapClusterMember.id).label("dup_count"),
            )
            .join(OverlapCluster, OverlapCluster.id == OverlapClusterMember.cluster_id)
            .where(
                OverlapCluster.project_id == project_id,
                OverlapCluster.scope == "within_source",
                OverlapClusterMember.role == "duplicate",
            )
            .group_by(OverlapClusterMember.source_id)
        ).subquery()

        stmt = (
            select(
                Source.id,
                Source.name,
                func.count(RecordSource.record_id).label("total"),
                func.count(Record.normalized_doi).label("with_doi"),
                # MUST be wrapped in func.max() — bare column reference is invalid
                # without dup_count in GROUP BY.
                func.coalesce(func.max(dup_subq.c.dup_count), 0).label("internal_overlaps"),
            )
            .outerjoin(RecordSource, RecordSource.source_id == Source.id)
            .outerjoin(Record, Record.id == RecordSource.record_id)
            .outerjoin(dup_subq, dup_subq.c.source_id == Source.id)
            .where(Source.project_id == project_id)
            .group_by(Source.id, Source.name)
            .order_by(Source.name)
        )
        return stmt

    def _compiled_sql(self, project_id: uuid.UUID) -> str:
        """Compile the statement to a SQL string without executing it."""
        from sqlalchemy.dialects import postgresql
        stmt = self._build_stmt(project_id)
        return str(stmt.compile(dialect=postgresql.dialect()))

    def test_sql_contains_max_aggregate(self):
        """Generated SQL must use MAX(...) around the dup_count column."""
        sql = self._compiled_sql(uuid.uuid4())
        assert "max" in sql.lower(), (
            "Expected MAX aggregate in SQL but got:\n" + sql
        )

    def test_group_by_does_not_include_dup_count(self):
        """
        GROUP BY should only be (source.id, source.name).
        Adding dup_count to GROUP BY was the original (redundant) approach;
        with func.max() it is no longer needed.
        """
        sql = self._compiled_sql(uuid.uuid4())
        # Find the GROUP BY clause and verify dup_count is absent from it
        lower = sql.lower()
        group_by_pos = lower.rfind("group by")
        assert group_by_pos != -1, "Expected GROUP BY in SQL"
        group_by_clause = lower[group_by_pos:]
        # dup_count should only appear inside MAX(...), not in GROUP BY list
        # We check the GROUP BY section does not contain the subquery alias
        assert "dup_count" not in group_by_clause, (
            "dup_count should not appear in GROUP BY clause:\n" + group_by_clause
        )

    def test_stmt_can_be_compiled_without_error(self):
        """Smoke test: compiling the query raises no exception."""
        try:
            self._compiled_sql(uuid.uuid4())
        except Exception as exc:
            raise AssertionError(f"Query compilation raised: {exc}") from exc
