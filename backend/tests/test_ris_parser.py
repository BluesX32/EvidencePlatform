"""
Unit tests for the RIS parser.

Tests cover:
  - Parsing a 10-record fixture file
  - Correct field mapping (title, authors, year, doi, etc.)
  - Normalization edge cases (unicode, whitespace, empty fields)
  - Idempotency concern: DOI normalization to lowercase
  - Graceful handling of bad input
"""
import os
from pathlib import Path

import pytest

from app.parsers.ris import parse, _normalize, _extract_year, _clean_text

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "sample.ris"


def test_parse_fixture_returns_ten_records():
    records = parse(FIXTURE_PATH.read_bytes())
    assert len(records) == 10, f"Expected 10 records, got {len(records)}"


def test_required_keys_present():
    records = parse(FIXTURE_PATH.read_bytes())
    required = {"title", "authors", "year", "doi", "journal", "source_format", "raw_data"}
    for i, rec in enumerate(records):
        missing = required - rec.keys()
        assert not missing, f"Record {i} missing keys: {missing}"


def test_first_record_title():
    records = parse(FIXTURE_PATH.read_bytes())
    assert records[0]["title"] == "Effectiveness of mindfulness-based stress reduction on depression: a systematic review"


def test_first_record_authors():
    records = parse(FIXTURE_PATH.read_bytes())
    authors = records[0]["authors"]
    assert isinstance(authors, list)
    assert len(authors) == 3
    assert authors[0] == "Smith, John A"


def test_first_record_year():
    records = parse(FIXTURE_PATH.read_bytes())
    assert records[0]["year"] == 2023


def test_doi_normalized_to_lowercase():
    records = parse(FIXTURE_PATH.read_bytes())
    for rec in records:
        if rec["doi"]:
            assert rec["doi"] == rec["doi"].lower(), f"DOI not lowercased: {rec['doi']}"


def test_pages_combined():
    records = parse(FIXTURE_PATH.read_bytes())
    assert records[0]["pages"] == "512-534"


def test_keywords_extracted():
    records = parse(FIXTURE_PATH.read_bytes())
    assert records[0]["keywords"] == ["mindfulness", "depression", "systematic review"]


def test_raw_data_preserved():
    """raw_data must contain the original parsed fields verbatim."""
    records = parse(FIXTURE_PATH.read_bytes())
    for rec in records:
        assert isinstance(rec["raw_data"], dict)
        assert len(rec["raw_data"]) > 0


def test_source_format_is_ris():
    records = parse(FIXTURE_PATH.read_bytes())
    for rec in records:
        assert rec["source_format"] == "ris"


def test_missing_abstract_is_none():
    """Record 4 (Patel) has no abstract field."""
    records = parse(FIXTURE_PATH.read_bytes())
    patel = next(r for r in records if "Patel" in str(r["authors"]))
    assert patel["abstract"] is None


def test_single_author_record():
    records = parse(FIXTURE_PATH.read_bytes())
    patel = next(r for r in records if "Patel" in str(r["authors"]))
    assert len(patel["authors"]) == 1


# ── Normalization unit tests ────────────────────────────────────────────────

def test_clean_text_strips_whitespace():
    assert _clean_text("  hello   world  ") == "hello world"


def test_clean_text_empty_returns_none():
    assert _clean_text("") is None
    assert _clean_text("   ") is None
    assert _clean_text(None) is None


def test_clean_text_unicode_normalization():
    # NFC normalization: composed form
    composed = "\u00e9"   # é as single code point
    decomposed = "e\u0301"  # é as e + combining accent
    assert _clean_text(decomposed) == composed


def test_extract_year_standard():
    assert _extract_year({"year": "2023"}) == 2023


def test_extract_year_with_date_suffix():
    # Y1 field sometimes contains "2023/01/15/"
    assert _extract_year({"year": "2023/01/15/"}) == 2023


def test_extract_year_out_of_range():
    assert _extract_year({"year": "999"}) is None
    assert _extract_year({"year": "2200"}) is None


def test_extract_year_missing():
    assert _extract_year({}) is None


def test_invalid_ris_raises_value_error():
    with pytest.raises(ValueError, match="Cannot parse file as RIS"):
        parse(b"this is not a ris file at all @@@@")
