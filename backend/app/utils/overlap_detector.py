"""
Overlap Detector — 5-tier deterministic field-based duplicate/overlap detection.

Replaces the old TieredClusterBuilder usage in overlap_service.py. The dedup
system (dedup_service.py) continues to use TieredClusterBuilder unchanged.

Algorithm overview
------------------
Three blocking passes share a single Union-Find structure:

Pass 1 — Exact ID blocks
    Group by DOI (if "doi" in selected_fields).
    Group by PMID (if "pmid" in selected_fields).
    All pairs inside a block → merge at tier 1.

Pass 2 — Title-Year blocks  (if "title" in selected_fields)
    Group by (norm_title[:15], year).
    Within each block, try tier 2 → 3 → 4 in order for each pair
    not already merged at tier 1.
      Tier 2: norm_title == norm_title AND year_match
              AND first_author == first_author
              AND (volume == volume if both present)
      Tier 3: norm_title == norm_title AND year_match
              AND first_author == first_author
      Tier 4: norm_title == norm_title AND year_match

Pass 3 — Fuzzy title blocks  (only if fuzzy_enabled)
    Group by norm_title[:15].
    Within each block, for pairs not already merged:
      token_set_ratio / 100 >= fuzzy_threshold
      AND abs(year_a - year_b) <= year_tolerance
      AND shared author last names >= 1
    Merged at tier 5.

Representative selection
    The canonical member is the one with the most non-null fields,
    ranked by: doi > pmid > norm_title > abstract_len.
    Tie-break: lexicographic sort of record_source_id (UUID string).
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from app.utils.overlap_utils import (
    normalize_title_for_overlap,
    extract_year,
    normalize_volume,
    parse_authors,
    first_author_last,
)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class OverlapConfig:
    """Controls which fields and tiers are active during overlap detection."""
    selected_fields: list  # subset of KNOWN_FIELDS
    fuzzy_enabled:   bool  = False
    fuzzy_threshold: float = 0.93
    year_tolerance:  int   = 0   # 0 = exact year match; 1 = ±1 year

    KNOWN_FIELDS = [
        "doi", "pmid", "title", "year",
        "first_author", "all_authors", "volume", "pages", "journal",
    ]

    @classmethod
    def default(cls) -> "OverlapConfig":
        return cls(selected_fields=["doi", "pmid", "title", "year", "first_author", "volume"])

    @classmethod
    def from_dict(cls, d: dict) -> "OverlapConfig":
        return cls(
            selected_fields=list(d.get("selected_fields", cls.default().selected_fields)),
            fuzzy_enabled=bool(d.get("fuzzy_enabled", False)),
            fuzzy_threshold=float(d.get("fuzzy_threshold", 0.93)),
            year_tolerance=int(d.get("year_tolerance", 0)),
        )

    def to_dict(self) -> dict:
        return {
            "selected_fields": list(self.selected_fields),
            "fuzzy_enabled": self.fuzzy_enabled,
            "fuzzy_threshold": self.fuzzy_threshold,
            "year_tolerance": self.year_tolerance,
        }


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class OverlapRecord:
    """Normalised view of one record_source row for overlap detection."""
    record_source_id: uuid.UUID
    source_id:        uuid.UUID
    doi:              Optional[str]
    pmid:             Optional[str]
    norm_title:       str
    title_prefix:     str            # norm_title[:15]
    year:             Optional[int]
    first_author:     Optional[str]
    all_author_lasts: list
    norm_volume:      Optional[str]
    raw_pages:        Optional[str]
    raw_journal:      Optional[str]
    # For representative scoring
    abstract_len:     int = 0


@dataclass
class DetectedCluster:
    """Result of one detected duplicate/overlap group."""
    records:          list             # list[OverlapRecord]
    tier:             int              # 1–5
    match_basis:      str
    match_reason:     str
    similarity_score: Optional[float] = None   # tier 5 only


# ---------------------------------------------------------------------------
# Helper: convert DB rows to OverlapRecord objects
# ---------------------------------------------------------------------------

def _build_overlap_records(rs_rows) -> list:
    """
    Convert query result rows into OverlapRecord objects.

    Expected row attributes:
        id, source_id, norm_title, match_doi, match_year, match_year, raw_data
    raw_data may contain: authors, pmid, source_record_id, abstract, volume, pages, journal
    """
    result = []
    for row in rs_rows:
        raw = row.raw_data or {}
        doi = row.match_doi
        pmid_raw = raw.get("pmid") or raw.get("source_record_id")
        pmid = str(pmid_raw).strip() if pmid_raw else None

        authors_raw = raw.get("authors")
        norm_t = normalize_title_for_overlap(row.norm_title or raw.get("title"))
        year   = extract_year(row.match_year or raw.get("year"))
        vol    = normalize_volume(raw.get("volume"))

        abstract = raw.get("abstract") or ""
        abstract_len = len(abstract)

        result.append(OverlapRecord(
            record_source_id=row.id,
            source_id=row.source_id,
            doi=doi,
            pmid=pmid,
            norm_title=norm_t,
            title_prefix=norm_t[:15],
            year=year,
            first_author=first_author_last(authors_raw),
            all_author_lasts=parse_authors(authors_raw),
            norm_volume=vol,
            raw_pages=str(raw.get("pages") or "") or None,
            raw_journal=str(raw.get("journal") or "") or None,
            abstract_len=abstract_len,
        ))
    return result


# ---------------------------------------------------------------------------
# Union-Find
# ---------------------------------------------------------------------------

class _UnionFind:
    """Path-compressed, rank-based Union-Find with per-root tier tracking."""

    def __init__(self, ids):
        self._parent = {i: i for i in ids}
        self._rank   = {i: 0 for i in ids}
        self._tier   = {}  # root → (tier, basis, reason)

    def find(self, x):
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]
            x = self._parent[x]
        return x

    def union(self, a, b, tier: int, basis: str, reason: str):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self._rank[ra] < self._rank[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1
        # Store lowest tier (most specific match) seen for this root
        if ra not in self._tier or tier < self._tier[ra][0]:
            self._tier[ra] = (tier, basis, reason)

    def groups(self):
        """Return dict: root → list of members."""
        groups = defaultdict(list)
        for x in self._parent:
            groups[self.find(x)].append(x)
        return dict(groups)

    def tier_info(self, root):
        return self._tier.get(root, (5, "unknown", "unknown"))


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

class OverlapDetector:
    """Deterministic 5-tier overlap detector with blocking keys."""

    def __init__(self, config: OverlapConfig):
        self.config = config

    def detect(self, records: list) -> list:
        """
        Run detection on a list of OverlapRecord objects.
        Returns list[DetectedCluster] for groups of size >= 2.
        """
        if len(records) < 2:
            return []

        ids = [r.record_source_id for r in records]
        rec_map = {r.record_source_id: r for r in records}
        uf = _UnionFind(ids)
        fields = set(self.config.selected_fields)

        # ── Pass 1: Exact ID blocks ───────────────────────────────────────────
        if "doi" in fields:
            doi_buckets: dict = defaultdict(list)
            for r in records:
                if r.doi:
                    doi_buckets[r.doi.lower()].append(r.record_source_id)
            for doi_val, members in doi_buckets.items():
                if len(members) < 2:
                    continue
                basis = "doi"
                reason = f"Exact DOI match: {doi_val}"
                first = members[0]
                for other in members[1:]:
                    uf.union(first, other, 1, basis, reason)

        if "pmid" in fields:
            pmid_buckets: dict = defaultdict(list)
            for r in records:
                if r.pmid:
                    pmid_buckets[r.pmid].append(r.record_source_id)
            for pmid_val, members in pmid_buckets.items():
                if len(members) < 2:
                    continue
                basis = "pmid"
                reason = f"Exact PMID match: {pmid_val}"
                first = members[0]
                for other in members[1:]:
                    uf.union(first, other, 1, basis, reason)

        # ── Pass 2: Title-Year blocks ─────────────────────────────────────────
        if "title" in fields:
            ty_buckets: dict = defaultdict(list)
            for r in records:
                if r.title_prefix and r.year is not None:
                    key = (r.title_prefix, r.year)
                    ty_buckets[key].append(r.record_source_id)
                elif r.title_prefix:
                    # allow year-less records in same prefix bucket only if year not required
                    if "year" not in fields:
                        ty_buckets[(r.title_prefix, None)].append(r.record_source_id)

            for _key, bucket in ty_buckets.items():
                if len(bucket) < 2:
                    continue
                bucket_records = [rec_map[i] for i in bucket]
                self._match_title_year_block(bucket_records, uf, fields)

        # ── Pass 3: Fuzzy title blocks ─────────────────────────────────────────
        if self.config.fuzzy_enabled and "title" in fields:
            try:
                from rapidfuzz import fuzz as _fuzz
            except ImportError:
                _fuzz = None

            if _fuzz is not None:
                prefix_buckets: dict = defaultdict(list)
                for r in records:
                    if r.title_prefix:
                        prefix_buckets[r.title_prefix].append(r.record_source_id)

                for _prefix, bucket in prefix_buckets.items():
                    if len(bucket) < 2:
                        continue
                    bucket_records = [rec_map[i] for i in bucket]
                    self._match_fuzzy_block(bucket_records, uf, _fuzz)

        # ── Collect clusters ──────────────────────────────────────────────────
        groups = uf.groups()
        clusters = []
        for root, member_ids in groups.items():
            if len(member_ids) < 2:
                continue
            tier_info = uf.tier_info(root)
            tier, basis, reason = tier_info
            cluster_records = [rec_map[mid] for mid in member_ids]
            clusters.append(DetectedCluster(
                records=cluster_records,
                tier=tier,
                match_basis=basis,
                match_reason=reason,
            ))

        # Sort for determinism
        clusters.sort(key=lambda c: min(str(r.record_source_id) for r in c.records))
        return clusters

    def _year_match(self, ya: Optional[int], yb: Optional[int]) -> bool:
        if ya is None or yb is None:
            return False
        return abs(ya - yb) <= self.config.year_tolerance

    def _match_title_year_block(self, bucket_records: list, uf: _UnionFind, fields: set):
        """Try tiers 2, 3, 4 for all pairs in a title-year bucket."""
        use_year   = "year" in fields
        use_author = "first_author" in fields
        use_volume = "volume" in fields

        for i, ra in enumerate(bucket_records):
            for rb in bucket_records[i + 1:]:
                # Skip pairs already merged at tier 1
                if uf.find(ra.record_source_id) == uf.find(rb.record_source_id):
                    continue

                # Both must have the same norm_title (the prefix matched, now check full)
                if ra.norm_title != rb.norm_title or not ra.norm_title:
                    continue

                year_ok = (not use_year) or self._year_match(ra.year, rb.year)
                if not year_ok:
                    continue

                author_ok = (
                    (not use_author)
                    or (ra.first_author is not None
                        and ra.first_author == rb.first_author)
                )

                volume_ok = (
                    (not use_volume)
                    or ra.norm_volume is None
                    or rb.norm_volume is None
                    or ra.norm_volume == rb.norm_volume
                )

                if author_ok and volume_ok:
                    # Tier 2: title + year + author + volume
                    uf.union(
                        ra.record_source_id, rb.record_source_id,
                        2,
                        "title_year_author_volume",
                        f"Same title, year, first author, volume: {ra.norm_title!r}",
                    )
                elif author_ok:
                    # Tier 3: title + year + author (volumes differ or missing)
                    uf.union(
                        ra.record_source_id, rb.record_source_id,
                        3,
                        "title_year_author",
                        f"Same title, year, first author: {ra.norm_title!r}",
                    )
                else:
                    # Tier 4: title + year only
                    uf.union(
                        ra.record_source_id, rb.record_source_id,
                        4,
                        "title_year",
                        f"Same title and year: {ra.norm_title!r}",
                    )

    def _match_fuzzy_block(self, bucket_records: list, uf: _UnionFind, fuzz_mod):
        """Try tier 5 fuzzy matching for all pairs in a title-prefix bucket."""
        threshold = self.config.fuzzy_threshold
        tol = self.config.year_tolerance

        for i, ra in enumerate(bucket_records):
            for rb in bucket_records[i + 1:]:
                if uf.find(ra.record_source_id) == uf.find(rb.record_source_id):
                    continue
                if not ra.norm_title or not rb.norm_title:
                    continue

                # Year gate
                if ra.year is not None and rb.year is not None:
                    if abs(ra.year - rb.year) > tol:
                        continue

                # Fuzzy title similarity
                score = fuzz_mod.token_set_ratio(ra.norm_title, rb.norm_title) / 100.0
                if score < threshold:
                    continue

                # Author overlap gate
                shared = set(ra.all_author_lasts) & set(rb.all_author_lasts)
                if not shared:
                    continue

                cluster = DetectedCluster(
                    records=[],  # placeholder; will be filled by union groups
                    tier=5,
                    match_basis="fuzzy_title_author",
                    match_reason=f"Fuzzy title similarity {score:.2f}: {ra.norm_title!r}",
                    similarity_score=score,
                )
                uf.union(
                    ra.record_source_id, rb.record_source_id,
                    5,
                    "fuzzy_title_author",
                    f"Fuzzy title similarity {score:.2f}",
                )


def _richness_score(r: OverlapRecord) -> tuple:
    """Higher = more informative record (used for representative selection)."""
    return (
        1 if r.doi else 0,
        1 if r.pmid else 0,
        1 if r.norm_title else 0,
        r.abstract_len,
        # Stable tie-break: smaller UUID string = preferred
        -ord(str(r.record_source_id)[0]),
    )


def select_representative(cluster_records: list) -> OverlapRecord:
    """Return the most information-rich record as the canonical representative."""
    return max(cluster_records, key=_richness_score)
