"""
MEDLINE/PubMed-tagged format parser.

Handles .txt files exported from PubMed (Send to → Citation manager → Format: PubMed).
Also handles Ovid MEDLINE exports that use the same tag structure.

MEDLINE format:
  - Records separated by blank lines (one or more consecutive empty lines).
  - Each field: 4-char left-justified tag + "- " + value.
  - Multi-line values: continuation lines start with 6 spaces (no tag).
  - Multi-value fields (AU, MH, OT): one tag per value.

Tag reference (PubMed subset):
  PMID - PubMed unique identifier
  TI   - Article title
  AU   - Author (Last, Initials format)
  FAU  - Full author name
  AB   - Abstract
  DP   - Date of publication ("YYYY Mon DD" or "YYYY")
  JT   - Full journal title
  TA   - Journal abbreviation
  VI   - Volume
  IP   - Issue
  PG   - Pagination
  LID  - Location ID (DOI with "[doi]" suffix, PMCID, etc.)
  AID  - Article identifier (similar to LID)
  IS   - ISSN ("NNNN-NNNN (Print)" or "(Electronic)")
  MH   - MeSH heading (keyword)
  OT   - Other term / author-supplied keyword

Output: same normalized dict shape as app.parsers.ris._normalize()
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from app.parsers.base import ParseResult, RecordError, normalize_doi, _is_useful_record
from app.parsers.detector import _decode_bytes

# Regex for a MEDLINE tag line: 2-4 uppercase letters + optional spaces + dash +
# optional whitespace + value.  The value may start immediately after the dash
# ("PMID-12345") or be separated by one or more spaces ("TI  - Title").
# The `.strip()` call in _parse_fields() removes any leading whitespace from the
# captured value, so `\s*` in the trailing group is safe.
_TAG_LINE_RE = re.compile(r"^([A-Z]{2,4})\s*-\s*(.*)")
_DOI_SUFFIX_RE = re.compile(r"\s*\[doi\]\s*$", re.IGNORECASE)
_YEAR_RE = re.compile(r"(\d{4})")


def parse_tolerant(file_bytes: bytes) -> ParseResult:
    """
    Parse a MEDLINE/PubMed-tagged file.

    Each record is parsed independently; a failure in one record does not
    prevent the rest from being processed.

    Returns a ParseResult with the same dict schema as the RIS parser.
    """
    text = _decode(file_bytes)
    blocks = _split_records(text)

    records = []
    errors = []

    for i, block in enumerate(blocks):
        if not block.strip():
            continue
        try:
            rec = _parse_block(block)
            if rec is not None and _is_useful_record(rec):
                records.append(rec)
            # rec is None if block has no recognizable fields (blank / comment);
            # _is_useful_record() drops records with no title AND no identifier.
        except Exception as exc:
            errors.append(
                RecordError(
                    index=i,
                    reason=f"MEDLINE parse error: {exc}",
                    raw_snippet=block[:200],
                )
            )

    warnings: list[str] = []
    return ParseResult(
        records=records,
        errors=errors,
        format_detected="medline",
        total_attempted=len(blocks),
        valid_count=len(records),
        failed_count=len(errors),
        warnings=warnings,
    )


# ── internal helpers ──────────────────────────────────────────────────────────

def _decode(file_bytes: bytes) -> str:
    """Decode with encoding fallback (utf-8-sig → utf-8 → latin-1) and CRLF normalisation."""
    return _decode_bytes(file_bytes)


def _split_records(text: str) -> list[str]:
    """
    Split MEDLINE text into individual record blocks.
    Records are separated by one or more blank lines.
    """
    # Split on 2+ consecutive newlines (blank line separator)
    # Keep each block as a string for independent parsing
    blocks = re.split(r"\n{2,}", text.strip())
    return [b.strip() for b in blocks if b.strip()]


def _parse_fields(block: str) -> dict[str, list[str]]:
    """
    Parse a single MEDLINE record block into a dict of tag → list of values.

    Handles multi-line continuation (lines indented with 6 spaces) and
    multi-value fields (AU, MH, OT — one tag per value).
    """
    fields: dict[str, list[str]] = {}
    current_tag: Optional[str] = None
    current_value: list[str] = []

    for line in block.splitlines():
        m = _TAG_LINE_RE.match(line)
        if m:
            # Flush previous tag
            if current_tag is not None:
                fields.setdefault(current_tag, []).append(" ".join(current_value))
            current_tag = m.group(1).strip()
            current_value = [m.group(2).strip()]
        elif current_tag is not None and line.strip():
            # Continuation line: either starts with 6 spaces (standard PubMed) or
            # is any other non-blank, non-tag line (tolerant handling for vendors
            # that wrap long values without the standard indent).
            current_value.append(line.strip())

    # Flush last tag
    if current_tag is not None:
        fields.setdefault(current_tag, []).append(" ".join(current_value))

    return fields


def _parse_block(block: str) -> Optional[dict]:
    """
    Convert a MEDLINE record block into a normalized record dict.

    Returns None for blocks with no recognizable fields (empty/comment).
    """
    fields = _parse_fields(block)
    if not fields:
        return None

    # source_record_id: PMID is the stable PubMed identifier
    pmid = fields.get("PMID", [None])[0]
    pmid = _clean(pmid)

    raw_data = dict(fields)  # preserve all original tags
    raw_data["source_record_id"] = pmid  # normalised convention (same as RIS parser)
    raw_data["pmid"] = pmid

    # Title
    title = _clean(fields.get("TI", [None])[0])

    # Abstract
    abstract = _clean(fields.get("AB", [None])[0])

    # Authors: FAU (full name) preferred; fall back to AU
    author_list = fields.get("FAU") or fields.get("AU") or []
    authors = [a for a in (_clean(a) for a in author_list) if a] or None

    # Year: from DP "2023 Jan 15" — first 4-digit sequence
    dp = fields.get("DP", [""])[0]
    year = _extract_year(dp)

    # Journal: JT (full) preferred, fall back to TA (abbreviation)
    journal = _clean(fields.get("JT", [None])[0]) or _clean(fields.get("TA", [None])[0])

    # Volume, Issue, Pages
    volume = _clean(fields.get("VI", [None])[0])
    issue = _clean(fields.get("IP", [None])[0])
    pages = _clean(fields.get("PG", [None])[0])

    # DOI: from LID or AID, selecting the entry tagged "[doi]"
    doi = _extract_doi(fields.get("LID", []) + fields.get("AID", []))

    # ISSN: first IS value, strip the "(Print)"/"(Electronic)" suffix
    issn = _extract_issn(fields.get("IS", []))

    # Keywords: MH (MeSH) + OT (other terms)
    kw_raw = fields.get("MH", []) + fields.get("OT", [])
    keywords = [k for k in (_clean(k) for k in kw_raw) if k] or None

    return {
        "title": title,
        "abstract": abstract,
        "authors": authors,
        "year": year,
        "journal": journal,
        "doi": normalize_doi(doi),  # lowercase + strip "doi:" / URL prefix
        "issn": issn,
        "volume": volume,
        "issue": issue,
        "pages": pages,
        "keywords": keywords,
        "source_format": "medline",
        "raw_data": raw_data,
    }


def _clean(value: Optional[str]) -> Optional[str]:
    """NFC-normalize, collapse whitespace, return None for blank."""
    if not value:
        return None
    value = unicodedata.normalize("NFC", value)
    value = " ".join(value.split())
    return value or None


def _extract_year(dp: str) -> Optional[int]:
    """Extract 4-digit year from DP field like '2023 Jan 15' or '2023'."""
    m = _YEAR_RE.search(dp)
    if not m:
        return None
    try:
        y = int(m.group(1))
        return y if 1000 <= y <= 2100 else None
    except ValueError:
        return None


def _extract_doi(entries: list[str]) -> Optional[str]:
    """
    From a list of LID/AID values, return the one that is tagged [doi].
    Example: "10.1234/example [doi]" → "10.1234/example"
    """
    for entry in entries:
        if entry and "[doi]" in entry.lower():
            doi = _DOI_SUFFIX_RE.sub("", entry).strip()
            return doi or None
    return None


def _extract_issn(entries: list[str]) -> Optional[str]:
    """
    Return the first ISSN, stripping the "(Print)"/"(Electronic)" label.
    Example: "1234-5678 (Electronic)" → "1234-5678"
    """
    for entry in entries:
        if entry:
            # Remove trailing parenthetical label
            issn = re.sub(r"\s*\([^)]*\)\s*$", "", entry).strip()
            if issn:
                return issn
    return None
