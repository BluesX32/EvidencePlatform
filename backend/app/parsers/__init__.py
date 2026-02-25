"""
Parser package public API.

``parse_file(file_bytes)`` is the main entry point for the import pipeline.
It detects the file format and dispatches to the appropriate tolerant parser,
returning a ParseResult regardless of whether some records are corrupt.

The strict ``ris.parse()`` function is preserved for backward compatibility
and is used by the existing RIS parser tests.
"""
from app.parsers.base import ParseResult, RecordError
from app.parsers.detector import detect_format
from app.parsers import ris, medline


def parse_file(file_bytes: bytes) -> ParseResult:
    """
    Detect format and parse file_bytes into a ParseResult.

    Never raises — all errors are captured in ParseResult.errors or
    ParseResult.warnings. The caller is responsible for deciding whether
    a result with valid_count == 0 should be treated as a failure.

    Supported formats:
      ris     — Reference Information System (.ris, some .txt)
      medline — MEDLINE/PubMed-tagged (.txt from PubMed, Ovid)
      csv     — Rejected with a user-friendly message (not supported)
      unknown — Cannot determine format
    """
    fmt = detect_format(file_bytes)

    if fmt == "ris":
        return ris.parse_tolerant(file_bytes)

    if fmt == "medline":
        return medline.parse_tolerant(file_bytes)

    if fmt == "csv":
        return ParseResult(
            records=[],
            errors=[],
            format_detected="csv",
            total_attempted=0,
            valid_count=0,
            failed_count=1,
            warnings=[
                "CSV format is not supported. "
                "Please export your search results as RIS (.ris) or MEDLINE (.txt) format."
            ],
        )

    # "unknown" — cannot identify format
    return ParseResult(
        records=[],
        errors=[],
        format_detected="unknown",
        total_attempted=0,
        valid_count=0,
        failed_count=1,
        warnings=[
            "Cannot detect file format. "
            "Expected RIS (.ris) or MEDLINE/PubMed-tagged (.txt). "
            "Check that the file was exported from a supported database."
        ],
    )


__all__ = ["parse_file", "ParseResult", "RecordError", "detect_format"]
