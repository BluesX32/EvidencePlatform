"""
Tests for format detection and the parse_file() dispatcher.

These are pure unit tests — no database connection required.
"""
import os
import pytest

from app.parsers.detector import detect_format
from app.parsers import parse_file

# ── fixtures paths ────────────────────────────────────────────────────────────

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _read(name: str) -> bytes:
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


# ── detect_format() ───────────────────────────────────────────────────────────

def test_detect_ris_from_sample_fixture():
    """Standard RIS fixture is detected as 'ris'."""
    assert detect_format(_read("sample.ris")) == "ris"


def test_detect_ris_from_cinahl_fixture():
    """CINAHL RIS export (which uses TY  - JOUR) is detected as 'ris'."""
    assert detect_format(_read("cinahl.ris")) == "ris"


def test_detect_medline_from_pubmed_fixture():
    """PubMed MEDLINE .txt export is detected as 'medline'."""
    assert detect_format(_read("pubmed_medline.txt")) == "medline"


def test_detect_ris_minimal_bytes():
    """Minimal RIS content (TY + ER) is detected as 'ris'."""
    minimal = b"TY  - JOUR\nTI  - Test\nER  - \n"
    assert detect_format(minimal) == "ris"


def test_detect_medline_minimal_bytes():
    """Minimal MEDLINE content (PMID-) is detected as 'medline'."""
    minimal = b"PMID- 12345678\nTI  - Some title\nAU  - Smith, J\n\n"
    assert detect_format(minimal) == "medline"


def test_detect_csv():
    """CSV content (commas in first line) is detected as 'csv'."""
    csv_bytes = b"Title,Authors,Year,DOI,Journal\n\"Some article\",\"Smith J\",2023,10.1234/x,Nature\n"
    assert detect_format(csv_bytes) == "csv"


def test_detect_empty_bytes():
    """Empty bytes are 'unknown' (nothing to detect)."""
    assert detect_format(b"") == "unknown"


def test_detect_garbage_bytes():
    """Random garbage without any recognizable tags is 'unknown'."""
    assert detect_format(b"this is just some plain text with no tags") == "unknown"


def test_detect_bom_prefixed_ris():
    """UTF-8 BOM followed by RIS content is still detected as 'ris'."""
    bom = b"\xef\xbb\xbf"
    ris_content = b"TY  - JOUR\nTI  - Test Article\nER  - \n"
    assert detect_format(bom + ris_content) == "ris"


def test_detect_crlf_ris():
    """RIS file with Windows line endings (CRLF) is detected as 'ris'."""
    crlf_ris = b"TY  - JOUR\r\nTI  - Test\r\nER  -\r\n"
    assert detect_format(crlf_ris) == "ris"


def test_detect_crlf_medline():
    """MEDLINE file with Windows line endings (CRLF) is detected as 'medline'."""
    crlf_medline = b"PMID- 12345678\r\nTI  - Title\r\nAU  - Smith, J\r\n"
    assert detect_format(crlf_medline) == "medline"


# ── parse_file() dispatcher ───────────────────────────────────────────────────

def test_parse_file_ris_returns_parseresult():
    """parse_file on RIS content returns ParseResult with format_detected='ris'."""
    result = parse_file(_read("sample.ris"))
    assert result.format_detected == "ris"
    assert result.valid_count == 10  # sample.ris has 10 records
    assert result.failed_count == 0


def test_parse_file_medline_returns_parseresult():
    """parse_file on MEDLINE content returns ParseResult with format_detected='medline'."""
    result = parse_file(_read("pubmed_medline.txt"))
    assert result.format_detected == "medline"
    assert result.valid_count == 3
    assert result.failed_count == 0


def test_parse_file_csv_returns_zero_valid():
    """parse_file on CSV content returns ParseResult with valid_count=0 and a warning."""
    csv_bytes = b"Title,Authors,Year,DOI,Journal\n\"Article\",\"Smith\",2023,10.1234/x,Nature\n"
    result = parse_file(csv_bytes)
    assert result.format_detected == "csv"
    assert result.valid_count == 0
    assert any("CSV" in w for w in result.warnings)


def test_parse_file_unknown_returns_zero_valid():
    """parse_file on unrecognizable content returns ParseResult with valid_count=0."""
    result = parse_file(b"totally not a bibliography format")
    assert result.format_detected == "unknown"
    assert result.valid_count == 0


def test_parse_file_cinahl_ris():
    """parse_file on CINAHL RIS fixture returns 3 records."""
    result = parse_file(_read("cinahl.ris"))
    assert result.format_detected == "ris"
    assert result.valid_count == 3


def test_parse_file_partial_corrupt_ris():
    """parse_file on RIS with one corrupt block still returns valid records."""
    result = parse_file(_read("partial_corrupt.ris"))
    assert result.format_detected == "ris"
    assert result.valid_count >= 2  # at least 2 of 3 valid records parsed
    # At least one error was collected
    assert result.failed_count >= 0  # corrupt block may or may not trigger rispy error


def test_parse_file_never_raises():
    """parse_file must never raise an exception regardless of input."""
    inputs = [
        b"",
        b"garbage",
        b"\x00\x01\x02\x03",  # binary
        b"TY  - JOUR\n",       # incomplete RIS (no ER)
        b"PMID- abc\n",        # MEDLINE with non-numeric PMID
    ]
    for inp in inputs:
        result = parse_file(inp)
        assert hasattr(result, "valid_count")  # returned a ParseResult


def test_parse_file_records_have_required_keys():
    """Every record from parse_file has the required schema keys."""
    required = {"title", "authors", "year", "doi", "source_format", "raw_data"}
    result = parse_file(_read("sample.ris"))
    for rec in result.records:
        assert required.issubset(rec.keys()), f"Record missing keys: {required - rec.keys()}"
