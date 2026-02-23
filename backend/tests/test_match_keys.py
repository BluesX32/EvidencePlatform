"""Unit tests for match key normalization and computation.

No database required — all functions are pure.
"""
import pytest

from app.utils.match_keys import (
    compute_match_key,
    normalize_first_author,
    normalize_title,
)


# ── normalize_title ───────────────────────────────────────────────────────────

def test_normalize_title_basic():
    result = normalize_title("Effectiveness of mindfulness-based stress reduction")
    assert result is not None
    assert "effectiveness" in result
    assert "mindfulness" in result
    # Stop words removed
    assert " of " not in f" {result} "


def test_normalize_title_removes_stop_words():
    result = normalize_title("The role of the brain in memory")
    assert result is not None
    words = result.split()
    assert "the" not in words
    assert "of" not in words
    assert "in" not in words
    assert "role" in words
    assert "brain" in words


def test_normalize_title_lowercase():
    result = normalize_title("UPPERCASE TITLE WITH CAPS")
    assert result == result.lower()


def test_normalize_title_strips_punctuation():
    result = normalize_title("Title: with, punctuation! and (brackets)")
    assert ":" not in (result or "")
    assert "," not in (result or "")
    assert "!" not in (result or "")


def test_normalize_title_returns_none_for_empty():
    assert normalize_title(None) is None
    assert normalize_title("") is None
    assert normalize_title("   ") is None


def test_normalize_title_returns_none_for_only_stop_words():
    # All stop words → empty result → None
    assert normalize_title("the and or") is None


def test_normalize_title_truncates_to_200_chars():
    long_title = "word " * 50  # 250 chars
    result = normalize_title(long_title)
    assert result is not None
    assert len(result) <= 200


# ── normalize_first_author ────────────────────────────────────────────────────

def test_normalize_first_author_last_name_comma_format():
    result = normalize_first_author(["Smith, John A"])
    assert result == "smith"


def test_normalize_first_author_last_name_space_format():
    result = normalize_first_author(["John Smith"])
    assert result == "smith"


def test_normalize_first_author_compound_surname():
    result = normalize_first_author(["van den Berg, C"])
    assert result == "van den berg"


def test_normalize_first_author_returns_none_for_empty():
    assert normalize_first_author(None) is None
    assert normalize_first_author([]) is None


def test_normalize_first_author_uses_first_element():
    result = normalize_first_author(["Jones, B", "Smith, A", "Williams, C"])
    assert result == "jones"


# ── compute_match_key ─────────────────────────────────────────────────────────

def test_doi_first_strict_with_doi():
    key, basis = compute_match_key("some title", "smith", 2024, "10.1234/x", "doi_first_strict")
    assert key == "doi:10.1234/x"
    assert basis == "doi"


def test_doi_first_strict_fallback_to_tay():
    key, basis = compute_match_key("some title text", "smith", 2024, None, "doi_first_strict")
    assert key == "tay:some title text|smith|2024"
    assert basis == "title_author_year"


def test_doi_first_strict_no_fallback_when_missing_author():
    key, basis = compute_match_key("some title text", None, 2024, None, "doi_first_strict")
    assert key is None
    assert basis == "none"


def test_doi_first_strict_no_fallback_when_missing_year():
    key, basis = compute_match_key("some title text", "smith", None, None, "doi_first_strict")
    assert key is None
    assert basis == "none"


def test_doi_first_medium_fallback_to_ty():
    key, basis = compute_match_key("some title text", None, 2024, None, "doi_first_medium")
    assert key == "ty:some title text|2024"
    assert basis == "title_year"


def test_doi_first_medium_prefers_doi():
    key, basis = compute_match_key("title", "smith", 2024, "10.5678/y", "doi_first_medium")
    assert key == "doi:10.5678/y"
    assert basis == "doi"


def test_strict_preset_no_doi():
    key, basis = compute_match_key("my article title", "jones", 2020, None, "strict")
    assert key == "tay:my article title|jones|2020"
    assert basis == "title_author_year"


def test_strict_preset_ignores_doi():
    key, basis = compute_match_key("my article title", "jones", 2020, "10.1234/doi", "strict")
    # strict preset ignores DOI
    assert key == "tay:my article title|jones|2020"
    assert basis == "title_author_year"


def test_strict_preset_none_when_missing_fields():
    key, basis = compute_match_key("title", None, 2020, None, "strict")
    assert key is None
    assert basis == "none"


def test_medium_preset():
    key, basis = compute_match_key("study on caffeine", "smith", 2022, None, "medium")
    assert key == "ty:study on caffeine|2022"
    assert basis == "title_year"


def test_medium_preset_none_when_no_year():
    key, basis = compute_match_key("some title", "smith", None, None, "medium")
    assert key is None
    assert basis == "none"


def test_loose_preset():
    key, basis = compute_match_key("effects study", "johnson", None, None, "loose")
    assert key == "ta:effects study|johnson"
    assert basis == "title_author"


def test_loose_preset_none_when_no_author():
    key, basis = compute_match_key("some title", None, 2022, None, "loose")
    assert key is None
    assert basis == "none"


def test_unknown_preset_returns_none():
    key, basis = compute_match_key("title", "author", 2020, "10.1/x", "unknown_preset")
    assert key is None
    assert basis == "none"


def test_two_records_same_doi_produce_same_key():
    """Records with the same DOI always get the same key under doi_first_* presets."""
    doi = "10.9999/same"
    key1, _ = compute_match_key("different title a", "smith", 2020, doi, "doi_first_strict")
    key2, _ = compute_match_key("different title b", "jones", 2021, doi, "doi_first_strict")
    assert key1 == key2 == f"doi:{doi}"


def test_title_year_keys_match_despite_different_authors():
    """Under 'medium' preset, same title+year → same key regardless of author."""
    t = normalize_title("caffeine effect on sleep quality")
    key1, _ = compute_match_key(t, "smith", 2023, None, "medium")
    key2, _ = compute_match_key(t, "jones", 2023, None, "medium")
    assert key1 == key2
    assert key1 is not None
