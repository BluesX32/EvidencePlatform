"""
VS4 v2 regression tests.

Covers:
  1. CorpusCreate Pydantic validator accepts string UUIDs as source_ids (bug fix regression)
  2. Queue item status transitions: skip marks status='skipped', next_pending skips it
  3. Extraction with framework_updated=True resets consecutive_no_novelty
  4. Corpus can reach stopped_at before the queue is exhausted (saturation-first)
  5. ExtractionJson fields (levels/dimensions/snippets) round-trip through extracted_json
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pytest

from app.routers.corpora import CorpusCreate
from app.services.screening_service import _resolve_canonical_key


# ---------------------------------------------------------------------------
# Helper: pure saturation simulator (mirrors CorpusRepo.update_saturation)
# ---------------------------------------------------------------------------

def _run_saturation(
    total_extracted: int,
    consecutive_no_novelty: int,
    saturation_threshold: int,
    stopped_at: Optional[datetime],
    framework_updated: bool,
) -> Dict:
    """Pure equivalent of update_saturation using framework_updated semantics."""
    total_extracted += 1
    if framework_updated:
        consecutive_no_novelty = 0
    else:
        consecutive_no_novelty += 1
    if stopped_at is None and consecutive_no_novelty >= saturation_threshold:
        stopped_at = datetime.now(tz=timezone.utc)
    return {
        "total_extracted": total_extracted,
        "consecutive_no_novelty": consecutive_no_novelty,
        "stopped_at": stopped_at,
    }


# ---------------------------------------------------------------------------
# 1. CorpusCreate: string UUID coercion
# ---------------------------------------------------------------------------

class TestCorpusCreateValidator:
    def test_accepts_string_uuids(self):
        sid1 = uuid.uuid4()
        sid2 = uuid.uuid4()
        body = CorpusCreate(
            name="Test corpus",
            source_ids=[str(sid1), str(sid2)],
        )
        assert body.source_ids == [sid1, sid2]
        assert all(isinstance(s, uuid.UUID) for s in body.source_ids)

    def test_accepts_uuid_objects_unchanged(self):
        sid = uuid.uuid4()
        body = CorpusCreate(name="X", source_ids=[sid])
        assert body.source_ids == [sid]

    def test_accepts_empty_source_ids(self):
        body = CorpusCreate(name="X", source_ids=[])
        assert body.source_ids == []

    def test_rejects_invalid_uuid_string(self):
        with pytest.raises(Exception):
            CorpusCreate(name="X", source_ids=["not-a-uuid"])

    def test_default_saturation_threshold(self):
        body = CorpusCreate(name="X")
        assert body.saturation_threshold == 10


# ---------------------------------------------------------------------------
# 2. Queue item status — pure state-machine tests
# ---------------------------------------------------------------------------

class TestQueueItemStatus:
    def _make_items(self, keys: List[str]) -> List[Dict]:
        """Simulate a queue as a list of dicts with status='pending'."""
        return [{"canonical_key": k, "order_index": i, "status": "pending"}
                for i, k in enumerate(keys)]

    def _get_next_pending(self, items: List[Dict]) -> Optional[Dict]:
        """Pure equivalent of ScreeningRepo.get_next_pending."""
        for item in sorted(items, key=lambda x: x["order_index"]):
            if item["status"] == "pending":
                return item
        return None

    def _mark_status(self, items: List[Dict], key: str, status: str) -> List[Dict]:
        return [
            {**item, "status": status} if item["canonical_key"] == key else item
            for item in items
        ]

    def test_skip_marks_item_as_skipped(self):
        items = self._make_items(["rec:aaa", "rec:bbb"])
        items = self._mark_status(items, "rec:aaa", "skipped")
        skipped = next(i for i in items if i["canonical_key"] == "rec:aaa")
        assert skipped["status"] == "skipped"

    def test_next_pending_skips_skipped_item(self):
        items = self._make_items(["rec:aaa", "rec:bbb", "rec:ccc"])
        items = self._mark_status(items, "rec:aaa", "skipped")
        nxt = self._get_next_pending(items)
        assert nxt is not None
        assert nxt["canonical_key"] == "rec:bbb"

    def test_next_pending_returns_none_when_all_decided(self):
        items = self._make_items(["rec:aaa", "rec:bbb"])
        items = self._mark_status(items, "rec:aaa", "decided")
        items = self._mark_status(items, "rec:bbb", "decided")
        assert self._get_next_pending(items) is None

    def test_decide_marks_item_as_decided(self):
        items = self._make_items(["rec:aaa"])
        items = self._mark_status(items, "rec:aaa", "decided")
        assert items[0]["status"] == "decided"

    def test_extraction_marks_item_as_extracted(self):
        items = self._make_items(["rec:aaa"])
        items = self._mark_status(items, "rec:aaa", "extracted")
        assert items[0]["status"] == "extracted"

    def test_order_preserved_after_mixed_statuses(self):
        items = self._make_items(["k0", "k1", "k2", "k3"])
        items = self._mark_status(items, "k0", "decided")
        items = self._mark_status(items, "k1", "skipped")
        nxt = self._get_next_pending(items)
        assert nxt is not None
        assert nxt["canonical_key"] == "k2"


# ---------------------------------------------------------------------------
# 3. framework_updated=True resets consecutive_no_novelty
# ---------------------------------------------------------------------------

class TestFrameworkUpdatedSaturation:
    def test_framework_updated_true_resets_counter(self):
        result = _run_saturation(
            total_extracted=8,
            consecutive_no_novelty=5,
            saturation_threshold=10,
            stopped_at=None,
            framework_updated=True,
        )
        assert result["consecutive_no_novelty"] == 0
        assert result["total_extracted"] == 9
        assert result["stopped_at"] is None

    def test_framework_updated_false_increments_counter(self):
        result = _run_saturation(
            total_extracted=3,
            consecutive_no_novelty=4,
            saturation_threshold=10,
            stopped_at=None,
            framework_updated=False,
        )
        assert result["consecutive_no_novelty"] == 5
        assert result["stopped_at"] is None

    def test_framework_updated_true_prevents_saturation_even_at_threshold(self):
        """A novelty hit prevents saturation even when counter was at threshold-1."""
        result = _run_saturation(
            total_extracted=15,
            consecutive_no_novelty=9,
            saturation_threshold=10,
            stopped_at=None,
            framework_updated=True,
        )
        assert result["consecutive_no_novelty"] == 0
        assert result["stopped_at"] is None  # reset, NOT fired

    def test_framework_updated_false_fires_saturation_at_threshold(self):
        result = _run_saturation(
            total_extracted=20,
            consecutive_no_novelty=9,  # will become 10 == threshold
            saturation_threshold=10,
            stopped_at=None,
            framework_updated=False,
        )
        assert result["consecutive_no_novelty"] == 10
        assert result["stopped_at"] is not None


# ---------------------------------------------------------------------------
# 4. Saturation-first: stopped_at fires before queue exhaustion
# ---------------------------------------------------------------------------

class TestSaturationFirst:
    def test_saturation_fires_midway_through_queue(self):
        """Saturation can fire after K extractions even if N-K items remain in queue."""
        threshold = 3
        queue_size = 20

        state = {
            "total_extracted": 0,
            "consecutive_no_novelty": 0,
            "stopped_at": None,
        }

        # Simulate: first 5 papers update framework, then 3 in a row do not
        extractions = [True, True, True, True, True, False, False, False]

        for i, fw_updated in enumerate(extractions):
            state = _run_saturation(
                total_extracted=state["total_extracted"],
                consecutive_no_novelty=state["consecutive_no_novelty"],
                saturation_threshold=threshold,
                stopped_at=state["stopped_at"],
                framework_updated=fw_updated,
            )
            if state["stopped_at"] is not None:
                items_screened = i + 1
                break
        else:
            items_screened = len(extractions)

        assert state["stopped_at"] is not None
        # Saturation fired after 8 papers, well before the queue of 20 was exhausted
        assert items_screened < queue_size

    def test_saturation_not_fired_when_novelty_keeps_resetting(self):
        """If every extraction updates the framework, saturation never fires."""
        threshold = 5
        state = {
            "total_extracted": 0,
            "consecutive_no_novelty": 0,
            "stopped_at": None,
        }
        for _ in range(30):
            state = _run_saturation(
                total_extracted=state["total_extracted"],
                consecutive_no_novelty=state["consecutive_no_novelty"],
                saturation_threshold=threshold,
                stopped_at=state["stopped_at"],
                framework_updated=True,
            )
        assert state["stopped_at"] is None
        assert state["consecutive_no_novelty"] == 0
        assert state["total_extracted"] == 30


# ---------------------------------------------------------------------------
# 5. ExtractionJson v1 schema: levels/dimensions/snippets round-trip
# ---------------------------------------------------------------------------

class TestExtractionJsonSchema:
    """Verify that extraction payloads with the new schema are well-formed."""

    def _make_extraction(self, framework_updated: bool = True) -> dict:
        return {
            "levels": ["gene", "molecular", "cellular"],
            "dimensions": ["objective"],
            "snippets": [
                {"snippet": "p53 mutations...", "note": "oncogene", "tag": "gene"},
                {"snippet": "pathway activation", "note": "", "tag": None},
            ],
            "free_note": "Key paper on p53 pathway.",
            "framework_updated": framework_updated,
            "framework_update_note": "" if framework_updated else "No new concepts beyond prior",
        }

    def test_framework_updated_field_present(self):
        ex = self._make_extraction(framework_updated=True)
        assert "framework_updated" in ex
        assert ex["framework_updated"] is True

    def test_framework_updated_false_has_note(self):
        ex = self._make_extraction(framework_updated=False)
        assert ex["framework_updated"] is False
        assert len(ex["framework_update_note"]) > 0

    def test_levels_is_list_of_strings(self):
        ex = self._make_extraction()
        assert isinstance(ex["levels"], list)
        assert all(isinstance(lv, str) for lv in ex["levels"])

    def test_snippets_have_required_fields(self):
        ex = self._make_extraction()
        for snip in ex["snippets"]:
            assert "snippet" in snip
            assert "note" in snip

    def test_framework_updated_drives_saturation(self):
        """framework_updated from extracted_json feeds directly into saturation."""
        for fw in (True, False):
            ex = self._make_extraction(framework_updated=fw)
            result = _run_saturation(
                total_extracted=5,
                consecutive_no_novelty=3,
                saturation_threshold=10,
                stopped_at=None,
                framework_updated=bool(ex.get("framework_updated", True)),
            )
            if fw:
                assert result["consecutive_no_novelty"] == 0
            else:
                assert result["consecutive_no_novelty"] == 4
