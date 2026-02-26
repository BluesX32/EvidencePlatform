"""
Unit tests for app.utils.overlap_detector.

Covers:
- OverlapConfig: default, from_dict/to_dict roundtrip
- OverlapDetector: tier 1 (DOI, PMID), tiers 2-4 (title+year combos), tier 5 (fuzzy)
- Determinism: same output regardless of input order
- Blocking key: records in different years skip fuzzy comparison
- Scope classification (within-source vs cross-source)
- Graceful degradation when fields are not in selected_fields
"""
from __future__ import annotations

import uuid
from typing import Optional

import pytest

from app.utils.overlap_detector import (
    OverlapConfig,
    OverlapDetector,
    OverlapRecord,
    DetectedCluster,
    _build_overlap_records,
    select_representative,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_record(
    *,
    sid: Optional[uuid.UUID] = None,
    source_id: Optional[uuid.UUID] = None,
    doi: Optional[str] = None,
    pmid: Optional[str] = None,
    norm_title: str = "",
    year: Optional[int] = None,
    first_author: Optional[str] = None,
    all_author_lasts: Optional[list] = None,
    norm_volume: Optional[str] = None,
    abstract_len: int = 0,
) -> OverlapRecord:
    title = norm_title
    return OverlapRecord(
        record_source_id=sid or uuid.uuid4(),
        source_id=source_id or uuid.uuid4(),
        doi=doi,
        pmid=pmid,
        norm_title=title,
        title_prefix=title[:15],
        year=year,
        first_author=first_author,
        all_author_lasts=all_author_lasts or (["smith"] if first_author == "smith" else []),
        norm_volume=norm_volume,
        raw_pages=None,
        raw_journal=None,
        abstract_len=abstract_len,
    )


def _default_detector() -> OverlapDetector:
    return OverlapDetector(OverlapConfig.default())


# ---------------------------------------------------------------------------
# OverlapConfig
# ---------------------------------------------------------------------------

class TestOverlapConfig:
    def test_default_has_six_fields(self):
        config = OverlapConfig.default()
        assert config.selected_fields == ["doi", "pmid", "title", "year", "first_author", "volume"]

    def test_default_fuzzy_disabled(self):
        config = OverlapConfig.default()
        assert config.fuzzy_enabled is False

    def test_from_dict_roundtrip(self):
        original = OverlapConfig(
            selected_fields=["doi", "title", "year"],
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

    def test_from_dict_defaults_for_missing_keys(self):
        config = OverlapConfig.from_dict({"selected_fields": ["doi"]})
        assert config.fuzzy_enabled is False
        assert config.year_tolerance == 0
        assert abs(config.fuzzy_threshold - 0.93) < 0.001

    def test_to_dict_contains_all_keys(self):
        d = OverlapConfig.default().to_dict()
        assert "selected_fields" in d
        assert "fuzzy_enabled" in d
        assert "fuzzy_threshold" in d
        assert "year_tolerance" in d


# ---------------------------------------------------------------------------
# Tier 1: DOI
# ---------------------------------------------------------------------------

class TestTier1DOI:
    def test_two_records_same_doi_form_cluster(self):
        doi = "10.1234/test"
        r1 = _make_record(doi=doi)
        r2 = _make_record(doi=doi)
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 1
        assert clusters[0].match_basis == "doi"

    def test_two_different_doi_no_cluster(self):
        r1 = _make_record(doi="10.1/a")
        r2 = _make_record(doi="10.1/b")
        clusters = _default_detector().detect([r1, r2])
        assert clusters == []

    def test_three_records_same_doi_one_cluster(self):
        doi = "10.1234/shared"
        records = [_make_record(doi=doi) for _ in range(3)]
        clusters = _default_detector().detect(records)
        assert len(clusters) == 1
        assert len(clusters[0].records) == 3

    def test_doi_field_disabled_no_cluster(self):
        config = OverlapConfig(selected_fields=["pmid", "title", "year"])
        r1 = _make_record(doi="10.1/same")
        r2 = _make_record(doi="10.1/same")
        clusters = OverlapDetector(config).detect([r1, r2])
        assert clusters == []


# ---------------------------------------------------------------------------
# Tier 1: PMID
# ---------------------------------------------------------------------------

class TestTier1PMID:
    def test_same_pmid_forms_cluster(self):
        r1 = _make_record(pmid="12345678")
        r2 = _make_record(pmid="12345678")
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 1
        assert clusters[0].match_basis == "pmid"

    def test_different_pmid_no_cluster(self):
        r1 = _make_record(pmid="11111111")
        r2 = _make_record(pmid="22222222")
        clusters = _default_detector().detect([r1, r2])
        assert clusters == []

    def test_pmid_field_disabled_no_cluster(self):
        config = OverlapConfig(selected_fields=["doi", "title", "year"])
        r1 = _make_record(pmid="99887766")
        r2 = _make_record(pmid="99887766")
        clusters = OverlapDetector(config).detect([r1, r2])
        assert clusters == []


# ---------------------------------------------------------------------------
# Tier 2: title + year + author + volume
# ---------------------------------------------------------------------------

class TestTier2:
    def test_same_title_year_author_volume_tier2(self):
        r1 = _make_record(
            norm_title="effect of mindfulness on depression",
            year=2023, first_author="smith", norm_volume="12",
        )
        r2 = _make_record(
            norm_title="effect of mindfulness on depression",
            year=2023, first_author="smith", norm_volume="12",
        )
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 2
        assert clusters[0].match_basis == "title_year_author_volume"

    def test_volume_absent_falls_to_tier2_still(self):
        """When one record has no volume, volume check passes → tier 2."""
        r1 = _make_record(
            norm_title="a study of pain", year=2022, first_author="jones", norm_volume=None,
        )
        r2 = _make_record(
            norm_title="a study of pain", year=2022, first_author="jones", norm_volume="5",
        )
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 2  # volume_ok is True when one is None

    def test_different_volume_falls_to_tier3(self):
        r1 = _make_record(
            norm_title="cognitive therapy outcomes", year=2021, first_author="jones", norm_volume="10",
        )
        r2 = _make_record(
            norm_title="cognitive therapy outcomes", year=2021, first_author="jones", norm_volume="11",
        )
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 3


# ---------------------------------------------------------------------------
# Tier 3: title + year + author (no volume constraint)
# ---------------------------------------------------------------------------

class TestTier3:
    def test_same_title_year_author_no_volume_tier3(self):
        config = OverlapConfig(selected_fields=["title", "year", "first_author"])
        r1 = _make_record(norm_title="yoga for anxiety", year=2022, first_author="patel")
        r2 = _make_record(norm_title="yoga for anxiety", year=2022, first_author="patel")
        clusters = OverlapDetector(config).detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 2  # no volume field → volume_ok=True → tier 2

    def test_different_volumes_with_all_fields_enabled_tier3(self):
        r1 = _make_record(
            norm_title="randomised trial of exercise", year=2020,
            first_author="lee", norm_volume="3",
        )
        r2 = _make_record(
            norm_title="randomised trial of exercise", year=2020,
            first_author="lee", norm_volume="4",
        )
        clusters = _default_detector().detect([r1, r2])
        assert clusters[0].tier == 3


# ---------------------------------------------------------------------------
# Tier 4: title + year only
# ---------------------------------------------------------------------------

class TestTier4:
    def test_same_title_year_different_author_tier4(self):
        r1 = _make_record(norm_title="pain management strategies", year=2019, first_author="smith")
        r2 = _make_record(norm_title="pain management strategies", year=2019, first_author="johnson")
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 4
        assert clusters[0].match_basis == "title_year"

    def test_different_year_no_cluster(self):
        r1 = _make_record(norm_title="chronic pain review", year=2020)
        r2 = _make_record(norm_title="chronic pain review", year=2021)
        clusters = _default_detector().detect([r1, r2])
        assert clusters == []

    def test_different_title_no_cluster(self):
        r1 = _make_record(norm_title="mindfulness and stress", year=2022)
        r2 = _make_record(norm_title="cognitive behaviour therapy", year=2022)
        clusters = _default_detector().detect([r1, r2])
        assert clusters == []


# ---------------------------------------------------------------------------
# Tier 5: Fuzzy matching
# ---------------------------------------------------------------------------

class TestTier5Fuzzy:
    def test_fuzzy_disabled_no_tier5(self):
        config = OverlapConfig(selected_fields=["title", "year", "first_author"], fuzzy_enabled=False)
        r1 = _make_record(
            norm_title="effects of yoga on anxiety",
            year=2022, first_author="smith",
            all_author_lasts=["smith"],
        )
        r2 = _make_record(
            norm_title="effect of yoga on anxiety disorders",
            year=2022, first_author="smith",
            all_author_lasts=["smith"],
        )
        clusters = OverlapDetector(config).detect([r1, r2])
        assert clusters == []

    def test_fuzzy_enabled_similar_titles_cluster(self):
        try:
            import rapidfuzz  # noqa: F401
        except ImportError:
            pytest.skip("rapidfuzz not installed")

        config = OverlapConfig(
            selected_fields=["title", "year", "first_author"],
            fuzzy_enabled=True,
            fuzzy_threshold=0.80,
            year_tolerance=0,
        )
        # Both titles share the same 15-char prefix ("yoga interventi")
        # so they will be placed in the same fuzzy blocking bucket.
        r1 = _make_record(
            norm_title="yoga intervention for stress reduction",
            year=2022, first_author="smith",
            all_author_lasts=["smith"],
        )
        r2 = _make_record(
            norm_title="yoga interventions for stress outcomes",
            year=2022, first_author="smith",
            all_author_lasts=["smith"],
        )
        clusters = OverlapDetector(config).detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier == 5

    def test_fuzzy_year_tolerance_1_allows_adjacent_years(self):
        try:
            import rapidfuzz  # noqa: F401
        except ImportError:
            pytest.skip("rapidfuzz not installed")

        config = OverlapConfig(
            selected_fields=["title", "year", "first_author"],
            fuzzy_enabled=True,
            fuzzy_threshold=0.80,
            year_tolerance=1,
        )
        r1 = _make_record(
            norm_title="yoga intervention for stress reduction",
            year=2021, first_author="smith",
            all_author_lasts=["smith"],
        )
        r2 = _make_record(
            norm_title="yoga interventions for stress reduction",
            year=2022, first_author="smith",
            all_author_lasts=["smith"],
        )
        clusters = OverlapDetector(config).detect([r1, r2])
        assert len(clusters) == 1

    def test_fuzzy_different_years_blocked(self):
        try:
            import rapidfuzz  # noqa: F401
        except ImportError:
            pytest.skip("rapidfuzz not installed")

        config = OverlapConfig(
            selected_fields=["title", "year"],
            fuzzy_enabled=True,
            fuzzy_threshold=0.80,
            year_tolerance=0,
        )
        r1 = _make_record(
            norm_title="mindfulness based cognitive therapy",
            year=2020, all_author_lasts=["jones"],
        )
        r2 = _make_record(
            norm_title="mindfulness based cognitive therapy outcomes",
            year=2023, all_author_lasts=["jones"],
        )
        clusters = OverlapDetector(config).detect([r1, r2])
        # Year diff = 3 > tolerance 0 → no fuzzy match
        assert clusters == []


# ---------------------------------------------------------------------------
# Scope classification
# ---------------------------------------------------------------------------

class TestScopeClassification:
    def test_within_source_cluster(self):
        src_id = uuid.uuid4()
        r1 = _make_record(doi="10.1/x", source_id=src_id)
        r2 = _make_record(doi="10.1/x", source_id=src_id)
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        unique_sources = {r.source_id for r in clusters[0].records}
        assert len(unique_sources) == 1  # within_source

    def test_cross_source_cluster(self):
        src_a, src_b = uuid.uuid4(), uuid.uuid4()
        r1 = _make_record(doi="10.1/x", source_id=src_a)
        r2 = _make_record(doi="10.1/x", source_id=src_b)
        clusters = _default_detector().detect([r1, r2])
        unique_sources = {r.source_id for r in clusters[0].records}
        assert len(unique_sources) == 2  # cross_source

    def test_within_source_pmid_acceptance(self):
        """3 PubMed records with same PMID → 1 cluster."""
        src_id = uuid.uuid4()
        pmid = "11223344"
        records = [_make_record(pmid=pmid, source_id=src_id) for _ in range(3)]
        clusters = _default_detector().detect(records)
        assert len(clusters) == 1
        assert len(clusters[0].records) == 3

    def test_cross_source_title_year_author(self):
        """Same title+year+author in PubMed and Embase, no DOI → cross-source cluster."""
        src_pubmed = uuid.uuid4()
        src_embase = uuid.uuid4()
        r1 = _make_record(
            norm_title="effectiveness of cbt for ocd", year=2020,
            first_author="brown", source_id=src_pubmed,
        )
        r2 = _make_record(
            norm_title="effectiveness of cbt for ocd", year=2020,
            first_author="brown", source_id=src_embase,
        )
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        unique_sources = {r.source_id for r in clusters[0].records}
        assert len(unique_sources) == 2


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

class TestDeterminism:
    def test_same_output_regardless_of_input_order(self):
        doi = "10.1/det"
        r1 = _make_record(doi=doi, sid=uuid.UUID("00000000-0000-0000-0000-000000000001"))
        r2 = _make_record(doi=doi, sid=uuid.UUID("00000000-0000-0000-0000-000000000002"))
        r3 = _make_record(doi="10.2/other", sid=uuid.UUID("00000000-0000-0000-0000-000000000003"))

        detector = _default_detector()
        result_a = detector.detect([r1, r2, r3])
        result_b = detector.detect([r3, r2, r1])

        assert len(result_a) == len(result_b)
        ids_a = frozenset(
            frozenset(str(r.record_source_id) for r in c.records)
            for c in result_a
        )
        ids_b = frozenset(
            frozenset(str(r.record_source_id) for r in c.records)
            for c in result_b
        )
        assert ids_a == ids_b


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_empty_list_returns_empty(self):
        assert _default_detector().detect([]) == []

    def test_single_record_returns_empty(self):
        assert _default_detector().detect([_make_record(doi="10.1/x")]) == []

    def test_no_doi_clusters_via_title(self):
        """Records without DOI still cluster via tier 3."""
        r1 = _make_record(norm_title="cognitive therapy for ptsd", year=2021, first_author="taylor")
        r2 = _make_record(norm_title="cognitive therapy for ptsd", year=2021, first_author="taylor")
        clusters = _default_detector().detect([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].tier in (2, 3)

    def test_select_representative_prefers_doi(self):
        r1 = _make_record(doi="10.1/x", pmid=None, norm_title="title", abstract_len=100)
        r2 = _make_record(doi=None, pmid="12345", norm_title="title", abstract_len=500)
        rep = select_representative([r1, r2])
        assert rep.record_source_id == r1.record_source_id

    def test_all_fields_disabled_no_clusters(self):
        config = OverlapConfig(selected_fields=[])
        r1 = _make_record(doi="10.1/x", pmid="123")
        r2 = _make_record(doi="10.1/x", pmid="123")
        clusters = OverlapDetector(config).detect([r1, r2])
        assert clusters == []
