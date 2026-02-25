"""
RIS format parser.

Converts raw RIS file bytes into a list of normalized record dicts
ready for insertion into record_sources. The original parsed fields
are preserved verbatim in the `raw_data` key so the source is never lost.

RIS tag reference used:
  TI / T1  — title
  AU / A1  — author (one tag per author)
  AB / N2  — abstract
  PY / Y1  — publication year
  JO / JF / T2 / SO — journal name
  VL       — volume
  IS       — issue
  SP / EP  — start page / end page
  DO       — DOI
  SN       — ISSN
  KW       — keyword (one tag per keyword)
  AN       — accession number (PMID in PubMed exports, EID in Scopus exports)

source_record_id convention:
  raw_data always carries the key "source_record_id" (string | null).
  Populated from AN (rispy: accession_number) when present; null otherwise.

Two entry points:
  parse()          — strict: raises ValueError on any parse failure (preserved for
                     backward compatibility and direct tests).
  parse_tolerant() — lenient: parses record-by-record, collects per-record errors,
                     returns a ParseResult even when some records are corrupt.
"""
import re
import unicodedata
from typing import Optional

import rispy

from app.parsers.base import ParseResult, RecordError
from app.parsers.detector import _decode_bytes

# Delimiter used to split a RIS file into individual record blocks.
# "ER  -" marks the end of a record; we split on lines that start with it.
# Accepts any number of spaces between ER and the dash (0, 1, or 2+) to handle
# variant RIS exports from Scopus, CINAHL, and other tools.
_ER_SPLIT_RE = re.compile(r"\nER\s*-[^\n]*", re.MULTILINE)

# Used for fallback detection of multiple records when no ER lines are present.
_TY_TAG_RE = re.compile(r"^TY\s+-", re.MULTILINE)

# Normalizes any RIS tag line to have exactly 2 spaces before the dash so that
# rispy (which requires "TAG  - value") can parse variant-spacing exports.
# Handles: "TY -", "TY   -", "AU - " etc.
_TAG_SPACING_RE = re.compile(r"^([A-Z0-9]{2,4})[ \t]*-", re.MULTILINE)


def parse(file_bytes: bytes) -> list[dict]:
    """
    Parse raw RIS file bytes.
    Returns a list of record dicts ready for bulk insertion.
    Raises ValueError if the file cannot be parsed as RIS.
    """
    try:
        text = file_bytes.decode("utf-8", errors="replace")
        entries = rispy.loads(text)
    except Exception as exc:
        raise ValueError(f"Cannot parse file as RIS: {exc}") from exc

    return [_normalize(entry) for entry in entries]


def parse_tolerant(file_bytes: bytes) -> ParseResult:
    """
    Parse a RIS file record-by-record, tolerating individual corrupt entries.

    Splits the file on ER (end-of-record) tags and attempts to parse each
    block independently with rispy. Failures are collected as RecordError
    entries and do not abort processing of subsequent records.

    Fallback: if ER splitting yields ≤ 1 block but multiple TY tags are present
    (multi-record file with no ER lines), re-splits on blank lines and processes
    only blocks that start with a TY tag.

    Returns:
        ParseResult with the same normalized dict shape as parse().
    """
    text = _decode_bytes(file_bytes)

    # Split into blocks: each block is one record's worth of RIS text.
    # Re-append the ER line that was consumed by the split.
    raw_blocks = _ER_SPLIT_RE.split(text)
    blocks = [b.strip() for b in raw_blocks if b.strip()]

    # Fallback: no ER lines found but multiple TY tags detected → try blank-line split
    if len(blocks) <= 1 and len(_TY_TAG_RE.findall(text)) >= 2:
        blank_blocks = re.split(r"\n{2,}", text.strip())
        blocks = [b.strip() for b in blank_blocks if b.strip() and _TY_TAG_RE.search(b)]

    records: list[dict] = []
    errors: list[RecordError] = []
    warnings: list[str] = []

    for i, block in enumerate(blocks):
        # A minimal RIS block must have at least TY and ER
        if not block:
            continue
        # Normalize tag spacing to "TAG  - " (exactly 2 spaces) for rispy compatibility.
        # Handles exports that use "TY -" or "AU -" (1 space) instead of standard 2 spaces.
        block = _TAG_SPACING_RE.sub(r"\1  -", block)
        # Re-add the ER tag so rispy can parse the block
        block_with_er = block + "\nER  - \n"
        try:
            entries = rispy.loads(block_with_er)
            for entry in entries:
                records.append(_normalize(entry))
        except Exception as exc:
            errors.append(
                RecordError(
                    index=i,
                    reason=f"RIS parse error: {exc}",
                    raw_snippet=block[:200],
                )
            )

    return ParseResult(
        records=records,
        errors=errors,
        format_detected="ris",
        total_attempted=len(blocks),
        valid_count=len(records),
        failed_count=len(errors),
        warnings=warnings,
    )


def _normalize(entry: dict) -> dict:
    """
    Map rispy field names to our schema columns and normalize values.
    The original entry dict is stored in raw_data, augmented with
    a "source_record_id" key for the stable source-specific identifier.
    """
    raw_data = dict(entry)  # shallow copy preserves original

    # Extract stable source-specific identifier (PMID, EID, accession number).
    # AN tag → rispy "accession_number". Present in PubMed and Scopus RIS exports.
    source_record_id = (
        _clean_text(entry.get("accession_number"))
        or _clean_text(entry.get("pubmed_id"))
        or None
    )
    raw_data["source_record_id"] = source_record_id  # always present; null when absent

    title = _clean_text(
        entry.get("title") or entry.get("primary_title") or entry.get("title_secondary")
    )
    abstract = _clean_text(entry.get("abstract") or entry.get("notes_abstract"))
    authors = _extract_authors(entry)
    year = _extract_year(entry)
    journal = _clean_text(
        entry.get("journal_name")
        or entry.get("alternate_title1")
        or entry.get("secondary_title")
        or entry.get("periodical_name_full_format")
    )
    doi = _clean_text(entry.get("doi"))
    issn = _clean_text(entry.get("issn"))
    volume = _clean_text(entry.get("volume"))
    issue = _clean_text(entry.get("number"))
    pages = _extract_pages(entry)
    keywords = _extract_keywords(entry)

    return {
        "title": title,
        "abstract": abstract,
        "authors": authors if authors else None,
        "year": year,
        "journal": journal,
        "doi": doi.lower() if doi else None,  # normalise DOI casing for dedup
        "issn": issn,
        "volume": volume,
        "issue": issue,
        "pages": pages,
        "keywords": keywords if keywords else None,
        "source_format": "ris",
        "raw_data": raw_data,
    }


def _clean_text(value: Optional[str]) -> Optional[str]:
    """Normalize unicode, collapse whitespace, strip. Returns None for empty strings."""
    if not value:
        return None
    value = unicodedata.normalize("NFC", value)
    value = " ".join(value.split())
    return value or None


def _extract_authors(entry: dict) -> list[str]:
    """
    RIS stores authors as a list under 'authors' or 'first_authors'.
    Each element is a string like "Smith, John" or "Smith J".
    """
    authors = entry.get("authors") or entry.get("first_authors") or []
    return [_clean_text(a) for a in authors if _clean_text(a)]


def _extract_year(entry: dict) -> Optional[int]:
    """
    Year is stored as a string in various fields. Extract the four-digit year.
    rispy maps PY/Y1 to 'year' as a string like "2023" or "2023/01/15/".
    """
    raw = entry.get("year") or entry.get("publication_year") or ""
    if not raw:
        return None
    # Take the first 4-digit sequence
    digits = "".join(filter(str.isdigit, str(raw)))[:4]
    try:
        year = int(digits)
        return year if 1000 <= year <= 2100 else None
    except (ValueError, TypeError):
        return None


def _extract_pages(entry: dict) -> Optional[str]:
    """Combine start and end pages into 'start-end', or return whichever exists."""
    start = _clean_text(entry.get("start_page"))
    end = _clean_text(entry.get("end_page"))
    if start and end:
        return f"{start}-{end}"
    return start or end


def _extract_keywords(entry: dict) -> list[str]:
    raw = entry.get("keywords") or []
    return [k for k in (_clean_text(kw) for kw in raw) if k]
