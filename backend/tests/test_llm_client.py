"""Tests for the central LLM gateway (app/services/llm_client.py).

Covers provider routing, cost computation, prompt truncation, audit-row
writing (including the never-raises guarantee), and log-context attribution.
No network calls — provider backends are monkeypatched.
"""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models.llm_call import LlmCall
from app.services import llm_client
from app.services.llm_client import (
    LlmLogContext,
    LlmResult,
    _pick_provider,
    _truncate,
    call_llm,
    compute_cost_usd,
    cost_per_token,
    log_llm_call,
    set_llm_log_context,
)


# ── Provider routing ──────────────────────────────────────────────────────────

def test_bare_claude_prefers_anthropic_direct():
    assert _pick_provider("claude-sonnet-4-6", "sk-ant", "sk-or") == ("anthropic", "claude-sonnet-4-6")


def test_bare_claude_falls_back_to_openrouter_with_prefix():
    provider, model = _pick_provider("claude-haiku-4-5-20251001", None, "sk-or")
    assert provider == "openrouter"
    assert model == "anthropic/claude-haiku-4-5"


def test_prefixed_model_uses_openrouter():
    assert _pick_provider("openai/gpt-4o-mini", "sk-ant", "sk-or") == ("openrouter", "openai/gpt-4o-mini")


def test_anthropic_prefixed_model_strips_prefix_without_openrouter_key():
    assert _pick_provider("anthropic/claude-haiku-4-5", "sk-ant", None) == ("anthropic", "claude-haiku-4-5")


def test_no_keys_raises():
    with pytest.raises(ValueError):
        _pick_provider("claude-sonnet-4-6", None, None)


def test_non_claude_model_without_openrouter_key_raises():
    with pytest.raises(ValueError):
        _pick_provider("openai/gpt-4o", "sk-ant", None)


# ── Cost computation ──────────────────────────────────────────────────────────

def test_cost_known_model():
    # claude-sonnet-4-6: $3/M input, $15/M output
    assert float(compute_cost_usd("claude-sonnet-4-6", 1_000_000, 1_000_000)) == pytest.approx(18.0)


def test_cost_unknown_model_uses_default_pricing():
    assert cost_per_token("some/unknown-model") == cost_per_token(llm_client.DEFAULT_MODEL)


# ── Truncation ────────────────────────────────────────────────────────────────

def test_truncate_passthrough():
    assert _truncate("short", 100) == "short"
    assert _truncate(None, 100) is None


def test_truncate_long_text_marked():
    out = _truncate("x" * 200, 100)
    assert out.startswith("x" * 100)
    assert out.endswith(llm_client._TRUNCATION_MARK)


# ── Audit writing (integration: real DB, own engine per conftest pattern) ────

@pytest.fixture
async def own_session_factory(monkeypatch):
    """Bind llm_client's logging session factory to this test's event loop."""
    engine = create_async_engine(settings.database_url, echo=False)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(llm_client, "SessionLocal", factory)
    yield factory
    await engine.dispose()


async def _fetch_calls(factory, feature: str) -> list[LlmCall]:
    async with factory() as session:
        return (await session.execute(
            select(LlmCall).where(LlmCall.feature == feature)
        )).scalars().all()


@pytest.mark.asyncio
async def test_log_llm_call_writes_row_with_cost(own_session_factory):
    feature = f"test.{uuid.uuid4().hex[:12]}"
    await log_llm_call(
        feature=feature,
        provider="anthropic",
        model="claude-sonnet-4-6",
        input_tokens=1000,
        output_tokens=500,
        latency_ms=42,
        system_prompt="sys",
        prompt="hello",
        response="world",
    )
    rows = await _fetch_calls(own_session_factory, feature)
    assert len(rows) == 1
    row = rows[0]
    assert row.status == "ok"
    assert row.input_tokens == 1000
    assert row.output_tokens == 500
    assert float(row.cost_usd) == pytest.approx(1000 * 3e-6 + 500 * 15e-6)
    assert row.prompt == "hello"
    assert row.response == "world"


@pytest.mark.asyncio
async def test_log_llm_call_never_raises(monkeypatch):
    """A broken session factory must not propagate — audit failures can't break calls."""
    def _boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(llm_client, "SessionLocal", _boom)
    await log_llm_call(feature="test.no-raise", provider="anthropic", model="claude-sonnet-4-6")


@pytest.mark.asyncio
async def test_log_context_supplies_attribution(own_session_factory):
    from app.models.user import User

    feature = f"test.{uuid.uuid4().hex[:12]}"
    run_user = uuid.uuid4()
    async with own_session_factory() as session:
        session.add(User(
            id=run_user,
            email=f"llmclient-test-{run_user.hex[:8]}@example.org",
            password_hash="x",
            name="llm_client test user",
        ))
        await session.commit()
    set_llm_log_context(LlmLogContext(feature="ignored", user_id=run_user))
    try:
        await log_llm_call(
            feature=feature, provider="anthropic", model="claude-sonnet-4-6"
        )
    finally:
        set_llm_log_context(None)
    rows = await _fetch_calls(own_session_factory, feature)
    assert len(rows) == 1
    assert rows[0].user_id == run_user


@pytest.mark.asyncio
async def test_call_llm_success_audits(own_session_factory, monkeypatch):
    feature = f"test.{uuid.uuid4().hex[:12]}"

    async def fake_anthropic(model, prompt, system, max_tokens, api_key):
        return LlmResult(text="hi", input_tokens=10, output_tokens=5,
                         provider="anthropic", model=model)

    monkeypatch.setattr(llm_client, "_call_anthropic_text", fake_anthropic)
    result = await call_llm(
        feature=feature,
        model="claude-sonnet-4-6",
        prompt="p",
        system="s",
        anthropic_key="sk-ant",
    )
    assert result.text == "hi"
    rows = await _fetch_calls(own_session_factory, feature)
    assert len(rows) == 1
    assert rows[0].status == "ok"
    assert rows[0].input_tokens == 10
    assert rows[0].latency_ms is not None
    assert rows[0].cost_usd is not None


@pytest.mark.asyncio
async def test_call_llm_error_audits_and_reraises(own_session_factory, monkeypatch):
    feature = f"test.{uuid.uuid4().hex[:12]}"

    async def fake_anthropic(model, prompt, system, max_tokens, api_key):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(llm_client, "_call_anthropic_text", fake_anthropic)
    with pytest.raises(RuntimeError, match="provider exploded"):
        await call_llm(
            feature=feature,
            model="claude-sonnet-4-6",
            prompt="p",
            anthropic_key="sk-ant",
        )
    rows = await _fetch_calls(own_session_factory, feature)
    assert len(rows) == 1
    assert rows[0].status == "error"
    assert "provider exploded" in rows[0].error_message
    assert rows[0].cost_usd is None
