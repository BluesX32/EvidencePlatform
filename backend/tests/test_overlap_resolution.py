"""
Overlap Resolution tests.

Covers:
- overlap_service.build_overlap_snapshot() — within-source vs cross-source classification
- Scope classification (_classify_scope)
- StrategyConfig driven clustering inside overlap detection
- Strategy repo: create with custom config (preset='custom')
- Strategy repo: VALID_PRESETS includes 'custom'
- StrategyConfig: selected_fields roundtrip
- Overlap cluster scope is 'within_source' when all members share the same source
- Overlap cluster scope is 'cross_source' when members span multiple sources
- Empty sources → empty snapshot
- Single source, one record → no overlap clusters
- Two sources, same DOI → cross_source cluster
- Same source, same DOI → within_source cluster
- Tier classification (DOI=1, title+year=2, fuzzy=3)
- Fuzzy matching disabled → no tier-3 clusters
- OverlapSnapshot fields: counts, cluster lists
"""
from __future__ import annotations

import uuid
from typing import Optional

import pytest

from app.services.overlap_service import (
    build_overlap_snapshot,
    _classify_scope,
    _build_source_records,
    OverlapSnapshot,
)
from app.utils.cluster_builder import Cluster, SourceRecord
from app.utils.match_keys import StrategyConfig
from app.repositories.strategy_repo import VALID_PRESETS


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------

def _make_source(
    *,
    sid: Optional[uuid.UUID] = None,
    norm_title: Optional[str] = None,
    match_doi: Optional[str] = None,
    match_year: Optional[int] = None,
    norm_first_author: Optional[str] = None,
    pmid: Optional[str] = None,
    raw: Optional[dict] = None,
) -> SourceRecord:
    return SourceRecord(
        id=sid or uuid.uuid4(),
        old_record_id=uuid.uuid4(),
        norm_title=norm_title,
        norm_first_author=norm_first_author,
        match_year=match_year,
        match_doi=match_doi,
        pmid=pmid,
        authors=None,
        raw_data=raw or {},
    )


def _config(
    *,
    use_doi=True,
    use_pmid=True,
    use_title_year=True,
    use_title_author_year=False,
    use_fuzzy=False,
) -> StrategyConfig:
    return StrategyConfig(
        use_doi=use_doi,
        use_pmid=use_pmid,
        use_title_year=use_title_year,
        use_title_author_year=use_title_author_year,
        use_fuzzy=use_fuzzy,
    )


# ---------------------------------------------------------------------------
# VALID_PRESETS includes 'custom'
# ---------------------------------------------------------------------------

def test_valid_presets_includes_custom():
    """'custom' must be a valid preset for field-chip builder strategies."""
    assert "custom" in VALID_PRESETS


def test_valid_presets_includes_legacy():
    """Legacy preset names must still be accepted."""
    for preset in ("doi_first_strict", "doi_first_medium", "strict", "medium", "loose"):
        assert preset in VALID_PRESETS


# ---------------------------------------------------------------------------
# _classify_scope
# ---------------------------------------------------------------------------

def test_classify_scope_within_source_when_same_source():
    """All members from the same source → 'within_source'."""
    src_id = uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    s1 = _make_source(sid=rs1)
    s2 = _make_source(sid=rs2)
    source_id_map = {rs1: src_id, rs2: src_id}

    from app.utils.cluster_builder import TieredClusterBuilder
    config = _config(use_doi=True)
    builder = TieredClusterBuilder(config)

    # Create a synthetic cluster
    cluster = Cluster(
        representative=s1,
        members=[s1, s2],
        match_tier=1,
        match_basis="tier1_doi",
        match_reason="test",
        similarity_score=None,
    )
    assert _classify_scope(cluster, source_id_map) == "within_source"


def test_classify_scope_cross_source_when_different_sources():
    """Members from different sources → 'cross_source'."""
    src_a = uuid.uuid4()
    src_b = uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    s1 = _make_source(sid=rs1)
    s2 = _make_source(sid=rs2)
    source_id_map = {rs1: src_a, rs2: src_b}

    cluster = Cluster(
        representative=s1,
        members=[s1, s2],
        match_tier=1,
        match_basis="tier1_doi",
        match_reason="test",
        similarity_score=None,
    )
    assert _classify_scope(cluster, source_id_map) == "cross_source"


# ---------------------------------------------------------------------------
# build_overlap_snapshot — basic correctness
# ---------------------------------------------------------------------------

def test_snapshot_empty_sources():
    """No sources → empty snapshot."""
    snapshot = build_overlap_snapshot([], {}, _config())
    assert snapshot.within_source_clusters == []
    assert snapshot.cross_source_clusters == []
    assert snapshot.within_source_duplicate_count == 0
    assert snapshot.cross_source_overlap_count == 0
    assert snapshot.unique_overlapping_papers == 0


def test_snapshot_single_record_no_overlap():
    """One record from one source → no overlap clusters."""
    rs_id = uuid.uuid4()
    src_id = uuid.uuid4()
    sources = [_make_source(sid=rs_id, match_doi="10.1234/test", norm_title="test")]
    source_id_map = {rs_id: src_id}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    assert snapshot.within_source_clusters == []
    assert snapshot.cross_source_clusters == []


def test_snapshot_two_records_same_doi_same_source():
    """Two records with the same DOI from the same source → within_source."""
    src_id = uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, match_doi="10.1234/same"),
        _make_source(sid=rs2, match_doi="10.1234/same"),
    ]
    source_id_map = {rs1: src_id, rs2: src_id}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    assert len(snapshot.within_source_clusters) == 1
    assert snapshot.cross_source_clusters == []
    assert snapshot.within_source_duplicate_count == 1  # one extra copy


def test_snapshot_two_records_same_doi_different_sources():
    """Two records with the same DOI from different sources → cross_source."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, match_doi="10.1234/shared"),
        _make_source(sid=rs2, match_doi="10.1234/shared"),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    assert snapshot.within_source_clusters == []
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_overlap_count == 2
    assert snapshot.unique_overlapping_papers == 1


def test_snapshot_mixed_within_and_cross():
    """Mix of within-source and cross-source clusters are correctly categorised."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2, rs3, rs4 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    sources = [
        # within-source duplicate (both from src_a)
        _make_source(sid=rs1, match_doi="10.1/within"),
        _make_source(sid=rs2, match_doi="10.1/within"),
        # cross-source (one from src_a, one from src_b)
        _make_source(sid=rs3, match_doi="10.2/cross"),
        _make_source(sid=rs4, match_doi="10.2/cross"),
    ]
    source_id_map = {rs1: src_a, rs2: src_a, rs3: src_a, rs4: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    assert len(snapshot.within_source_clusters) == 1
    assert len(snapshot.cross_source_clusters) == 1


def test_snapshot_title_year_tier2_cluster():
    """Title + year match (tier 2) is correctly detected and classified."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, norm_title="effect of mindfulness on depression", match_year=2023),
        _make_source(sid=rs2, norm_title="effect of mindfulness on depression", match_year=2023),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config(use_doi=False))
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_clusters[0].match_tier == 2


def test_snapshot_no_cluster_when_doi_disabled():
    """DOI matching disabled → same-DOI records are NOT clustered."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, match_doi="10.1/doi", norm_title="title a", match_year=2023),
        _make_source(sid=rs2, match_doi="10.1/doi", norm_title="title b", match_year=2024),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    # Disable all matching
    snapshot = build_overlap_snapshot(
        sources,
        source_id_map,
        _config(use_doi=False, use_pmid=False, use_title_year=False, use_title_author_year=False),
    )
    assert snapshot.within_source_clusters == []
    assert snapshot.cross_source_clusters == []


def test_snapshot_pmid_cluster_cross_source():
    """PMID match (tier 1b) creates a cross-source cluster."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, pmid="12345678"),
        _make_source(sid=rs2, pmid="12345678"),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    snapshot = build_overlap_snapshot(
        sources, source_id_map, _config(use_doi=False, use_pmid=True)
    )
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_clusters[0].match_tier == 1
    assert snapshot.cross_source_clusters[0].match_basis == "tier1_pmid"


def test_snapshot_cluster_summary_fields():
    """OverlapClusterSummary has expected fields."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, match_doi="10.1/x"),
        _make_source(sid=rs2, match_doi="10.1/x"),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    c = snapshot.cross_source_clusters[0]

    assert c.scope == "cross_source"
    assert c.match_tier == 1
    assert c.match_basis == "tier1_doi"
    assert c.member_count == 2
    assert len(c.source_ids) == 2
    assert len(c.record_source_ids) == 2
    assert c.similarity_score is None  # exact match


def test_snapshot_fuzzy_disabled_no_tier3():
    """When use_fuzzy=False, no tier-3 clusters are returned."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, norm_title="effects of yoga on anxiety", match_year=2022),
        _make_source(sid=rs2, norm_title="effect of yoga on anxiety disorders", match_year=2022),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    snapshot = build_overlap_snapshot(
        sources, source_id_map, _config(use_fuzzy=False, use_title_year=False)
    )
    # Different titles → no match with fuzzy disabled
    tier3 = [c for c in snapshot.cross_source_clusters if c.match_tier == 3]
    assert tier3 == []


def test_snapshot_three_records_two_sources():
    """Three records: 2 from src_a (one within-source dup) + 1 from src_b (cross-source)."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2, rs3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    doi = "10.1/shared"
    sources = [
        _make_source(sid=rs1, match_doi=doi),  # src_a, copy 1
        _make_source(sid=rs2, match_doi=doi),  # src_a, copy 2 → within-source dup
        _make_source(sid=rs3, match_doi=doi),  # src_b → cross-source
    ]
    source_id_map = {rs1: src_a, rs2: src_a, rs3: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    # All three share same DOI → one cluster with members from src_a AND src_b → cross_source
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_clusters[0].member_count == 3


def test_snapshot_unique_overlapping_papers():
    """unique_overlapping_papers counts distinct cross-source clusters."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2, rs3, rs4 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    sources = [
        _make_source(sid=rs1, match_doi="10.1/paper1"),
        _make_source(sid=rs2, match_doi="10.1/paper1"),
        _make_source(sid=rs3, match_doi="10.2/paper2"),
        _make_source(sid=rs4, match_doi="10.2/paper2"),
    ]
    source_id_map = {rs1: src_a, rs2: src_b, rs3: src_a, rs4: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, _config())
    assert snapshot.unique_overlapping_papers == 2


# ---------------------------------------------------------------------------
# _build_source_records helper
# ---------------------------------------------------------------------------

def test_build_source_records_extracts_pmid_from_raw_data():
    """PMID is extracted from raw_data['pmid'] when present."""
    class FakeRow:
        id = uuid.uuid4()
        record_id = uuid.uuid4()
        source_id = uuid.uuid4()
        norm_title = None
        norm_first_author = None
        match_year = None
        match_doi = None
        raw_data = {"pmid": "99887766", "authors": ["Smith, J"]}

    rows = [FakeRow()]
    sources, source_id_map = _build_source_records(rows)

    assert len(sources) == 1
    assert sources[0].pmid == "99887766"
    assert sources[0].authors == ["Smith, J"]
    assert source_id_map[FakeRow.id] == FakeRow.source_id


def test_build_source_records_extracts_pmid_from_source_record_id():
    """PMID falls back to raw_data['source_record_id'] when 'pmid' absent."""
    class FakeRow:
        id = uuid.uuid4()
        record_id = uuid.uuid4()
        source_id = uuid.uuid4()
        norm_title = None
        norm_first_author = None
        match_year = None
        match_doi = None
        raw_data = {"source_record_id": "11223344"}

    rows = [FakeRow()]
    sources, source_id_map = _build_source_records(rows)
    assert sources[0].pmid == "11223344"


# ---------------------------------------------------------------------------
# StrategyConfig integration with overlap detection
# ---------------------------------------------------------------------------

def test_strategy_config_from_dict_used_in_snapshot():
    """StrategyConfig.from_dict() affects which clusters are detected."""
    # Config with DOI disabled
    config_no_doi = StrategyConfig.from_dict({"use_doi": False, "use_pmid": False,
                                              "use_title_year": True, "use_title_author_year": False,
                                              "use_fuzzy": False})

    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rs1, rs2 = uuid.uuid4(), uuid.uuid4()
    # Same DOI, different titles — DOI disabled means no DOI cluster
    sources = [
        _make_source(sid=rs1, match_doi="10.1/x", norm_title="alpha study", match_year=2022),
        _make_source(sid=rs2, match_doi="10.1/x", norm_title="beta study", match_year=2021),
    ]
    source_id_map = {rs1: src_a, rs2: src_b}

    snapshot = build_overlap_snapshot(sources, source_id_map, config_no_doi)
    # Different titles and years → no title+year cluster either
    assert snapshot.cross_source_clusters == []
    assert snapshot.within_source_clusters == []


def test_strategy_config_to_dict_roundtrip_with_selected_fields():
    """StrategyConfig.to_dict() / from_dict() roundtrip is lossless."""
    original = StrategyConfig(
        use_doi=True,
        use_pmid=False,
        use_title_year=True,
        use_title_author_year=False,
        use_fuzzy=True,
        fuzzy_threshold=0.9,
        fuzzy_author_check=False,
    )
    d = original.to_dict()
    restored = StrategyConfig.from_dict(d)

    assert restored.use_doi == original.use_doi
    assert restored.use_pmid == original.use_pmid
    assert restored.use_title_year == original.use_title_year
    assert restored.use_title_author_year == original.use_title_author_year
    assert restored.use_fuzzy == original.use_fuzzy
    assert abs(restored.fuzzy_threshold - original.fuzzy_threshold) < 0.001
    assert restored.fuzzy_author_check == original.fuzzy_author_check
