"""
Overlap normalization utilities.

Five pure functions used exclusively by the overlap detection system.
No I/O — unit-testable in isolation.

These are intentionally separate from match_keys.py (which serves dedup)
so that the two systems can evolve independently.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

_BRACKET_RE = re.compile(r"\[.*?\]")          # remove [Review], [erratum], etc.
_PUNCT_RE   = re.compile(r"[^\w\s]")
_WS_RE      = re.compile(r"\s+")
_VOL_PREFIX = re.compile(r"^vol(?:ume)?\.?\s*", re.I)
_YEAR_RE    = re.compile(r"\b(1[89]\d{2}|20\d{2})\b")
_AUTHOR_CLEAN_RE = re.compile(r"[^a-z\s]")


def normalize_title_for_overlap(s: Optional[str]) -> str:
    """NFKD → lowercase → remove [bracketed] → remove punctuation → collapse ws → strip trailing period."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = s.lower()
    s = _BRACKET_RE.sub(" ", s)
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    s = s.rstrip(".")
    return s


def extract_year(s) -> Optional[int]:
    """Return first 4-digit year between 1800–2099, or None."""
    if s is None:
        return None
    m = _YEAR_RE.search(str(s))
    return int(m.group(1)) if m else None


def normalize_volume(s: Optional[str]) -> Optional[str]:
    """Lowercase, strip 'vol'/'volume' prefix, strip whitespace."""
    if not s:
        return None
    s = _VOL_PREFIX.sub("", s.lower()).strip()
    return s or None


def parse_authors(authors) -> list:
    """Return list of lowercase last names extracted from author strings.

    Accepts: list[str] or semicolon-delimited string.
    Each element treated as "Last, First" or "First Last".
    When a string is given, splits on semicolons only so that commas within
    each author entry are correctly interpreted as "Last, First" separators.
    """
    if not authors:
        return []
    if isinstance(authors, str):
        parts = [a.strip() for a in authors.split(";") if a.strip()]
    else:
        parts = [str(a) for a in authors if a]
    lasts = []
    for p in parts:
        if "," in p:
            last = p.split(",", 1)[0].strip()
        else:
            tokens = p.strip().split()
            last = tokens[-1] if tokens else ""
        last = _AUTHOR_CLEAN_RE.sub("", last.lower()).strip()
        if last:
            lasts.append(last)
    return lasts


def first_author_last(authors) -> Optional[str]:
    """Return first last name from parse_authors() result, or None."""
    lasts = parse_authors(authors)
    return lasts[0] if lasts else None
