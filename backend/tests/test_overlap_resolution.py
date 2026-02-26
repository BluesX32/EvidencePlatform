"""
Overlap Resolution tests.

Covers:
- overlap_service.build_overlap_preview() — within-source vs cross-source classification
- OverlapConfig driven clustering inside overlap detection
- Strategy repo: create with custom config (preset='custom')
- Strategy repo: VALID_PRESETS includes 'custom'
- OverlapConfig: selected_fields roundtrip
- Overlap cluster scope is 'within_source' when all members share the same source
- Overlap cluster scope is 'cross_source' when members span multiple sources
- Empty sources → empty snapshot
- Single source, one record → no overlap clusters
- Two sources, same DOI → cross_source cluster
- Same source, same DOI → within_source cluster
- Tier classification (DOI=1, title+year=2/3/4)
- Fuzzy matching disabled → no tier-5 clusters
- OverlapSnapshot fields: counts, cluster lists
"""
from __future__ import annotations

import uuid
from typing import Optional

import pytest

from app.services.overlap_service import (
    build_overlap_preview,
    OverlapSnapshot,
)
from app.utils.overlap_detector import (
    OverlapConfig,
    OverlapRecord,
    _build_overlap_records,
)
from app.repositories.strategy_repo import VALID_PRESETS


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------

def _make_row(
    *,
    row_id: Optional[uuid.UUID] = None,
    source_id: Optional[uuid.UUID] = None,
    norm_title: Optional[str] = None,
    match_doi: Optional[str] = None,
    match_year: Optional[int] = None,
    raw: Optional[dict] = None,
) -> object:
    """Return a fake DB row compatible with _build_overlap_records()."""
    class FakeRow:
        pass
    r = FakeRow()
    r.id = row_id or uuid.uuid4()
    r.source_id = source_id or uuid.uuid4()
    r.norm_title = norm_title
    r.match_doi = match_doi
    r.match_year = match_year
    r.raw_data = raw or {}
    return r


def _config(
    *,
    use_doi=True,
    use_pmid=True,
    use_title=True,
    use_year=True,
    use_first_author=True,
    use_volume=True,
    fuzzy=False,
) -> OverlapConfig:
    fields = []
    if use_doi: fields.append("doi")
    if use_pmid: fields.append("pmid")
    if use_title: fields.append("title")
    if use_year: fields.append("year")
    if use_first_author: fields.append("first_author")
    if use_volume: fields.append("volume")
    return OverlapConfig(selected_fields=fields, fuzzy_enabled=fuzzy)


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
# build_overlap_preview — basic correctness
# ---------------------------------------------------------------------------

def test_snapshot_empty_sources():
    """No rows → empty snapshot."""
    snapshot = build_overlap_preview([], _config())
    assert snapshot.within_source_clusters == []
    assert snapshot.cross_source_clusters == []
    assert snapshot.within_source_duplicate_count == 0
    assert snapshot.cross_source_overlap_count == 0
    assert snapshot.unique_overlapping_papers == 0


def test_snapshot_single_record_no_overlap():
    """One record → no overlap clusters."""
    row = _make_row(match_doi="10.1234/test", norm_title="test")
    snapshot = build_overlap_preview([row], _config())
    assert snapshot.within_source_clusters == []
    assert snapshot.cross_source_clusters == []


def test_snapshot_two_records_same_doi_same_source():
    """Two records with the same DOI from the same source → within_source."""
    src_id = uuid.uuid4()
    rows = [
        _make_row(source_id=src_id, match_doi="10.1234/same"),
        _make_row(source_id=src_id, match_doi="10.1234/same"),
    ]
    snapshot = build_overlap_preview(rows, _config())
    assert len(snapshot.within_source_clusters) == 1
    assert snapshot.cross_source_clusters == []
    assert snapshot.within_source_duplicate_count == 1  # one extra copy


def test_snapshot_two_records_same_doi_different_sources():
    """Two records with the same DOI from different sources → cross_source."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, match_doi="10.1234/shared"),
        _make_row(source_id=src_b, match_doi="10.1234/shared"),
    ]
    snapshot = build_overlap_preview(rows, _config())
    assert snapshot.within_source_clusters == []
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_overlap_count == 2
    assert snapshot.unique_overlapping_papers == 1


def test_snapshot_mixed_within_and_cross():
    """Mix of within-source and cross-source clusters are correctly categorised."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        # within-source duplicate (both from src_a)
        _make_row(source_id=src_a, match_doi="10.1/within"),
        _make_row(source_id=src_a, match_doi="10.1/within"),
        # cross-source (one from src_a, one from src_b)
        _make_row(source_id=src_a, match_doi="10.2/cross"),
        _make_row(source_id=src_b, match_doi="10.2/cross"),
    ]
    snapshot = build_overlap_preview(rows, _config())
    assert len(snapshot.within_source_clusters) == 1
    assert len(snapshot.cross_source_clusters) == 1


def test_snapshot_title_year_cluster():
    """Title + year match is correctly detected and classified (tiers 2-4)."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(
            source_id=src_a,
            norm_title="effect of mindfulness on depression",
            match_year=2023,
        ),
        _make_row(
            source_id=src_b,
            norm_title="effect of mindfulness on depression",
            match_year=2023,
        ),
    ]
    snapshot = build_overlap_preview(rows, _config(use_doi=False))
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_clusters[0].match_tier in (2, 3, 4)


def test_snapshot_no_cluster_when_doi_disabled():
    """DOI matching disabled → same-DOI records are NOT clustered by DOI."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, match_doi="10.1/doi", norm_title="title a", match_year=2023),
        _make_row(source_id=src_b, match_doi="10.1/doi", norm_title="title b", match_year=2024),
    ]
    config = OverlapConfig(selected_fields=[])
    snapshot = build_overlap_preview(rows, config)
    assert snapshot.within_source_clusters == []
    assert snapshot.cross_source_clusters == []


def test_snapshot_pmid_cluster_cross_source():
    """PMID match (tier 1) creates a cross-source cluster."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, raw={"pmid": "12345678"}),
        _make_row(source_id=src_b, raw={"pmid": "12345678"}),
    ]
    snapshot = build_overlap_preview(rows, _config(use_doi=False))
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_clusters[0].match_tier == 1
    assert snapshot.cross_source_clusters[0].match_basis == "pmid"


def test_snapshot_cluster_summary_fields():
    """OverlapClusterSummary has expected fields."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, match_doi="10.1/x"),
        _make_row(source_id=src_b, match_doi="10.1/x"),
    ]
    snapshot = build_overlap_preview(rows, _config())
    c = snapshot.cross_source_clusters[0]

    assert c.scope == "cross_source"
    assert c.match_tier == 1
    assert c.match_basis == "doi"
    assert c.member_count == 2
    assert len(c.source_ids) == 2
    assert len(c.record_source_ids) == 2
    assert c.similarity_score is None  # exact match


def test_snapshot_fuzzy_disabled_no_tier5():
    """When fuzzy_enabled=False, no tier-5 clusters are returned."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, norm_title="effects of yoga on anxiety", match_year=2022),
        _make_row(source_id=src_b, norm_title="effect of yoga on anxiety disorders", match_year=2022),
    ]
    config = OverlapConfig(
        selected_fields=["title", "year", "first_author"],
        fuzzy_enabled=False,
    )
    snapshot = build_overlap_preview(rows, config)
    tier5 = [c for c in snapshot.cross_source_clusters if c.match_tier == 5]
    assert tier5 == []


def test_snapshot_three_records_two_sources():
    """Three records: 2 from src_a (one within-source dup) + 1 from src_b (cross-source)."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    doi = "10.1/shared"
    rows = [
        _make_row(source_id=src_a, match_doi=doi),
        _make_row(source_id=src_a, match_doi=doi),
        _make_row(source_id=src_b, match_doi=doi),
    ]
    snapshot = build_overlap_preview(rows, _config())
    # All three share same DOI → one cluster spanning src_a AND src_b → cross_source
    assert len(snapshot.cross_source_clusters) == 1
    assert snapshot.cross_source_clusters[0].member_count == 3


def test_snapshot_unique_overlapping_papers():
    """unique_overlapping_papers counts distinct cross-source clusters."""
    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, match_doi="10.1/paper1"),
        _make_row(source_id=src_b, match_doi="10.1/paper1"),
        _make_row(source_id=src_a, match_doi="10.2/paper2"),
        _make_row(source_id=src_b, match_doi="10.2/paper2"),
    ]
    snapshot = build_overlap_preview(rows, _config())
    assert snapshot.unique_overlapping_papers == 2


# ---------------------------------------------------------------------------
# _build_overlap_records helper
# ---------------------------------------------------------------------------

def test_build_overlap_records_extracts_pmid_from_raw_data():
    """PMID is extracted from raw_data['pmid'] when present."""
    row = _make_row(raw={"pmid": "99887766", "authors": ["Smith, J"]})
    records = _build_overlap_records([row])
    assert len(records) == 1
    assert records[0].pmid == "99887766"
    assert records[0].first_author == "smith"
    assert records[0].source_id == row.source_id


def test_build_overlap_records_extracts_pmid_from_source_record_id():
    """PMID falls back to raw_data['source_record_id'] when 'pmid' absent."""
    row = _make_row(raw={"source_record_id": "11223344"})
    records = _build_overlap_records([row])
    assert records[0].pmid == "11223344"


def test_build_overlap_records_normalizes_title():
    """norm_title is normalised via normalize_title_for_overlap."""
    row = _make_row(norm_title="Effect of Mindfulness [Review].")
    records = _build_overlap_records([row])
    assert records[0].norm_title == "effect of mindfulness"


# ---------------------------------------------------------------------------
# OverlapConfig integration
# ---------------------------------------------------------------------------

def test_overlap_config_from_dict_used_in_preview():
    """OverlapConfig.from_dict() affects which clusters are detected."""
    config_no_doi = OverlapConfig.from_dict({
        "selected_fields": ["title", "year"],
    })

    src_a, src_b = uuid.uuid4(), uuid.uuid4()
    rows = [
        _make_row(source_id=src_a, match_doi="10.1/x", norm_title="alpha study", match_year=2022),
        _make_row(source_id=src_b, match_doi="10.1/x", norm_title="beta study", match_year=2021),
    ]
    # Different titles and years → no cluster
    snapshot = build_overlap_preview(rows, config_no_doi)
    assert snapshot.cross_source_clusters == []
    assert snapshot.within_source_clusters == []


def test_overlap_config_to_dict_roundtrip():
    """OverlapConfig.to_dict() / from_dict() roundtrip is lossless."""
    original = OverlapConfig(
        selected_fields=["doi", "pmid", "title", "year", "first_author"],
        fuzzy_enabled=True,
        fuzzy_threshold=0.9,
        year_tolerance=1,
    )
    d = original.to_dict()
    restored = OverlapConfig.from_dict(d)

    assert restored.selected_fields == original.selected_fields
    assert restored.fuzzy_enabled == original.fuzzy_enabled
    assert abs(restored.fuzzy_threshold - original.fuzzy_threshold) < 0.001
    assert restored.year_tolerance == original.year_tolerance
