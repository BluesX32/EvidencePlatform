"""Normalization and match-key computation for flexible deduplication.

All functions are pure (no I/O) and suitable for unit testing.

Presets (legacy — kept for backward compatibility)
-------
doi_first_strict   DOI if present; else title + first-author + year
doi_first_medium   DOI if present; else title + year
strict             title + first-author + year (ignores DOI)
medium             title + year
loose              title + first-author (no year)

StrategyConfig (new — human-centered tiered dedup)
-------
Stored in match_strategies.config JSONB.
Controls which tiers the TieredClusterBuilder activates.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, asdict
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


# ---------------------------------------------------------------------------
# StrategyConfig — human-centered tiered dedup configuration
# ---------------------------------------------------------------------------

# Preset → StrategyConfig mapping (backward compatible)
_PRESET_TO_CONFIG: dict[str, dict] = {
    "doi_first_strict": {
        "use_doi": True, "use_pmid": True,
        "use_title_year": False, "use_title_author_year": True,
        "use_fuzzy": False, "fuzzy_threshold": 0.85, "fuzzy_author_check": True,
    },
    "doi_first_medium": {
        "use_doi": True, "use_pmid": True,
        "use_title_year": True, "use_title_author_year": False,
        "use_fuzzy": False, "fuzzy_threshold": 0.85, "fuzzy_author_check": True,
    },
    "strict": {
        "use_doi": False, "use_pmid": False,
        "use_title_year": False, "use_title_author_year": True,
        "use_fuzzy": False, "fuzzy_threshold": 0.85, "fuzzy_author_check": True,
    },
    "medium": {
        "use_doi": False, "use_pmid": False,
        "use_title_year": True, "use_title_author_year": False,
        "use_fuzzy": False, "fuzzy_threshold": 0.85, "fuzzy_author_check": True,
    },
    "loose": {
        "use_doi": False, "use_pmid": False,
        "use_title_year": True, "use_title_author_year": False,
        "use_fuzzy": False, "fuzzy_threshold": 0.80, "fuzzy_author_check": False,
    },
}


@dataclass
class StrategyConfig:
    """
    Human-centered tiered dedup configuration.

    Stored in match_strategies.config JSONB (no schema change).
    Controls which tiers TieredClusterBuilder activates.

    Tier 1 — Exact identifiers:
      use_doi  : match on exact normalized DOI
      use_pmid : match on exact PMID (from raw_data['pmid'])

    Tier 2 — Strong bibliographic match:
      use_title_year        : normalized title + year
      use_title_author_year : normalized title + first author + year

    Tier 3 — Probable match (fuzzy):
      use_fuzzy         : enable fuzzy title similarity matching
      fuzzy_threshold   : minimum ratio (0.0–1.0) to call a match
      fuzzy_author_check: if True, require ≥1 shared author surname
    """
    use_doi: bool = True
    use_pmid: bool = True
    use_title_year: bool = True
    use_title_author_year: bool = True
    use_fuzzy: bool = False
    fuzzy_threshold: float = 0.85
    fuzzy_author_check: bool = True

    @classmethod
    def from_preset(cls, preset: str) -> "StrategyConfig":
        """Build a StrategyConfig from a legacy preset name."""
        cfg = _PRESET_TO_CONFIG.get(preset)
        if cfg is None:
            return cls()  # unknown preset → safe defaults
        return cls(**cfg)

    @classmethod
    def from_dict(cls, d: dict) -> "StrategyConfig":
        """Build a StrategyConfig from a dict (e.g., from JSONB column)."""
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        filtered = {k: v for k, v in d.items() if k in known}
        return cls(**filtered)

    def to_dict(self) -> dict:
        """Serialize to a plain dict for storage in JSONB."""
        return asdict(self)


# ---------------------------------------------------------------------------
# TieredMatchResult — result of a tiered cluster match
# ---------------------------------------------------------------------------

@dataclass
class TieredMatchResult:
    """
    Result of assigning a record-source to a dedup cluster.

    match_tier:
      0 = isolated (no match possible)
      1 = exact identifier (DOI or PMID)
      2 = exact bibliographic (title+year or title+author+year)
      3 = fuzzy title similarity

    match_basis: encoded string stored in records.match_basis and match_log.match_basis.
      Values: 'tier1_doi', 'tier1_pmid', 'tier2_title_year',
              'tier2_title_author_year', 'tier3_fuzzy', 'none'
      All values fit within VARCHAR(50).
    """
    match_key: Optional[str]           # cluster key; None = isolated
    match_tier: int                    # 0–3 as described above
    match_basis: str                   # stored in DB column
    match_reason: str                  # human-readable explanation
    similarity_score: Optional[float]  # tier 3 only; None otherwise
