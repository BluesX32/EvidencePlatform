"""
Shared types and utilities for all parsers.

ParseResult is the single return type from every parser and the dispatcher.
It carries both successfully parsed records and per-record errors, so a single
corrupt entry never aborts the entire import job.

Utilities exported here (normalize_doi, _is_useful_record) are used by both
the RIS and MEDLINE parsers to keep normalization consistent.
"""
from __future__ import annotations

import re as _re
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class RecordError:
    """A per-record parse failure.  Not fatal — other records are still processed."""
    index: int           # 0-based position in the file (order of appearance)
    reason: str          # human-readable description of why the record failed
    raw_snippet: str     # first 200 chars of the raw record block for debugging


@dataclass
class ParseResult:
    """
    Unified result from any parser.

    ``records`` carries normalized dicts in the same shape produced by
    ``app.parsers.ris._normalize()`` — every downstream consumer (import
    service, RecordRepo.upsert_and_link) can treat them identically regardless
    of which parser produced them.
    """
    records: List[dict]
    errors: List[RecordError]
    format_detected: str    # "ris" | "medline" | "csv" | "unknown"
    total_attempted: int
    valid_count: int
    failed_count: int
    warnings: List[str] = field(default_factory=list)  # file-level issues

    @property
    def has_warnings(self) -> bool:
        return bool(self.errors) or bool(self.warnings)

    def error_summary(self) -> str:
        """
        Short human-readable summary of failures.
        Written to import_jobs.error_msg on complete-with-warnings or failure.
        """
        parts: list[str] = []
        if self.valid_count == 0:
            parts.append(
                f"No valid records found in {self.format_detected!r} file."
            )
        else:
            parts.append(
                f"{self.valid_count} record(s) imported"
                + (f" from {self.format_detected.upper()} format" if self.format_detected not in ("unknown",) else "")
                + "."
            )

        if self.failed_count:
            lines = [f"{self.failed_count} record(s) skipped:"]
            for e in self.errors[:10]:  # cap summary at 10 entries
                lines.append(f"  [{e.index}] {e.reason}")
            if len(self.errors) > 10:
                lines.append(f"  … and {len(self.errors) - 10} more")
            parts.append("\n".join(lines))

        if self.warnings:
            parts.append("Warnings: " + "; ".join(self.warnings))

        return "\n".join(parts)


# ── Shared normalization utilities ────────────────────────────────────────────

def normalize_doi(doi: Optional[str]) -> Optional[str]:
    """
    Return a normalized DOI string for consistent dedup matching.

    Transformations applied (in order):
      1. Strip leading/trailing whitespace.
      2. Lowercase.
      3. Strip "doi:" prefix (e.g. "doi:10.1234/x" → "10.1234/x").
      4. Strip URL prefix (https://doi.org/ or http://dx.doi.org/).

    Returns None for blank/None input.
    """
    if not doi:
        return None
    doi = doi.strip().lower()
    if doi.startswith("doi:"):
        doi = doi[4:].strip()
    doi = _re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi)
    return doi or None


def _is_useful_record(rec: dict) -> bool:
    """
    Return True if a parsed record has enough information to be worth storing.

    A record is dropped only when it has *both*:
      - no title (or an empty title), AND
      - no usable identifier (DOI or source_record_id such as PMID/EID).

    Records with a title but no DOI are kept (they can still match on
    title+year).  Records with a DOI but no title are kept (they can match on
    DOI alone).
    """
    has_title = bool(rec.get("title"))
    has_doi = bool(rec.get("doi"))
    has_id = bool((rec.get("raw_data") or {}).get("source_record_id"))
    return has_title or has_doi or has_id
