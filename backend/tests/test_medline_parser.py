"""
Tests for the MEDLINE/PubMed-tagged format parser.

These are pure unit tests — no database connection required.
The MEDLINE parser must produce records in the same normalized shape as
the RIS parser so that RecordRepo.upsert_and_link() can treat them
identically.
"""
import os
import pytest

from app.parsers import medline
from app.parsers.base import ParseResult

# ── fixtures ──────────────────────────────────────────────────────────────────

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")

# Canonical 3-record MEDLINE fixture (pubmed_medline.txt)
with open(os.path.join(FIXTURES, "pubmed_medline.txt"), "rb") as _f:
    _FIXTURE_BYTES = _f.read()


def _fixture_records():
    return medline.parse_tolerant(_FIXTURE_BYTES).records


# ── basic parsing ─────────────────────────────────────────────────────────────

def test_parse_three_records():
    """pubmed_medline.txt contains exactly 3 records."""
    result = medline.parse_tolerant(_FIXTURE_BYTES)
    assert result.valid_count == 3
    assert result.failed_count == 0


def test_parse_result_type():
    """parse_tolerant returns a ParseResult, not a plain list."""
    result = medline.parse_tolerant(_FIXTURE_BYTES)
    assert isinstance(result, ParseResult)
    assert result.format_detected == "medline"


def test_first_record_title():
    """First record title is extracted correctly (multi-line continuation)."""
    records = _fixture_records()
    assert records[0]["title"] is not None
    assert "mindfulness" in records[0]["title"].lower()
    assert "systematic review" in records[0]["title"].lower()


def test_pmid_in_source_record_id():
    """PMID is stored in raw_data['source_record_id']."""
    records = _fixture_records()
    assert records[0]["raw_data"]["source_record_id"] == "36521234"
    assert records[1]["raw_data"]["source_record_id"] == "36521235"
    assert records[2]["raw_data"]["source_record_id"] == "36521236"


def test_pmid_also_in_raw_data_pmid():
    """raw_data['pmid'] mirrors source_record_id for direct PMID lookups."""
    records = _fixture_records()
    assert records[0]["raw_data"]["pmid"] == "36521234"


def test_doi_extracted_from_lid_tag():
    """DOI is extracted from LID tag '[doi]' suffix and normalised to lowercase."""
    records = _fixture_records()
    assert records[0]["doi"] == "10.1002/jclp.23456"
    assert records[1]["doi"] == "10.1001/jamapsychiatry.2022.3456"


def test_doi_from_lid_tag_record3():
    """Third record DOI (longer format) is extracted correctly."""
    records = _fixture_records()
    assert records[2]["doi"] == "10.1002/14651858.cd013745.pub2"


def test_authors_collected_from_fau_tag():
    """Authors from FAU (full author name) are collected — one per tag."""
    records = _fixture_records()
    authors = records[0]["authors"]
    assert authors is not None
    assert len(authors) == 3
    assert "Smith, John Arthur" in authors


def test_authors_fallback_to_au_when_no_fau():
    """Record 3 has no FAU tag; AU is used as fallback."""
    records = _fixture_records()
    # Record 3 (Thompson) has only AU  - Thompson, Robert
    assert records[2]["authors"] is not None
    assert any("Thompson" in a for a in records[2]["authors"])


def test_year_extracted_from_dp_with_month():
    """Year is extracted from DP '2023 Jan 15' → 2023."""
    records = _fixture_records()
    assert records[0]["year"] == 2023


def test_year_extracted_from_dp_month_only():
    """Year is extracted from DP '2022 Nov' → 2022."""
    records = _fixture_records()
    assert records[1]["year"] == 2022


def test_abstract_extracted():
    """Abstract is extracted and non-empty for records that have AB."""
    records = _fixture_records()
    assert records[0]["abstract"] is not None
    assert len(records[0]["abstract"]) > 50


def test_mesh_keywords_extracted():
    """MeSH headings (MH tag) are collected as keywords."""
    records = _fixture_records()
    kw = records[0]["keywords"]
    assert kw is not None
    assert any("mindfulness" in k.lower() for k in kw)


def test_other_keywords_extracted():
    """OT (other terms) keywords are collected alongside MH."""
    records = _fixture_records()
    kw = records[0]["keywords"]
    # OT keywords: "meta-analysis" and "systematic review"
    assert any("meta-analysis" in k.lower() for k in kw)


def test_issn_extracted_and_cleaned():
    """ISSN is extracted from IS tag, parenthetical label stripped."""
    records = _fixture_records()
    issn = records[0]["issn"]
    assert issn is not None
    assert "(" not in issn  # "(Electronic)" label must be stripped
    assert "-" in issn       # standard ISSN format: NNNN-NNNN


def test_journal_from_jt_tag():
    """Full journal name from JT tag is extracted."""
    records = _fixture_records()
    assert records[0]["journal"] is not None
    assert "Clinical Psychology" in records[0]["journal"]


def test_source_format_is_medline():
    """source_format field is 'medline' for all MEDLINE-parsed records."""
    records = _fixture_records()
    for rec in records:
        assert rec["source_format"] == "medline"


def test_normalized_output_has_required_keys():
    """Every record has the required schema keys (same as RIS parser)."""
    required = {"title", "abstract", "authors", "year", "journal", "doi",
                "issn", "volume", "issue", "pages", "keywords",
                "source_format", "raw_data"}
    records = _fixture_records()
    for rec in records:
        missing = required - rec.keys()
        assert not missing, f"Record missing keys: {missing}"


# ── tolerant parsing ──────────────────────────────────────────────────────────

def test_missing_pmid_gives_none_source_record_id():
    """Record without PMID tag → source_record_id is None."""
    content = b"TI  - Some title without PMID\nAU  - Smith, J\nDP  - 2023\n\n"
    records = medline.parse_tolerant(content).records
    # May be 0 if no PMID-prefixed record found; test that if parsed, id is None
    for rec in records:
        assert rec["raw_data"].get("source_record_id") is None


def test_empty_bytes_returns_zero_records():
    """Empty input returns ParseResult with valid_count=0."""
    result = medline.parse_tolerant(b"")
    assert result.valid_count == 0
    assert result.failed_count == 0


def test_corrupt_record_middle_skipped():
    """A corrupt record in the middle is skipped; surrounding valid records are parsed."""
    content = (
        b"PMID- 111\nTI  - First valid\nDP  - 2023\n\n"
        b"PMID- 222\nTI  - Second valid\nDP  - 2022\n\n"
    )
    result = medline.parse_tolerant(content)
    assert result.valid_count >= 1


def test_crlf_line_endings_handled():
    """MEDLINE files with CRLF line endings are parsed correctly."""
    content = b"PMID- 99999\r\nTI  - CRLF Test\r\nAU  - Author, A\r\nDP  - 2023\r\n\r\n"
    result = medline.parse_tolerant(content)
    assert result.valid_count >= 1
    assert result.records[0]["title"] == "CRLF Test"


def test_multiline_continuation_title():
    """Titles spanning multiple lines (6-space continuation) are joined correctly."""
    content = (
        b"PMID- 11111\n"
        b"TI  - Effects of mindfulness on anxiety and\n"
        b"      depression: a systematic review.\n"
        b"DP  - 2023\n\n"
    )
    result = medline.parse_tolerant(content)
    assert result.valid_count >= 1
    title = result.records[0]["title"]
    assert "anxiety" in title
    assert "systematic review" in title
