"""Normalization and match-key computation for flexible deduplication.

All functions are pure (no I/O) and suitable for unit testing.

Presets
-------
doi_first_strict   DOI if present; else title + first-author + year
doi_first_medium   DOI if present; else title + year
strict             title + first-author + year (ignores DOI)
medium             title + year
loose              title + first-author (no year)
"""
import re
import unicodedata
from typing import Optional

# ---------------------------------------------------------------------------
# Stop words removed from title normalization
# ---------------------------------------------------------------------------
_STOP_WORDS: frozenset[str] = frozenset(
    {
        "a", "an", "the", "of", "in", "on", "at", "for", "by",
        "and", "or", "with", "to", "from", "is", "are", "was", "were",
    }
)

_PUNCTUATION_RE = re.compile(r"[^\w\s]")
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_title(raw: Optional[str]) -> Optional[str]:
    """Return a normalized title string suitable for match-key construction.

    Steps:
    1. Unicode NFC
    2. Lowercase
    3. Strip punctuation (keep alphanumeric + whitespace)
    4. Remove stop words
    5. Collapse whitespace, strip
    6. Truncate to 200 characters

    Returns None if the input is None or produces an empty string.
    """
    if not raw:
        return None
    text = unicodedata.normalize("NFC", raw)
    text = text.lower()
    text = _PUNCTUATION_RE.sub(" ", text)
    tokens = _WHITESPACE_RE.split(text.strip())
    tokens = [t for t in tokens if t and t not in _STOP_WORDS]
    result = " ".join(tokens)[:200].strip()
    return result if result else None


def normalize_first_author(authors: Optional[list]) -> Optional[str]:
    """Return a normalized first-author last-name string.

    Strategy:
    - Take the first element of the authors list.
    - If it contains a comma, everything before the first comma is the last name.
    - Otherwise, the last whitespace-delimited token is the last name.
    - Lowercase; keep compound names (e.g. "van den berg"); strip non-alpha chars
      except internal whitespace.

    Returns None if authors is empty/None or produces an empty string.
    """
    if not authors:
        return None
    first = authors[0]
    if not isinstance(first, str) or not first.strip():
        return None

    if "," in first:
        last_part = first.split(",", 1)[0]
    else:
        tokens = first.strip().split()
        last_part = tokens[-1] if tokens else first

    # Lowercase, remove non-alpha/non-space characters, collapse whitespace
    last_part = last_part.lower()
    last_part = re.sub(r"[^a-z\s]", "", last_part)
    last_part = _WHITESPACE_RE.sub(" ", last_part).strip()
    return last_part if last_part else None


def compute_match_key(
    norm_title: Optional[str],
    norm_first_author: Optional[str],
    year: Optional[int],
    doi: Optional[str],
    preset: str,
) -> tuple[Optional[str], str]:
    """Return (match_key, match_basis) for the given fields and preset.

    match_key is None when no dedup key can be computed (record stays isolated).
    match_basis describes which fields were used: 'doi', 'title_author_year',
    'title_year', 'title_author', or 'none'.
    """
    doi_key = f"doi:{doi}" if doi else None

    if preset in ("doi_first_strict", "doi_first_medium"):
        if doi_key:
            return doi_key, "doi"
        # Fallback based on preset
        if preset == "doi_first_strict":
            if norm_title and norm_first_author and year:
                return (
                    f"tay:{norm_title}|{norm_first_author}|{year}",
                    "title_author_year",
                )
        else:  # doi_first_medium
            if norm_title and year:
                return f"ty:{norm_title}|{year}", "title_year"
        return None, "none"

    if preset == "strict":
        if norm_title and norm_first_author and year:
            return (
                f"tay:{norm_title}|{norm_first_author}|{year}",
                "title_author_year",
            )
        return None, "none"

    if preset == "medium":
        if norm_title and year:
            return f"ty:{norm_title}|{year}", "title_year"
        return None, "none"

    if preset == "loose":
        if norm_title and norm_first_author:
            return f"ta:{norm_title}|{norm_first_author}", "title_author"
        return None, "none"

    return None, "none"
