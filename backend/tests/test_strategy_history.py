"""
Pure unit tests for strategy history helpers.

All tests are DB-free — they exercise:
  - _make_config_summary()  : human-readable config string
  - _make_config_snapshot() : JSON-serialisable dict roundtrip via OverlapConfig
  - Pagination math for run history (total_pages / offset formulas)
"""
from __future__ import annotations

import math

import pytest

from app.services.overlap_service import _make_config_summary, _make_config_snapshot
from app.utils.overlap_detector import OverlapConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _total_pages(total_items: int, page_size: int) -> int:
    if total_items == 0:
        return 1
    return max(1, math.ceil(total_items / page_size))


def _offset(page: int, page_size: int) -> int:
    return (page - 1) * page_size


# ---------------------------------------------------------------------------
# _make_config_summary — identifier tiers
# ---------------------------------------------------------------------------

class TestConfigSummaryIdentifiers:
    def test_doi_only(self):
        cfg = OverlapConfig(selected_fields=["doi"])
        s = _make_config_summary(cfg)
        assert "DOI" in s
        assert "PMID" not in s

    def test_pmid_only(self):
        cfg = OverlapConfig(selected_fields=["pmid"])
        s = _make_config_summary(cfg)
        assert "PMID" in s
        assert "DOI" not in s

    def test_doi_and_pmid(self):
        cfg = OverlapConfig(selected_fields=["doi", "pmid"])
        s = _make_config_summary(cfg)
        assert "DOI" in s and "PMID" in s

    def test_no_identifiers(self):
        cfg = OverlapConfig(selected_fields=["title", "year"])
        s = _make_config_summary(cfg)
        assert "DOI" not in s
        assert "PMID" not in s


# ---------------------------------------------------------------------------
# _make_config_summary — title group
# ---------------------------------------------------------------------------

class TestConfigSummaryTitleGroup:
    def test_title_only(self):
        cfg = OverlapConfig(selected_fields=["title"])
        s = _make_config_summary(cfg)
        assert "Title" in s
        # "Year: exact" is always appended as the year-tolerance indicator,
        # but "Year" should NOT appear inside the title group token (i.e. not "Title + Year")
        assert "Title + Year" not in s

    def test_title_and_year(self):
        cfg = OverlapConfig(selected_fields=["title", "year"])
        s = _make_config_summary(cfg)
        assert "Title" in s and "Year" in s

    def test_title_year_first_author(self):
        cfg = OverlapConfig(selected_fields=["title", "year", "first_author"])
        s = _make_config_summary(cfg)
        assert "First Author" in s

    def test_all_authors(self):
        cfg = OverlapConfig(selected_fields=["title", "year", "all_authors"])
        s = _make_config_summary(cfg)
        assert "All Authors" in s

    def test_volume_pages_journal(self):
        cfg = OverlapConfig(selected_fields=["title", "year", "volume", "pages", "journal"])
        s = _make_config_summary(cfg)
        assert "Volume" in s
        assert "Pages" in s
        assert "Journal" in s

    def test_no_title_no_title_group(self):
        cfg = OverlapConfig(selected_fields=["doi", "year"])
        s = _make_config_summary(cfg)
        # year without title should not produce a title group
        assert "Title" not in s


# ---------------------------------------------------------------------------
# _make_config_summary — fuzzy and year tolerance
# ---------------------------------------------------------------------------

class TestConfigSummaryFuzzyAndYear:
    def test_fuzzy_off(self):
        cfg = OverlapConfig(selected_fields=["doi"], fuzzy_enabled=False)
        s = _make_config_summary(cfg)
        assert "Fuzzy: off" in s

    def test_fuzzy_on_with_percentage(self):
        cfg = OverlapConfig(selected_fields=["doi"], fuzzy_enabled=True, fuzzy_threshold=0.90)
        s = _make_config_summary(cfg)
        assert "Fuzzy: on (90%)" in s

    def test_fuzzy_threshold_truncates_to_int(self):
        cfg = OverlapConfig(selected_fields=["doi"], fuzzy_enabled=True, fuzzy_threshold=0.879)
        s = _make_config_summary(cfg)
        # int(0.879 * 100) = 87
        assert "Fuzzy: on (87%)" in s

    def test_year_exact(self):
        cfg = OverlapConfig(selected_fields=["doi"], year_tolerance=0)
        s = _make_config_summary(cfg)
        assert "Year: exact" in s

    def test_year_tolerance_one(self):
        cfg = OverlapConfig(selected_fields=["doi"], year_tolerance=1)
        s = _make_config_summary(cfg)
        assert "±1" in s

    def test_year_tolerance_two(self):
        cfg = OverlapConfig(selected_fields=["doi"], year_tolerance=2)
        s = _make_config_summary(cfg)
        assert "±2" in s


# ---------------------------------------------------------------------------
# _make_config_summary — separator and format
# ---------------------------------------------------------------------------

class TestConfigSummaryFormat:
    def test_parts_joined_by_middle_dot(self):
        cfg = OverlapConfig(selected_fields=["doi"])
        s = _make_config_summary(cfg)
        # Middle dot (·) used as separator
        assert "·" in s

    def test_default_config_contains_doi_pmid_title(self):
        cfg = OverlapConfig.default()
        s = _make_config_summary(cfg)
        assert "DOI" in s
        assert "PMID" in s
        assert "Title" in s

    def test_return_type_is_str(self):
        cfg = OverlapConfig.default()
        assert isinstance(_make_config_summary(cfg), str)

    def test_non_empty_for_empty_fields(self):
        # Even with no fields selected, summary must return something (fuzzy + year)
        cfg = OverlapConfig(selected_fields=[])
        s = _make_config_summary(cfg)
        assert len(s) > 0


# ---------------------------------------------------------------------------
# _make_config_snapshot — roundtrip fidelity
# ---------------------------------------------------------------------------

class TestConfigSnapshot:
    def test_snapshot_is_dict(self):
        cfg = OverlapConfig.default()
        snap = _make_config_snapshot(cfg)
        assert isinstance(snap, dict)

    def test_snapshot_keys(self):
        cfg = OverlapConfig.default()
        snap = _make_config_snapshot(cfg)
        assert set(snap.keys()) >= {"selected_fields", "fuzzy_enabled", "fuzzy_threshold", "year_tolerance"}

    def test_roundtrip_default(self):
        cfg = OverlapConfig.default()
        snap = _make_config_snapshot(cfg)
        restored = OverlapConfig.from_dict(snap)
        assert sorted(restored.selected_fields) == sorted(cfg.selected_fields)
        assert restored.fuzzy_enabled == cfg.fuzzy_enabled
        assert restored.fuzzy_threshold == cfg.fuzzy_threshold
        assert restored.year_tolerance == cfg.year_tolerance

    def test_roundtrip_fuzzy_enabled(self):
        cfg = OverlapConfig(
            selected_fields=["doi", "title"],
            fuzzy_enabled=True,
            fuzzy_threshold=0.88,
            year_tolerance=1,
        )
        snap = _make_config_snapshot(cfg)
        restored = OverlapConfig.from_dict(snap)
        assert restored.fuzzy_enabled is True
        assert abs(restored.fuzzy_threshold - 0.88) < 1e-9
        assert restored.year_tolerance == 1

    def test_roundtrip_all_fields(self):
        all_fields = OverlapConfig.KNOWN_FIELDS
        cfg = OverlapConfig(selected_fields=all_fields)
        snap = _make_config_snapshot(cfg)
        restored = OverlapConfig.from_dict(snap)
        assert sorted(restored.selected_fields) == sorted(all_fields)

    def test_snapshot_selected_fields_is_list(self):
        cfg = OverlapConfig.default()
        snap = _make_config_snapshot(cfg)
        assert isinstance(snap["selected_fields"], list)

    def test_snapshot_fuzzy_enabled_is_bool(self):
        cfg = OverlapConfig(selected_fields=["doi"], fuzzy_enabled=True)
        snap = _make_config_snapshot(cfg)
        assert snap["fuzzy_enabled"] is True

    def test_snapshot_year_tolerance_is_int(self):
        cfg = OverlapConfig(selected_fields=["doi"], year_tolerance=2)
        snap = _make_config_snapshot(cfg)
        assert isinstance(snap["year_tolerance"], int)
        assert snap["year_tolerance"] == 2


# ---------------------------------------------------------------------------
# Run history — pagination math
# ---------------------------------------------------------------------------

class TestRunHistoryPagination:
    def test_zero_items_returns_page_1(self):
        assert _total_pages(0, 10) == 1

    def test_exactly_one_page(self):
        assert _total_pages(10, 10) == 1

    def test_one_over_boundary(self):
        assert _total_pages(11, 10) == 2

    def test_large_history(self):
        assert _total_pages(107, 10) == 11

    def test_page_size_1(self):
        assert _total_pages(5, 1) == 5

    def test_first_page_offset_is_zero(self):
        assert _offset(1, 10) == 0

    def test_second_page_offset(self):
        assert _offset(2, 10) == 10

    def test_third_page_offset(self):
        assert _offset(3, 25) == 50

    def test_offset_grows_linearly(self):
        for page in range(1, 6):
            assert _offset(page, 10) == (page - 1) * 10
