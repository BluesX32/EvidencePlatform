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
"""
from __future__ import annotations

import re
from typing import Literal

# Maximum bytes examined for format detection (first 4 KB is always enough)
_PROBE_BYTES = 4096

FormatStr = Literal["ris", "medline", "csv", "unknown"]

# RIS: record type tag — the very first meaningful line in any RIS file
_RIS_RE = re.compile(r"^TY\s{2}-", re.MULTILINE)

# MEDLINE: PubMed MEDLINE format always starts with PMID-
_MEDLINE_RE = re.compile(r"^PMID-\s", re.MULTILINE)

# A secondary MEDLINE heuristic: several standard 4-char MEDLINE tags
_MEDLINE_TAGS_RE = re.compile(
    r"^(AU  -|TI  -|AB  -|DP  -|MH  -|FAU -|PT  -)", re.MULTILINE
)


def _decode_probe(file_bytes: bytes) -> str:
    """
    Decode the first _PROBE_BYTES of the file for pattern matching.
    Strips BOM and normalises CRLF → LF.
    """
    probe = file_bytes[:_PROBE_BYTES]
    # Strip UTF-8 BOM (\xef\xbb\xbf)
    if probe.startswith(b"\xef\xbb\xbf"):
        probe = probe[3:]
    text = probe.decode("utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


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

    # 1. RIS: any line that is exactly "TY  -" (type tag)
    if _RIS_RE.search(text):
        return "ris"

    # 2. MEDLINE/PubMed: line starting with "PMID- "
    if _MEDLINE_RE.search(text):
        return "medline"

    # 3. MEDLINE secondary heuristic: multiple standard tags (AU, TI, AB…)
    #    covers files that start with a preamble before PMID
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
        full_text = file_bytes.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        entries = rispy.loads(full_text)
        if entries:
            return "ris"
    except Exception:
        pass

    return "unknown"
