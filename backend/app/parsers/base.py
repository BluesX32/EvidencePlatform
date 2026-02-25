"""
Shared types for all parsers.

ParseResult is the single return type from every parser and the dispatcher.
It carries both successfully parsed records and per-record errors, so a single
corrupt entry never aborts the entire import job.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


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
