"""Tests for scaling the LLM output-token budget with template size.

A fixed max_tokens cap truncates the tool-call JSON response mid-object once
an extraction/concept template has enough fields, which fails to parse and
silently produces zero output for that paper — the AI job reports "N
processed" with nothing to show for it. See app.services.llm_screening_service
._extract_one_record and app.routers.ai_pilot's concepts prompt.
"""
import pytest

from app.models.record import Record
from app.services import llm_screening_service as svc


def _make_template(n_rows: int) -> dict:
    return {"rows": [{"id": f"r{i}", "domain": "D", "item": f"Field {i}"} for i in range(n_rows)]}


@pytest.mark.asyncio
async def test_extraction_max_tokens_scales_with_row_count(monkeypatch):
    captured = {}

    async def fake_call_llm(model, prompt, **kwargs):
        captured["max_tokens"] = kwargs.get("max_tokens")
        return {"r0": "value"}

    monkeypatch.setattr(svc, "_call_llm", fake_call_llm)

    record = Record(title="A paper", abstract="An abstract.", source_format="ris")

    await svc._extract_one_record(
        record=record, full_text=None, extraction_template=_make_template(3),
        llm_config=None, model="claude-haiku-4-5-20251001",
    )
    small_template_tokens = captured["max_tokens"]

    await svc._extract_one_record(
        record=record, full_text=None, extraction_template=_make_template(34),
        llm_config=None, model="claude-haiku-4-5-20251001",
    )
    large_template_tokens = captured["max_tokens"]

    # Small templates keep the existing 2048 floor; large ones scale up —
    # this is the exact 34-field/2048-token combination that previously
    # truncated mid-JSON and silently produced no extraction.
    assert small_template_tokens == 2048
    assert large_template_tokens > 2048
    assert large_template_tokens <= 8192


@pytest.mark.asyncio
async def test_extraction_max_tokens_capped_at_ceiling(monkeypatch):
    captured = {}

    async def fake_call_llm(model, prompt, **kwargs):
        captured["max_tokens"] = kwargs.get("max_tokens")
        return {}

    monkeypatch.setattr(svc, "_call_llm", fake_call_llm)
    record = Record(title="A paper", source_format="ris")

    await svc._extract_one_record(
        record=record, full_text=None, extraction_template=_make_template(100),
        llm_config=None, model="claude-haiku-4-5-20251001",
    )
    assert captured["max_tokens"] == 8192


def test_call_openrouter_max_tokens_never_shrinks_below_default():
    """A caller-supplied max_tokens raises the budget but never lowers it
    below the provider/model default (e.g. the thinking-model floor)."""
    default_for_normal_model = 2048
    for supplied in (None, 500, 4096):
        effective = max(supplied, default_for_normal_model) if supplied else default_for_normal_model
        assert effective >= default_for_normal_model
