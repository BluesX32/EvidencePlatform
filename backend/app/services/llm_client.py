"""Central LLM gateway — every LLM call in the platform goes through here.

Two responsibilities:
  1. call_llm()      — provider routing (Anthropic direct / OpenRouter) for
                       plain-text calls, replacing the per-router copies.
  2. log_llm_call()  — audit every call (any caller, including the screening
                       service's own tool-use machinery) to the llm_calls
                       table: who, what feature, which model, tokens, cost,
                       latency, prompt, and response.

Reproducibility principle: non-deterministic steps are logged with inputs,
model version, and outputs. Logging uses its own DB session so an audit row
survives a caller rollback, and a logging failure never breaks the call.
"""
from __future__ import annotations

import contextvars
import logging
import os
import time
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from app.database import SessionLocal

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pricing table (USD per token) — covers direct Anthropic + OpenRouter models
# OpenRouter prices: https://openrouter.ai/models
# ---------------------------------------------------------------------------

PRICING: dict[str, tuple[float, float]] = {
    # ── Claude (Anthropic direct or via OpenRouter) ────────────────────────
    "claude-haiku-4-5-20251001":          (0.80 / 1_000_000,   4.00 / 1_000_000),
    "claude-sonnet-4-6":                  (3.00 / 1_000_000,  15.00 / 1_000_000),
    "claude-opus-4-6":                    (15.00 / 1_000_000, 75.00 / 1_000_000),
    # ── OpenAI via OpenRouter ─────────────────────────────────────────────
    "openai/gpt-4o-mini":                 (0.15 / 1_000_000,   0.60 / 1_000_000),
    "openai/gpt-4o":                      (2.50 / 1_000_000,  10.00 / 1_000_000),
    "openai/o1-mini":                     (1.10 / 1_000_000,   4.40 / 1_000_000),
    "openai/o3-mini":                     (1.10 / 1_000_000,   4.40 / 1_000_000),
    "openai/gpt-5.3-chat":                (8.00 / 1_000_000,  24.00 / 1_000_000),
    "openai/gpt-5.4":                     (10.00 / 1_000_000, 30.00 / 1_000_000),
    "openai/gpt-5.4-pro":                 (117.00 / 1_000_000, 117.00 / 1_000_000),
    # ── Google Gemini via OpenRouter ──────────────────────────────────────
    "google/gemini-flash-1.5":            (0.075 / 1_000_000,  0.30 / 1_000_000),
    "google/gemini-pro-1.5":              (1.25 / 1_000_000,   5.00 / 1_000_000),
    "google/gemini-2.0-flash-001":        (0.10 / 1_000_000,   0.40 / 1_000_000),
    "google/gemini-2.5-pro-preview":      (1.25 / 1_000_000,  10.00 / 1_000_000),
    "google/gemini-3-flash-preview":      (0.15 / 1_000_000,   0.60 / 1_000_000),
    "google/gemini-3.1-flash-lite-preview": (0.05 / 1_000_000, 0.20 / 1_000_000),
    "google/gemini-3.1-pro-preview":      (8.00 / 1_000_000,  24.00 / 1_000_000),
    # ── Meta Llama via OpenRouter ─────────────────────────────────────────
    "meta-llama/llama-3.3-70b-instruct":  (0.12 / 1_000_000,  0.30 / 1_000_000),
    "meta-llama/llama-3.1-405b-instruct": (2.70 / 1_000_000,  2.70 / 1_000_000),
    "meta-llama/llama-4-scout":           (0.15 / 1_000_000,  0.60 / 1_000_000),
    "meta-llama/llama-4-maverick":        (0.90 / 1_000_000,  2.70 / 1_000_000),
    # ── Mistral via OpenRouter ─────────────────────────────────────────────
    "mistralai/mistral-small":            (0.10 / 1_000_000,   0.30 / 1_000_000),
    "mistralai/mistral-small-3.1":        (0.10 / 1_000_000,   0.30 / 1_000_000),
    "mistralai/mistral-large":            (2.00 / 1_000_000,   6.00 / 1_000_000),
    "mistralai/mistral-large-2512":       (1.35 / 1_000_000,   4.05 / 1_000_000),
    "mistralai/ministral-8b-2512":        (0.28 / 1_000_000,   0.84 / 1_000_000),
    # ── DeepSeek via OpenRouter ───────────────────────────────────────────
    "deepseek/deepseek-chat":             (0.14 / 1_000_000,   0.28 / 1_000_000),
    "deepseek/deepseek-r1":               (0.55 / 1_000_000,   2.19 / 1_000_000),
    "deepseek/deepseek-v3.2":             (0.55 / 1_000_000,   1.65 / 1_000_000),
    # ── Qwen (Alibaba) via OpenRouter ────────────────────────────────────
    "qwen/qwen3.5-plus-02-15":            (0.50 / 1_000_000,   1.50 / 1_000_000),
    "qwen/qwen3-max-thinking":            (1.80 / 1_000_000,   5.40 / 1_000_000),
    # ── NVIDIA Nemotron (free) via OpenRouter ─────────────────────────────
    "nvidia/nemotron-3-super-120b-a12b:free": (0.00 / 1_000_000, 0.00 / 1_000_000),
    # ── Cohere via OpenRouter ─────────────────────────────────────────────
    "cohere/command-a-03-2025":           (2.50 / 1_000_000,  10.00 / 1_000_000),
}

DEFAULT_MODEL = "claude-sonnet-4-6"


def cost_per_token(model: str) -> tuple[float, float]:
    """Return (input_price_per_token, output_price_per_token) in USD."""
    return PRICING.get(model, PRICING[DEFAULT_MODEL])


def compute_cost_usd(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    in_price, out_price = cost_per_token(model)
    return Decimal(str(round(input_tokens * in_price + output_tokens * out_price, 6)))


# ---------------------------------------------------------------------------
# Log context — batch pipelines set this once so every nested LLM call is
# attributed to the right project/run/user without threading params through
# every helper.
# ---------------------------------------------------------------------------

@dataclass
class LlmLogContext:
    feature: str
    project_id: Optional[uuid.UUID] = None
    user_id: Optional[uuid.UUID] = None
    run_id: Optional[uuid.UUID] = None
    ai_job_id: Optional[uuid.UUID] = None


_log_context: contextvars.ContextVar[Optional[LlmLogContext]] = contextvars.ContextVar(
    "llm_log_context", default=None
)


def set_llm_log_context(ctx: Optional[LlmLogContext]) -> None:
    _log_context.set(ctx)


def get_llm_log_context() -> Optional[LlmLogContext]:
    return _log_context.get()


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

# Full-text screening prompts can reach hundreds of KB; cap stored text so the
# audit table stays queryable while keeping enough to reproduce/debug a call.
_MAX_PROMPT_CHARS = 100_000
_MAX_RESPONSE_CHARS = 50_000
_TRUNCATION_MARK = "\n…[truncated for audit log]"


def _truncate(text: Optional[str], limit: int) -> Optional[str]:
    if text is None or len(text) <= limit:
        return text
    return text[:limit] + _TRUNCATION_MARK


async def log_llm_call(
    *,
    feature: str,
    provider: str,
    model: str,
    status: str = "ok",
    error_message: Optional[str] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    latency_ms: Optional[int] = None,
    system_prompt: Optional[str] = None,
    prompt: Optional[str] = None,
    response: Optional[str] = None,
    project_id: Optional[uuid.UUID] = None,
    user_id: Optional[uuid.UUID] = None,
    run_id: Optional[uuid.UUID] = None,
    ai_job_id: Optional[uuid.UUID] = None,
) -> Optional[uuid.UUID]:
    """Insert one llm_calls audit row in its own session; never raises.

    Returns the created row's id (for callers that need to link a downstream
    artifact — e.g. a concept mention — back to the exact call that produced
    it), or None if logging itself failed.
    """
    from app.models.llm_call import LlmCall  # local import to avoid model/service cycles

    ctx = _log_context.get()
    if ctx is not None:
        project_id = project_id or ctx.project_id
        user_id = user_id or ctx.user_id
        run_id = run_id or ctx.run_id
        ai_job_id = ai_job_id or ctx.ai_job_id

    cost = (
        compute_cost_usd(model, input_tokens, output_tokens)
        if status == "ok" and input_tokens is not None and output_tokens is not None
        else None
    )
    try:
        async with SessionLocal() as session:
            call = LlmCall(
                feature=feature,
                provider=provider,
                model=model,
                status=status,
                error_message=_truncate(error_message, 2_000),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
                latency_ms=latency_ms,
                system_prompt=_truncate(system_prompt, _MAX_PROMPT_CHARS),
                prompt=_truncate(prompt, _MAX_PROMPT_CHARS),
                response=_truncate(response, _MAX_RESPONSE_CHARS),
                project_id=project_id,
                user_id=user_id,
                run_id=run_id,
                ai_job_id=ai_job_id,
            )
            session.add(call)
            await session.commit()
            return call.id
    except Exception:
        logger.exception("Failed to write llm_calls audit row (feature=%s)", feature)
        return None


# ---------------------------------------------------------------------------
# Plain-text calls (non-tool-use) — the shared path for search strategy,
# AI Pilot, thematic AI-assign, consensus suggestions, and report drafts.
# ---------------------------------------------------------------------------

@dataclass
class LlmResult:
    text: str
    input_tokens: int
    output_tokens: int
    provider: str
    model: str
    call_id: Optional[uuid.UUID] = None


def _pick_provider(
    model: str, anthropic_key: Optional[str], openrouter_key: Optional[str]
) -> tuple[str, str]:
    """Return (provider, effective_model). Anthropic direct for bare claude-*
    models when a key exists; otherwise OpenRouter (converting bare claude-*
    names to their provider-prefixed OpenRouter ids)."""
    if not anthropic_key and not openrouter_key:
        raise ValueError("No API key configured — add an Anthropic or OpenRouter key in Settings")
    is_bare_claude = model.startswith("claude-") and "/" not in model
    if is_bare_claude and anthropic_key:
        return "anthropic", model
    if not openrouter_key:
        if model.startswith("anthropic/claude-") and anthropic_key:
            return "anthropic", model.split("/", 1)[1]
        raise ValueError(f"Model {model} requires an OpenRouter key — add one in Settings")
    if is_bare_claude:
        # Strip date suffixes: OpenRouter ids are undated (anthropic/claude-haiku-4-5)
        model = f"anthropic/{model.rsplit('-2025', 1)[0].rsplit('-2024', 1)[0]}"
    return "openrouter", model


async def call_llm(
    *,
    feature: str,
    model: str,
    prompt: str,
    system: Optional[str] = None,
    max_tokens: int = 2048,
    anthropic_key: Optional[str] = None,
    openrouter_key: Optional[str] = None,
    project_id: Optional[uuid.UUID] = None,
    user_id: Optional[uuid.UUID] = None,
    run_id: Optional[uuid.UUID] = None,
    ai_job_id: Optional[uuid.UUID] = None,
) -> LlmResult:
    """Make a plain-text LLM call, audit it, and return the response text + usage."""
    provider, effective_model = _pick_provider(model, anthropic_key, openrouter_key)
    started = time.monotonic()

    async def _log(status: str, result: Optional[LlmResult], error: Optional[str]) -> Optional[uuid.UUID]:
        return await log_llm_call(
            feature=feature,
            provider=provider,
            model=effective_model,
            status=status,
            error_message=error,
            input_tokens=result.input_tokens if result else None,
            output_tokens=result.output_tokens if result else None,
            latency_ms=int((time.monotonic() - started) * 1000),
            system_prompt=system,
            prompt=prompt,
            response=result.text if result else None,
            project_id=project_id,
            user_id=user_id,
            run_id=run_id,
            ai_job_id=ai_job_id,
        )

    try:
        if provider == "anthropic":
            result = await _call_anthropic_text(
                effective_model, prompt, system, max_tokens, anthropic_key
            )
        else:
            result = await _call_openrouter_text(
                effective_model, prompt, system, max_tokens, openrouter_key
            )
    except Exception as exc:
        await _log("error", None, str(exc))
        raise
    result.call_id = await _log("ok", result, None)
    return result


async def _call_anthropic_text(
    model: str,
    prompt: str,
    system: Optional[str],
    max_tokens: int,
    api_key: Optional[str],
) -> LlmResult:
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))
    kwargs: dict = {}
    if system:
        kwargs["system"] = system
    resp = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
        **kwargs,
    )
    return LlmResult(
        text=resp.content[0].text.strip() if resp.content else "",
        input_tokens=resp.usage.input_tokens,
        output_tokens=resp.usage.output_tokens,
        provider="anthropic",
        model=model,
    )


async def _call_openrouter_text(
    model: str,
    prompt: str,
    system: Optional[str],
    max_tokens: int,
    api_key: Optional[str],
) -> LlmResult:
    from openai import AsyncOpenAI  # type: ignore

    client = AsyncOpenAI(
        api_key=api_key or os.environ.get("OPENROUTER_API_KEY"),
        base_url="https://openrouter.ai/api/v1",
        default_headers={"HTTP-Referer": "https://evidence-platform", "X-Title": "EvidencePlatform"},
    )
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    resp = await client.chat.completions.create(
        model=model, max_tokens=max_tokens, messages=messages
    )
    usage = resp.usage
    return LlmResult(
        text=(resp.choices[0].message.content or "").strip() if resp.choices else "",
        input_tokens=getattr(usage, "prompt_tokens", 0) or 0,
        output_tokens=getattr(usage, "completion_tokens", 0) or 0,
        provider="openrouter",
        model=model,
    )
