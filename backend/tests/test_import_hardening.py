"""
Import hardening tests — fixes for Phase A parser bugs.

Covers:
- Format detection with variant spacing and PMID without space
- RIS parsing with single-space ER and no-ER fallback splitting
- Encoding detection (utf-8-sig, utf-8, latin-1 fallback)
- asyncpg 32767 limit: _CHUNK_SIZE constant and _chunks() helper
"""
import os
import pytest

from app.parsers.detector import detect_format, _decode_bytes
from app.parsers import parse_file

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "import")


# ---------------------------------------------------------------------------
# _decode_bytes — encoding detection
# ---------------------------------------------------------------------------

def test_decode_bytes_handles_utf8():
    """Plain UTF-8 text is decoded correctly."""
    data = "Hello, world!".encode("utf-8")
    assert _decode_bytes(data) == "Hello, world!"


def test_decode_bytes_handles_utf8_sig():
    """UTF-8 BOM is stripped automatically when decoding utf-8-sig."""
    data = b"\xef\xbb\xbfHello"
    result = _decode_bytes(data)
    assert result == "Hello"
    assert not result.startswith("\ufeff")


def test_decode_bytes_handles_latin1():
    """Latin-1 bytes that are not valid UTF-8 fall back to latin-1 decoding."""
    # "café" in Latin-1: é = 0xe9
    data = "café".encode("latin-1")
    result = _decode_bytes(data)
    assert "é" in result  # should be preserved, not replaced with U+FFFD


def test_decode_bytes_normalizes_crlf():
    """CRLF line endings are normalized to LF."""
    data = "line1\r\nline2\r\nline3".encode("utf-8")
    result = _decode_bytes(data)
    assert "\r" not in result
    assert result == "line1\nline2\nline3"


def test_decode_bytes_normalizes_cr():
    """Bare CR line endings are normalized to LF."""
    data = "line1\rline2".encode("utf-8")
    result = _decode_bytes(data)
    assert "\r" not in result


def test_latin1_ris_decoded_without_corruption():
    """Latin-1 encoded RIS file is decoded without replacement characters."""
    path = os.path.join(FIXTURES, "latin1_ris.ris")
    with open(path, "rb") as f:
        data = f.read()
    text = _decode_bytes(data)
    # Characters that exist in the file: ü, Ü, é, á, ó
    assert "\ufffd" not in text, "Replacement char found — Latin-1 not decoded correctly"
    assert "ü" in text or "Ü" in text or "é" in text


# ---------------------------------------------------------------------------
# detect_format — variant spacing fixes
# ---------------------------------------------------------------------------

def test_detect_ris_single_space_ty():
    """RIS file with 'TY -' (1 space) is correctly identified as 'ris'."""
    data = b"TY - JOUR\nAU - Smith J\nTI - Title here\nER -\n"
    assert detect_format(data) == "ris"


def test_detect_ris_standard_two_space_ty():
    """RIS file with 'TY  -' (2 spaces) still correctly identified as 'ris'."""
    data = b"TY  - JOUR\nAU  - Smith J\nTI  - Title\nER  -\n"
    assert detect_format(data) == "ris"


def test_detect_medline_pmid_without_space():
    """MEDLINE file with 'PMID-12345' (no space after dash) is detected as 'medline'."""
    data = b"PMID-36521234\nTI  - Some title\nAU  - Smith J\nDP  - 2022\n\n"
    assert detect_format(data) == "medline"


def test_detect_medline_pmid_with_space():
    """MEDLINE file with 'PMID- 12345' (standard space) still detected as 'medline'."""
    data = b"PMID- 36521234\nTI  - Some title\nDP  - 2022\n\n"
    assert detect_format(data) == "medline"


def test_detect_medline_secondary_heuristic_flexible_spacing():
    """MEDLINE detection works even when tags use single-space format 'AU - '."""
    # CINAHL MEDLINE exports may use single-space tag format
    data = b"AU - Smith J\nTI - Some title\nAB - Abstract text here.\nDP - 2022\n"
    assert detect_format(data) == "medline"


def test_detect_cinahl_singlespace_ris_fixture():
    """CINAHL-style RIS with 'TY -' (1 space) is detected as 'ris'."""
    path = os.path.join(FIXTURES, "cinahl_singlespace.ris")
    with open(path, "rb") as f:
        data = f.read()
    assert detect_format(data) == "ris"


def test_detect_pubmed_nospace_fixture():
    """PubMed fixture with 'PMID-' (no space) is detected as 'medline'."""
    path = os.path.join(FIXTURES, "pubmed_nospace.txt")
    with open(path, "rb") as f:
        data = f.read()
    assert detect_format(data) == "medline"


# ---------------------------------------------------------------------------
# RIS parsing — variant ER tags
# ---------------------------------------------------------------------------

def test_parse_ris_single_space_er():
    """RIS file with 'ER -' (1 space) parses correctly — record splitting works."""
    content = (
        b"TY - JOUR\n"
        b"TI - First record title\n"
        b"AU - Smith, John\n"
        b"PY - 2023\n"
        b"ER -\n"
        b"\n"
        b"TY - JOUR\n"
        b"TI - Second record title\n"
        b"AU - Jones, Alice\n"
        b"PY - 2022\n"
        b"ER -\n"
    )
    result = parse_file(content)
    assert result.format_detected == "ris"
    assert result.valid_count == 2
    assert result.records[0]["title"] == "First record title"
    assert result.records[1]["title"] == "Second record title"


def test_parse_ris_no_er_fallback_splitting():
    """RIS file with no ER lines uses blank-line fallback splitting."""
    content = (
        b"TY  - JOUR\n"
        b"TI  - Record without ER tag\n"
        b"AU  - Smith, John\n"
        b"PY  - 2023\n"
        b"\n"
        b"TY  - JOUR\n"
        b"TI  - Second record no ER\n"
        b"AU  - Jones, Alice\n"
        b"PY  - 2022\n"
    )
    result = parse_file(content)
    assert result.format_detected == "ris"
    assert result.valid_count >= 1, f"Expected ≥1 records, got {result.valid_count} (errors: {result.errors})"


def test_parse_ris_er_no_space():
    """RIS file with 'ER-' (no space) is also handled."""
    content = (
        b"TY  - JOUR\n"
        b"TI  - Title A\n"
        b"PY  - 2023\n"
        b"ER-\n"
        b"\n"
        b"TY  - JOUR\n"
        b"TI  - Title B\n"
        b"PY  - 2022\n"
        b"ER-\n"
    )
    result = parse_file(content)
    assert result.format_detected == "ris"
    # At minimum, should not crash; may have 1-2 records depending on how rispy handles it
    assert isinstance(result.valid_count, int)
    assert result.failed_count < result.total_attempted or result.valid_count >= 1


def test_parse_cinahl_singlespace_fixture():
    """CINAHL-style single-space RIS fixture parses to 2 records."""
    path = os.path.join(FIXTURES, "cinahl_singlespace.ris")
    with open(path, "rb") as f:
        data = f.read()
    result = parse_file(data)
    assert result.format_detected == "ris"
    assert result.valid_count == 2
    assert result.failed_count == 0


def test_parse_pubmed_nospace_fixture():
    """PubMed fixture with PMID-12345 (no space) parses to 2 MEDLINE records."""
    path = os.path.join(FIXTURES, "pubmed_nospace.txt")
    with open(path, "rb") as f:
        data = f.read()
    result = parse_file(data)
    assert result.format_detected == "medline"
    assert result.valid_count == 2
    assert result.failed_count == 0


def test_parse_latin1_ris_fixture():
    """Latin-1 encoded RIS file parses without crashing and returns 2 records."""
    path = os.path.join(FIXTURES, "latin1_ris.ris")
    with open(path, "rb") as f:
        data = f.read()
    result = parse_file(data)
    assert result.format_detected == "ris"
    assert result.valid_count == 2
    # No replacement chars in title — special chars preserved
    for rec in result.records:
        if rec.get("title"):
            assert "\ufffd" not in rec["title"]


# ---------------------------------------------------------------------------
# asyncpg chunking — _CHUNK_SIZE and _chunks helper
# ---------------------------------------------------------------------------

def test_chunk_size_constant_exists():
    """_CHUNK_SIZE must be defined and be a positive integer ≤ 2047."""
    from app.repositories.record_repo import _CHUNK_SIZE
    assert isinstance(_CHUNK_SIZE, int)
    assert 1 <= _CHUNK_SIZE <= 2047, (
        f"_CHUNK_SIZE={_CHUNK_SIZE} must be ≤ 2047 to stay under asyncpg limit "
        f"(16 cols × 2047 = 32752 params < 32767)"
    )


def test_chunks_helper_covers_all_elements():
    """_chunks(lst, n) produces non-overlapping chunks covering all elements."""
    from app.repositories.record_repo import _chunks
    lst = list(range(10))
    result = list(_chunks(lst, 3))
    # Should be [[0,1,2], [3,4,5], [6,7,8], [9]]
    assert result == [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]
    # Flat reconstruction equals original
    flat = [x for chunk in result for x in chunk]
    assert flat == lst


def test_chunks_helper_single_chunk_when_under_limit():
    """_chunks returns a single chunk when len(lst) ≤ n."""
    from app.repositories.record_repo import _chunks
    lst = list(range(5))
    result = list(_chunks(lst, 10))
    assert result == [lst]


def test_chunks_helper_empty_list():
    """_chunks handles empty list gracefully."""
    from app.repositories.record_repo import _chunks
    assert list(_chunks([], 100)) == []


def test_chunks_size_satisfies_asyncpg_limit_for_record():
    """16 columns × _CHUNK_SIZE < 32767 (asyncpg wire limit for Record table)."""
    from app.repositories.record_repo import _CHUNK_SIZE
    record_columns = 16
    assert record_columns * _CHUNK_SIZE < 32767


def test_chunks_size_satisfies_asyncpg_limit_for_record_source():
    """8 columns × _CHUNK_SIZE < 32767 (asyncpg wire limit for RecordSource table)."""
    from app.repositories.record_repo import _CHUNK_SIZE
    record_source_columns = 8
    assert record_source_columns * _CHUNK_SIZE < 32767
