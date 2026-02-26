"""
Unit tests for app.utils.overlap_utils.

Tests cover all five normalization functions:
  normalize_title_for_overlap
  extract_year
  normalize_volume
  parse_authors
  first_author_last
"""
from __future__ import annotations

import pytest

from app.utils.overlap_utils import (
    normalize_title_for_overlap,
    extract_year,
    normalize_volume,
    parse_authors,
    first_author_last,
)


# ---------------------------------------------------------------------------
# normalize_title_for_overlap
# ---------------------------------------------------------------------------

class TestNormalizeTitle:
    def test_basic_lowercase(self):
        assert normalize_title_for_overlap("Effect of Mindfulness") == "effect of mindfulness"

    def test_nfkd_normalization(self):
        # fi ligature → f i
        result = normalize_title_for_overlap("\ufb01ndings")
        assert result == "findings"

    def test_removes_bracketed_annotation(self):
        result = normalize_title_for_overlap("Effect of mindfulness [Review].")
        assert result == "effect of mindfulness"

    def test_removes_multiple_brackets(self):
        result = normalize_title_for_overlap("Title [erratum] corrected [see also]")
        assert "erratum" not in result
        assert "see also" not in result

    def test_removes_punctuation(self):
        result = normalize_title_for_overlap("Mindfulness: a meta-analysis")
        assert ":" not in result
        assert "-" not in result

    def test_collapses_whitespace(self):
        result = normalize_title_for_overlap("effect   of   yoga")
        assert result == "effect of yoga"

    def test_strips_trailing_period(self):
        assert normalize_title_for_overlap("A study of pain.") == "a study of pain"

    def test_empty_string_returns_empty(self):
        assert normalize_title_for_overlap("") == ""

    def test_none_returns_empty(self):
        assert normalize_title_for_overlap(None) == ""

    def test_only_whitespace_returns_empty(self):
        assert normalize_title_for_overlap("   ") == ""

    def test_unicode_accents(self):
        # é NFKD → e + combining accent → after punct removal stays as letters
        result = normalize_title_for_overlap("étude de la douleur")
        assert "tude" in result  # accents stripped but base letter kept


# ---------------------------------------------------------------------------
# extract_year
# ---------------------------------------------------------------------------

class TestExtractYear:
    def test_four_digit_year(self):
        assert extract_year("2023") == 2023

    def test_year_in_date_string(self):
        assert extract_year("2023 Jan") == 2023

    def test_year_in_sentence(self):
        assert extract_year("Published in 2021.") == 2021

    def test_handles_int_input(self):
        assert extract_year(2022) == 2022

    def test_returns_none_for_none(self):
        assert extract_year(None) is None

    def test_returns_none_for_garbage(self):
        assert extract_year("no year here") is None

    def test_boundary_1800(self):
        assert extract_year("1800") == 1800

    def test_boundary_2099(self):
        assert extract_year("2099") == 2099

    def test_out_of_range_1799_not_matched(self):
        assert extract_year("1799") is None

    def test_out_of_range_2100_not_matched(self):
        assert extract_year("2100") is None

    def test_first_year_returned(self):
        # First valid year wins
        assert extract_year("2020 and 2021") == 2020


# ---------------------------------------------------------------------------
# normalize_volume
# ---------------------------------------------------------------------------

class TestNormalizeVolume:
    def test_plain_number(self):
        assert normalize_volume("23") == "23"

    def test_strips_vol_prefix(self):
        assert normalize_volume("vol. 23") == "23"

    def test_strips_vol_no_dot(self):
        assert normalize_volume("vol23") == "23"

    def test_strips_volume_prefix(self):
        assert normalize_volume("Volume 12") == "12"

    def test_lowercase(self):
        assert normalize_volume("Vol. 5") == "5"

    def test_none_returns_none(self):
        assert normalize_volume(None) is None

    def test_empty_returns_none(self):
        assert normalize_volume("") is None

    def test_whitespace_only_returns_none(self):
        assert normalize_volume("   ") is None


# ---------------------------------------------------------------------------
# parse_authors
# ---------------------------------------------------------------------------

class TestParseAuthors:
    def test_list_of_last_first(self):
        result = parse_authors(["Smith, John", "Jones, Alice"])
        assert result == ["smith", "jones"]

    def test_list_of_first_last(self):
        result = parse_authors(["John Smith", "Alice Jones"])
        assert result == ["smith", "jones"]

    def test_semicolon_delimited_string(self):
        result = parse_authors("Smith, J; Jones, A")
        assert result == ["smith", "jones"]

    def test_comma_delimited_string_single(self):
        # "Last, First" format — comma splits last from first
        result = parse_authors("Smith, J")
        assert result == ["smith"]

    def test_empty_list_returns_empty(self):
        assert parse_authors([]) == []

    def test_none_returns_empty(self):
        assert parse_authors(None) == []

    def test_empty_string_returns_empty(self):
        assert parse_authors("") == []

    def test_strips_non_alpha(self):
        # Numeric suffixes, dots, etc. stripped
        result = parse_authors(["Smith2, J."])
        assert result == ["smith"]

    def test_preserves_order(self):
        result = parse_authors(["Williams, S", "Chen, L", "Patel, R"])
        assert result == ["williams", "chen", "patel"]


# ---------------------------------------------------------------------------
# first_author_last
# ---------------------------------------------------------------------------

class TestFirstAuthorLast:
    def test_returns_first_last_name(self):
        assert first_author_last(["Smith, J", "Jones, A"]) == "smith"

    def test_returns_none_for_empty(self):
        assert first_author_last([]) is None

    def test_returns_none_for_none(self):
        assert first_author_last(None) is None

    def test_single_author(self):
        assert first_author_last(["Williams, S"]) == "williams"

    def test_string_input(self):
        assert first_author_last("Doe, J; Smith, K") == "doe"
