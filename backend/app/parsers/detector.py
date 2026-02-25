"""
File format detection for bibliographic exports.

Determines the most likely format of an uploaded file from its content
(not its extension) so the correct parser can be dispatched.

Supported formats:
  ris     — Reference Information System (rispy-compatible)
  medline — MEDLINE/PubMed tagged format (.txt exports from PubMed)
  csv     — Comma-separated (not supported; rejected with message)
  unknown — Cannot determine format

Detection order matters: RIS is checked first because some files open with a
BOM and then "TY  - JOUR" on line 1; MEDLINE is checked second because PubMed
.txt files always open with "PMID-".

Encoding: we try utf-8-sig → utf-8 → latin-1. Latin-1 never fails, so it
serves as a universal fallback for CINAHL/OVID exports that use ISO-8859-1.
"""
from __future__ import annotations

import re
from typing import Literal

# Maximum bytes examined for format detection (first 4 KB is always enough)
_PROBE_BYTES = 4096

FormatStr = Literal["ris", "medline", "csv", "unknown"]

# RIS: record type tag — any spacing between TY and the dash is accepted.
# Standard is "TY  -" (2 spaces) but Scopus/CINAHL may use "TY -" (1 space).
_RIS_RE = re.compile(r"^TY\s+-", re.MULTILINE)

# MEDLINE/PubMed tagged: PMID tag with optional spaces before the value.
# PubMed export: "PMID- 22130746" (space); some tools emit "PMID-22130746" (no space).
_MEDLINE_RE = re.compile(r"^PMID-[ \t]*\d", re.MULTILINE)

# Secondary MEDLINE heuristic: several standard MEDLINE tags with flexible spacing.
# Covers files that start with a preamble before PMID or use non-standard spacing.
_MEDLINE_TAGS_RE = re.compile(
    r"^(AU|TI|AB|DP|MH|FAU|PT)\s+-", re.MULTILINE
)


def _decode_bytes(data: bytes) -> str:
    """
    Decode bytes to a Unicode string, trying common encodings in order.

    Encoding priority:
      1. utf-8-sig — UTF-8 with optional BOM; handles UTF-8 exports from all tools.
      2. utf-8 — Plain UTF-8 without BOM.
      3. latin-1 — ISO-8859-1; never raises; handles CINAHL / OVID / Embase exports.

    CRLF line endings are normalized to LF.
    """
    for encoding in ("utf-8-sig", "utf-8"):
        try:
            text = data.decode(encoding)
            return text.replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeDecodeError:
            continue
    # Latin-1 is a universal fallback — all 256 byte values are valid
    text = data.decode("latin-1")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _decode_probe(file_bytes: bytes) -> str:
    """
    Decode the first _PROBE_BYTES of the file for pattern matching.
    Uses _decode_bytes for encoding detection + CRLF normalisation.
    """
    return _decode_bytes(file_bytes[:_PROBE_BYTES])


def detect_format(file_bytes: bytes) -> FormatStr:
    """
    Inspect file content and return the detected format string.

    Args:
        file_bytes: Raw bytes from the uploaded file (may be partial).

    Returns:
        One of "ris", "medline", "csv", "unknown".
    """
    if not file_bytes:
        return "unknown"

    text = _decode_probe(file_bytes)

    # 1. RIS: any line with "TY" followed by 1+ spaces and a dash
    if _RIS_RE.search(text):
        return "ris"

    # 2. MEDLINE/PubMed: line starting with "PMID-" followed by optional
    #    whitespace and a digit (handles both "PMID- 12345" and "PMID-12345")
    if _MEDLINE_RE.search(text):
        return "medline"

    # 3. MEDLINE secondary heuristic: multiple standard tags (AU, TI, AB…)
    #    covers files that start with a preamble before PMID, or use
    #    non-standard spacing that the primary regex misses
    if len(_MEDLINE_TAGS_RE.findall(text)) >= 3:
        return "medline"

    # 4. CSV: first non-empty line has ≥ 3 commas (simple header detection)
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            if stripped.count(",") >= 3:
                return "csv"
            break  # only check first non-empty line

    # 5. Last resort: try RIS parse on full bytes (rispy is fast even for large files)
    try:
        import rispy
        full_text = _decode_bytes(file_bytes)
        entries = rispy.loads(full_text)
        if entries:
            return "ris"
    except Exception:
        pass

    return "unknown"
