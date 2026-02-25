"""
Tiered cluster builder for human-centered deduplication.

Implements a three-tier matching strategy:
  Tier 1 — Exact identifiers: DOI, PMID
  Tier 2 — Strong bibliographic: exact normalized title+year (or title+author+year)
  Tier 3 — Probable match: fuzzy title similarity (rapidfuzz) + optional author check

Algorithm: Union-Find (disjoint-set) for O(n·α(n)) clustering.
Determinism: all passes process records in sorted UUID order; tie-breaking
             in _pick_best() is by created_at then id.

Usage:
    config = StrategyConfig.from_preset("doi_first_strict")
    builder = TieredClusterBuilder(config)
    clusters = builder.compute_clusters(sources)

    # For preview (no DB writes):
    preview = builder.preview(sources)
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Optional

from app.utils.match_keys import StrategyConfig, TieredMatchResult, normalize_title, normalize_first_author


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class SourceRecord:
    """
    Flattened representation of a record_source row suitable for clustering.
    All fields come from the record_sources table or its raw_data JSONB.
    """
    id: uuid.UUID                    # record_sources.id
    old_record_id: uuid.UUID         # current records.id pointer
    norm_title: Optional[str]        # precomputed in record_sources
    norm_first_author: Optional[str] # precomputed in record_sources
    match_year: Optional[int]        # precomputed in record_sources
    match_doi: Optional[str]         # precomputed in record_sources
    pmid: Optional[str]              # from raw_data->>'pmid' or source_record_id
    authors: Optional[list]          # raw author strings for overlap check
    raw_data: dict = field(default_factory=dict)


@dataclass
class Cluster:
    """A group of SourceRecords that should map to one canonical record."""
    representative: SourceRecord     # best-quality source (picked by _pick_best)
    members: list[SourceRecord]      # all sources in the cluster
    match_tier: int                  # highest (most precise) tier used to form cluster
    match_basis: str                 # 'tier1_doi' | 'tier1_pmid' | 'tier2_...' | 'tier3_fuzzy' | 'none'
    match_reason: str                # human-readable explanation
    similarity_score: Optional[float]  # tier 3 only

    @property
    def size(self) -> int:
        return len(self.members)


@dataclass
class PreviewResult:
    """Result of a preview run (no DB writes)."""
    clusters: list[Cluster]          # only clusters with >1 member (true duplicates)
    isolated: list[SourceRecord]     # sources with no match (cluster size=1)
    would_merge: int                 # total sources that would change canonical record
    would_remain: int                # canonical records after dedup
    tier1_count: int
    tier2_count: int
    tier3_count: int


# ---------------------------------------------------------------------------
# Union-Find (disjoint-set) with path compression and union by rank
# ---------------------------------------------------------------------------

class _UnionFind:
    def __init__(self, ids: list[uuid.UUID]):
        self._parent = {i: i for i in ids}
        self._rank = {i: 0 for i in ids}
        # Track which tier united each element (0 = not yet united)
        self._tier: dict[uuid.UUID, int] = {i: 0 for i in ids}
        self._basis: dict[uuid.UUID, str] = {i: "none" for i in ids}
        self._reason: dict[uuid.UUID, str] = {i: "" for i in ids}
        self._score: dict[uuid.UUID, Optional[float]] = {i: None for i in ids}

    def find(self, x: uuid.UUID) -> uuid.UUID:
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]  # path compression
            x = self._parent[x]
        return x

    def union(
        self,
        a: uuid.UUID,
        b: uuid.UUID,
        tier: int,
        basis: str,
        reason: str,
        score: Optional[float] = None,
    ) -> bool:
        """
        Unite the sets containing a and b.
        Returns True if they were in different sets (a merge occurred).
        """
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False  # already in same cluster

        # Union by rank
        if self._rank[ra] < self._rank[rb]:
            ra, rb = rb, ra

        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1

        # Record tier/basis on the root — use the *most precise* tier seen
        if tier < self._tier[ra] or self._tier[ra] == 0:
            self._tier[ra] = tier
            self._basis[ra] = basis
            self._reason[ra] = reason
            self._score[ra] = score
        return True

    def clusters(self, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[uuid.UUID]]:
        """Return a mapping of root → list of members."""
        groups: dict[uuid.UUID, list[uuid.UUID]] = {}
        for i in ids:
            root = self.find(i)
            groups.setdefault(root, []).append(i)
        return groups


# ---------------------------------------------------------------------------
# Tiered Cluster Builder
# ---------------------------------------------------------------------------

class TieredClusterBuilder:
    """
    Builds dedup clusters from a list of SourceRecords using a configurable
    three-tier strategy.

    All passes operate on a stable sorted order of source IDs for determinism.
    """

    def __init__(self, config: StrategyConfig):
        self.config = config

    def compute_clusters(self, sources: list[SourceRecord]) -> list[Cluster]:
        """
        Cluster sources into groups of duplicates.

        Returns a list of Cluster objects — one per unique canonical record.
        Isolated sources (no match) appear as single-member clusters.
        """
        if not sources:
            return []

        # Sort for determinism
        sorted_sources = sorted(sources, key=lambda s: s.id)
        ids = [s.id for s in sorted_sources]
        by_id = {s.id: s for s in sorted_sources}

        uf = _UnionFind(ids)

        # Pass 1a: DOI exact match
        if self.config.use_doi:
            _union_by_key(
                uf, sorted_sources,
                key_fn=lambda s: s.match_doi,
                tier=1, basis="tier1_doi",
                reason_fn=lambda doi: f"Exact DOI: {doi}",
            )

        # Pass 1b: PMID exact match
        if self.config.use_pmid:
            _union_by_key(
                uf, sorted_sources,
                key_fn=lambda s: s.pmid,
                tier=1, basis="tier1_pmid",
                reason_fn=lambda pmid: f"Exact PMID: {pmid}",
            )

        # Pass 2a: exact title + year
        if self.config.use_title_year:
            _union_by_key(
                uf, sorted_sources,
                key_fn=lambda s: (
                    f"{s.norm_title}|{s.match_year}"
                    if s.norm_title and s.match_year else None
                ),
                tier=2, basis="tier2_title_year",
                reason_fn=lambda k: f"Exact title + year: {k.split('|')[0]!r} ({k.split('|')[1]})",
            )

        # Pass 2b: exact title + author + year
        if self.config.use_title_author_year:
            _union_by_key(
                uf, sorted_sources,
                key_fn=lambda s: (
                    f"{s.norm_title}|{s.norm_first_author}|{s.match_year}"
                    if s.norm_title and s.norm_first_author and s.match_year else None
                ),
                tier=2, basis="tier2_title_author_year",
                reason_fn=lambda k: (
                    f"Exact title + author + year: {k.split('|')[0]!r}"
                ),
            )

        # Pass 3: fuzzy title similarity (rapidfuzz)
        if self.config.use_fuzzy:
            _fuzzy_union(uf, sorted_sources, self.config)

        # Build Cluster objects
        groups = uf.clusters(ids)
        result: list[Cluster] = []

        for root, member_ids in groups.items():
            member_sources = [by_id[mid] for mid in sorted(member_ids)]

            tier = uf._tier[root]
            basis = uf._basis[root]
            reason = uf._reason[root]
            score = uf._score[root]

            if len(member_ids) == 1 and tier == 0:
                # Isolated — no match found
                basis = "none"
                reason = "No match found"

            best = _pick_best(member_sources)
            result.append(Cluster(
                representative=best,
                members=member_sources,
                match_tier=tier,
                match_basis=basis,
                match_reason=reason,
                similarity_score=score,
            ))

        return result

    def preview(self, sources: list[SourceRecord]) -> PreviewResult:
        """
        Compute clusters without any DB writes.
        Returns a PreviewResult summarizing what would happen on a real dedup run.
        """
        clusters = self.compute_clusters(sources)

        duplicates = [c for c in clusters if c.size > 1]
        isolated = [c.representative for c in clusters if c.size == 1]

        would_merge = sum(c.size - 1 for c in duplicates)
        would_remain = len(clusters)

        tier1_count = sum(1 for c in duplicates if c.match_tier == 1)
        tier2_count = sum(1 for c in duplicates if c.match_tier == 2)
        tier3_count = sum(1 for c in duplicates if c.match_tier == 3)

        return PreviewResult(
            clusters=duplicates,
            isolated=isolated,
            would_merge=would_merge,
            would_remain=would_remain,
            tier1_count=tier1_count,
            tier2_count=tier2_count,
            tier3_count=tier3_count,
        )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _union_by_key(
    uf: _UnionFind,
    sources: list[SourceRecord],
    key_fn,
    tier: int,
    basis: str,
    reason_fn,
) -> None:
    """Group sources by key_fn and union each group."""
    groups: dict[str, list[uuid.UUID]] = {}
    for s in sources:
        k = key_fn(s)
        if k:
            groups.setdefault(k, []).append(s.id)

    for key, ids in groups.items():
        if len(ids) < 2:
            continue
        first = ids[0]
        reason = reason_fn(key)
        for other in ids[1:]:
            uf.union(first, other, tier=tier, basis=basis, reason=reason)


def _fuzzy_union(
    uf: _UnionFind,
    sources: list[SourceRecord],
    config: StrategyConfig,
) -> None:
    """
    Tier 3: fuzzy title similarity pass using rapidfuzz.

    Only considers pairs that are in different clusters after tiers 1+2
    and both have a norm_title. Processes pairs in sorted order for
    determinism. Author overlap check is applied when enabled.
    """
    try:
        from rapidfuzz import fuzz
    except ImportError:
        return  # rapidfuzz not available — skip tier 3 gracefully

    # Only sources with a norm_title can participate in fuzzy matching
    candidates = [s for s in sources if s.norm_title]
    if len(candidates) < 2:
        return

    threshold = config.fuzzy_threshold

    # Compare all pairs (O(n²)); acceptable for research-scale datasets
    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            a, b = candidates[i], candidates[j]

            # Skip pairs already in the same cluster
            if uf.find(a.id) == uf.find(b.id):
                continue

            # Fuzzy title comparison (token_set_ratio handles word reordering)
            score = fuzz.token_set_ratio(a.norm_title, b.norm_title) / 100.0
            if score < threshold:
                continue

            # Optional author overlap check
            if config.fuzzy_author_check and not _authors_overlap(a.authors, b.authors):
                continue

            reason = (
                f"Fuzzy title match ({score:.0%}): "
                f"{a.norm_title!r} ≈ {b.norm_title!r}"
            )
            uf.union(
                a.id, b.id,
                tier=3, basis="tier3_fuzzy",
                reason=reason, score=round(score, 4),
            )


def _authors_overlap(
    authors_a: Optional[list],
    authors_b: Optional[list],
) -> bool:
    """
    Return True if the two author lists share at least one normalized last name.
    Normalization: lowercase, keep alpha + space, strip non-alpha.
    """
    if not authors_a or not authors_b:
        return False

    def _surnames(authors: list) -> set[str]:
        result = set()
        for a in authors:
            if not isinstance(a, str):
                continue
            last = a.split(",", 1)[0] if "," in a else (a.split()[-1] if a.split() else a)
            last = last.lower().strip()
            import re
            last = re.sub(r"[^a-z\s]", "", last).strip()
            if last:
                result.add(last)
        return result

    return bool(_surnames(authors_a) & _surnames(authors_b))


def _pick_best(sources: list[SourceRecord]) -> SourceRecord:
    """
    Choose the canonical representative from a cluster.

    Priority:
      1. Has a DOI
      2. Has a title
      3. Has an abstract (from raw_data)
      4. First in deterministic (sorted by id) order
    """
    def _score(s: SourceRecord) -> tuple:
        has_doi = 1 if s.match_doi else 0
        has_title = 1 if s.norm_title else 0
        has_abstract = 1 if s.raw_data.get("abstract") else 0
        return (has_doi, has_title, has_abstract)

    return max(sources, key=_score)
