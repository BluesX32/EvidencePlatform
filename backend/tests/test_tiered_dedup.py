"""
Tests for the tiered cluster builder (Phase B — human-centered dedup).

These are pure unit tests — no database connection required.
All logic is tested through TieredClusterBuilder.compute_clusters() and
TieredClusterBuilder.preview().

Tier hierarchy:
  Tier 1 — Exact identifiers: DOI, PMID
  Tier 2 — Strong bibliographic: normalized title + year (or + author)
  Tier 3 — Probable match: fuzzy title similarity + optional author overlap
  Tier 0 — Isolated: no matchable fields or no match found
"""
import uuid
from typing import Optional

import pytest

from app.utils.match_keys import StrategyConfig
from app.utils.cluster_builder import TieredClusterBuilder, SourceRecord


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _uid(i: int) -> uuid.UUID:
    """Create a deterministic UUID from an integer."""
    return uuid.UUID(f"00000000-0000-0000-0000-{i:012d}")


def _source(
    i: int,
    norm_title: Optional[str] = None,
    norm_first_author: Optional[str] = None,
    match_year: Optional[int] = None,
    match_doi: Optional[str] = None,
    pmid: Optional[str] = None,
    authors: Optional[list] = None,
    raw_data: Optional[dict] = None,
) -> SourceRecord:
    """Create a SourceRecord with a deterministic UUID."""
    return SourceRecord(
        id=_uid(i),
        old_record_id=_uid(100 + i),
        norm_title=norm_title,
        norm_first_author=norm_first_author,
        match_year=match_year,
        match_doi=match_doi,
        pmid=pmid,
        authors=authors or [],
        raw_data=raw_data or {},
    )


def _config(**kwargs) -> StrategyConfig:
    """Build a StrategyConfig with all tiers disabled by default, then enable as needed."""
    defaults = dict(
        use_doi=False, use_pmid=False,
        use_title_year=False, use_title_author_year=False,
        use_fuzzy=False, fuzzy_threshold=0.85, fuzzy_author_check=True,
    )
    defaults.update(kwargs)
    return StrategyConfig(**defaults)


# ---------------------------------------------------------------------------
# Tier 1: DOI exact match
# ---------------------------------------------------------------------------

def test_tier1_doi_merges_same_doi():
    """Two sources with the same DOI → merged, tier=1, basis='tier1_doi'."""
    a = _source(1, match_doi="10.1234/example")
    b = _source(2, match_doi="10.1234/example")
    config = _config(use_doi=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    c = clusters[0]
    assert c.match_tier == 1
    assert c.match_basis == "tier1_doi"
    assert len(c.members) == 2
    assert "10.1234/example" in c.match_reason


def test_tier1_doi_no_merge_different_doi():
    """Sources with different DOIs → two isolated clusters."""
    a = _source(1, match_doi="10.1234/aaa")
    b = _source(2, match_doi="10.1234/bbb")
    config = _config(use_doi=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2
    assert all(c.match_tier == 0 for c in clusters)


def test_tier1_doi_none_not_grouped():
    """Sources with None DOI are not grouped even when use_doi=True."""
    a = _source(1, match_doi=None)
    b = _source(2, match_doi=None)
    config = _config(use_doi=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2


def test_tier1_doi_three_same_doi():
    """Three sources with the same DOI → one cluster with 3 members."""
    sources = [_source(i, match_doi="10.1234/x") for i in range(1, 4)]
    config = _config(use_doi=True)

    clusters = TieredClusterBuilder(config).compute_clusters(sources)

    assert len(clusters) == 1
    assert clusters[0].size == 3


# ---------------------------------------------------------------------------
# Tier 1: PMID exact match
# ---------------------------------------------------------------------------

def test_tier1_pmid_merges_same_pmid():
    """Two sources with the same PMID → merged, basis='tier1_pmid'."""
    a = _source(1, pmid="12345678")
    b = _source(2, pmid="12345678")
    config = _config(use_pmid=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 1
    assert clusters[0].match_basis == "tier1_pmid"


def test_tier1_pmid_disabled_no_merge():
    """Same PMID but use_pmid=False → not merged."""
    a = _source(1, pmid="12345678")
    b = _source(2, pmid="12345678")
    config = _config(use_pmid=False)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2


# ---------------------------------------------------------------------------
# Tier 2: exact title + year
# ---------------------------------------------------------------------------

def test_tier2_title_year_merges_exact():
    """Same norm_title + year → merged, tier=2, basis='tier2_title_year'."""
    title = "effects mindfulness anxiety depression systematic review"
    a = _source(1, norm_title=title, match_year=2023)
    b = _source(2, norm_title=title, match_year=2023)
    config = _config(use_title_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 2
    assert clusters[0].match_basis == "tier2_title_year"


def test_tier2_title_year_different_year_no_merge():
    """Same title but different year → two isolated clusters."""
    title = "effects mindfulness anxiety systematic review"
    a = _source(1, norm_title=title, match_year=2022)
    b = _source(2, norm_title=title, match_year=2023)
    config = _config(use_title_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2


def test_tier2_title_year_missing_year_no_merge():
    """Sources missing year cannot match on title+year."""
    title = "some title"
    a = _source(1, norm_title=title, match_year=None)
    b = _source(2, norm_title=title, match_year=2023)
    config = _config(use_title_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2


def test_tier2_title_author_year_merges():
    """Same title + first_author + year → merged, basis='tier2_title_author_year'."""
    title = "meta-analysis cognitive behavioural therapy depression"
    a = _source(1, norm_title=title, norm_first_author="smith", match_year=2021)
    b = _source(2, norm_title=title, norm_first_author="smith", match_year=2021)
    config = _config(use_title_author_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_basis == "tier2_title_author_year"


def test_tier2_title_author_year_different_author_no_merge():
    """Same title+year but different authors → not merged on title+author+year."""
    title = "meta-analysis cognitive behavioural therapy depression"
    a = _source(1, norm_title=title, norm_first_author="smith", match_year=2021)
    b = _source(2, norm_title=title, norm_first_author="jones", match_year=2021)
    config = _config(use_title_author_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2


# ---------------------------------------------------------------------------
# Tier 3: fuzzy title similarity
# ---------------------------------------------------------------------------

def test_tier3_fuzzy_merges_similar_titles():
    """Titles with ≥85% similarity → merged when use_fuzzy=True."""
    a = _source(1,
        norm_title="effects mindfulness anxiety depression systematic review meta",
        authors=["Smith, John"],
    )
    b = _source(2,
        norm_title="effects mindfulness anxiety depression systematic review",
        authors=["Smith, J"],
    )
    config = _config(use_fuzzy=True, fuzzy_threshold=0.85, fuzzy_author_check=False)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 3
    assert clusters[0].match_basis == "tier3_fuzzy"
    assert clusters[0].similarity_score is not None
    assert clusters[0].similarity_score >= 0.85


def test_tier3_fuzzy_below_threshold_no_merge():
    """Titles below threshold (e.g. 50% similarity) → not merged."""
    a = _source(1, norm_title="mindfulness meditation anxiety disorders adults")
    b = _source(2, norm_title="cognitive behavioural therapy depression children")
    config = _config(use_fuzzy=True, fuzzy_threshold=0.85, fuzzy_author_check=False)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2


def test_tier3_fuzzy_disabled_no_merge():
    """Similar titles but use_fuzzy=False → not merged."""
    a = _source(1, norm_title="effects mindfulness anxiety systematic review meta analysis")
    b = _source(2, norm_title="effects mindfulness anxiety systematic review meta")
    config = _config(use_fuzzy=False)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 2
    assert all(c.match_tier == 0 for c in clusters)


def test_tier3_author_check_prevents_merge():
    """Similar titles but no author overlap → not merged when fuzzy_author_check=True."""
    a = _source(1,
        norm_title="effects mindfulness anxiety depression systematic review",
        authors=["Smith, John"],
    )
    b = _source(2,
        norm_title="effects mindfulness anxiety depression systematic review",
        authors=["Jones, Alice"],
    )
    config = _config(use_fuzzy=True, fuzzy_threshold=0.85, fuzzy_author_check=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    # No shared surname → author check blocks the fuzzy merge
    assert len(clusters) == 2


def test_tier3_author_check_disabled_allows_merge():
    """Similar titles, different authors, but fuzzy_author_check=False → merged."""
    a = _source(1,
        norm_title="effects mindfulness anxiety depression systematic review",
        authors=["Smith, John"],
    )
    b = _source(2,
        norm_title="effects mindfulness anxiety depression systematic review",
        authors=["Jones, Alice"],
    )
    config = _config(use_fuzzy=True, fuzzy_threshold=0.85, fuzzy_author_check=False)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 3


# ---------------------------------------------------------------------------
# Tier 0: isolated sources
# ---------------------------------------------------------------------------

def test_isolated_record_no_matchable_fields():
    """Source with no title/doi/pmid/year → isolated, tier=0."""
    a = _source(1)  # no fields set
    config = _config(use_doi=True, use_pmid=True, use_title_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 0
    assert clusters[0].match_basis == "none"


def test_empty_sources_returns_empty():
    """Empty input → empty cluster list."""
    config = _config(use_doi=True)
    clusters = TieredClusterBuilder(config).compute_clusters([])
    assert clusters == []


# ---------------------------------------------------------------------------
# Tier priority: lower tier wins over higher
# ---------------------------------------------------------------------------

def test_doi_match_wins_over_title_match():
    """When two records match on both DOI and title, match_tier should be 1 (DOI)."""
    title = "a study mindfulness intervention adults"
    a = _source(1, match_doi="10.1234/x", norm_title=title, match_year=2023)
    b = _source(2, match_doi="10.1234/x", norm_title=title, match_year=2023)
    config = _config(use_doi=True, use_title_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    # DOI pass runs first → cluster is formed at tier 1
    assert clusters[0].match_tier == 1


# ---------------------------------------------------------------------------
# Representative selection
# ---------------------------------------------------------------------------

def test_representative_prefers_source_with_doi():
    """Cluster representative is the source that has a DOI."""
    a = _source(1, norm_title="some title", match_year=2023)               # no DOI
    b = _source(2, norm_title="some title", match_year=2023,               # has DOI
                match_doi="10.1234/x", raw_data={"doi": "10.1234/x"})
    config = _config(use_title_year=True)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].representative.match_doi == "10.1234/x"


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

def test_determinism_same_output_regardless_of_input_order():
    """compute_clusters produces the same clusters regardless of input order."""
    sources = [
        _source(1, match_doi="10.1234/a"),
        _source(2, match_doi="10.1234/a"),
        _source(3, match_doi="10.1234/b"),
        _source(4, norm_title="some title year", match_year=2023),
        _source(5, norm_title="some title year", match_year=2023),
    ]
    config = _config(use_doi=True, use_title_year=True)

    import random
    shuffled = sources[:]
    random.seed(42)
    random.shuffle(shuffled)

    clusters_a = TieredClusterBuilder(config).compute_clusters(sources)
    clusters_b = TieredClusterBuilder(config).compute_clusters(shuffled)

    # Same number of clusters
    assert len(clusters_a) == len(clusters_b)

    # Same cluster sizes (sorted to compare)
    sizes_a = sorted(c.size for c in clusters_a)
    sizes_b = sorted(c.size for c in clusters_b)
    assert sizes_a == sizes_b


# ---------------------------------------------------------------------------
# StrategyConfig.from_preset — backward compatibility
# ---------------------------------------------------------------------------

def test_from_preset_doi_first_strict_enables_doi_and_pmid():
    """doi_first_strict enables DOI + PMID (tier 1) and title+author+year (tier 2)."""
    config = StrategyConfig.from_preset("doi_first_strict")
    assert config.use_doi is True
    assert config.use_pmid is True
    assert config.use_title_author_year is True
    assert config.use_title_year is False
    assert config.use_fuzzy is False


def test_from_preset_medium_enables_title_year_only():
    """medium preset enables title+year only (no DOI, no author, no fuzzy)."""
    config = StrategyConfig.from_preset("medium")
    assert config.use_doi is False
    assert config.use_pmid is False
    assert config.use_title_year is True
    assert config.use_title_author_year is False
    assert config.use_fuzzy is False


def test_from_preset_unknown_returns_defaults():
    """Unknown preset name returns a safe default config (no crash)."""
    config = StrategyConfig.from_preset("nonexistent_preset")
    assert isinstance(config, StrategyConfig)


def test_from_preset_doi_first_strict_backward_compat():
    """
    doi_first_strict: same two records that matched on DOI under old logic
    still match on tier 1 DOI under the new TieredClusterBuilder.
    """
    config = StrategyConfig.from_preset("doi_first_strict")
    a = _source(1, match_doi="10.1234/mindful")
    b = _source(2, match_doi="10.1234/mindful")

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 1
    assert clusters[0].match_basis == "tier1_doi"


def test_from_preset_strict_backward_compat():
    """
    strict: same records that matched on title+author+year under old logic
    still match on tier 2 under the new builder (no DOI or PMID).
    """
    config = StrategyConfig.from_preset("strict")
    title = "mindfulness intervention anxiety adults"
    a = _source(1, norm_title=title, norm_first_author="smith", match_year=2022)
    b = _source(2, norm_title=title, norm_first_author="smith", match_year=2022)

    clusters = TieredClusterBuilder(config).compute_clusters([a, b])

    assert len(clusters) == 1
    assert clusters[0].match_tier == 2
    assert clusters[0].match_basis == "tier2_title_author_year"


# ---------------------------------------------------------------------------
# StrategyConfig serialization round-trip
# ---------------------------------------------------------------------------

def test_strategy_config_round_trip():
    """StrategyConfig → to_dict() → from_dict() produces identical config."""
    original = StrategyConfig(
        use_doi=True, use_pmid=False,
        use_title_year=True, use_title_author_year=False,
        use_fuzzy=True, fuzzy_threshold=0.90, fuzzy_author_check=False,
    )
    recovered = StrategyConfig.from_dict(original.to_dict())
    assert recovered == original


# ---------------------------------------------------------------------------
# Preview mode
# ---------------------------------------------------------------------------

def test_preview_returns_only_duplicate_clusters():
    """preview() returns only clusters with >1 member in .clusters; singletons → .isolated."""
    title = "some matched title"
    sources = [
        _source(1, match_doi="10.1234/x"),
        _source(2, match_doi="10.1234/x"),  # same DOI → duplicate
        _source(3),                          # isolated
    ]
    config = _config(use_doi=True)
    preview = TieredClusterBuilder(config).preview(sources)

    assert len(preview.clusters) == 1
    assert preview.clusters[0].size == 2
    assert len(preview.isolated) == 1
    assert preview.would_merge == 1
    assert preview.would_remain == 2  # 1 merged cluster + 1 isolated


def test_preview_tier_counts():
    """Preview correctly counts clusters per tier."""
    sources = [
        _source(1, match_doi="10.1234/a"),
        _source(2, match_doi="10.1234/a"),  # tier1
        _source(3, norm_title="some title", match_year=2023),
        _source(4, norm_title="some title", match_year=2023),  # tier2
    ]
    config = _config(use_doi=True, use_title_year=True)
    preview = TieredClusterBuilder(config).preview(sources)

    assert preview.tier1_count == 1
    assert preview.tier2_count == 1
    assert preview.tier3_count == 0


def test_preview_no_duplicates_returns_empty_clusters():
    """All unique sources → no duplicate clusters, all isolated."""
    sources = [
        _source(1, match_doi="10.1234/a"),
        _source(2, match_doi="10.1234/b"),
        _source(3, match_doi="10.1234/c"),
    ]
    config = _config(use_doi=True)
    preview = TieredClusterBuilder(config).preview(sources)

    assert len(preview.clusters) == 0
    assert len(preview.isolated) == 3
    assert preview.would_merge == 0
    assert preview.would_remain == 3
