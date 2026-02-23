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
"""
import unicodedata
from typing import Optional

import rispy


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
