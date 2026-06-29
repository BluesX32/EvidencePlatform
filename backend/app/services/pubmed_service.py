"""
PubMed search service.

Two capabilities:
1. generate_search_strategy() — calls Claude to turn a research question into
   an optimised PubMed search string with MeSH terms + free-text fallbacks.
2. execute_search() — runs esearch against the NCBI E-utilities API and returns
   a count + list of preview titles.
3. fetch_records_as_medline() — runs efetch to get full MEDLINE text, then
   hands it to the existing MEDLINE parser so records land in the DB via the
   normal import pipeline.

No API key is required for basic E-utilities access.  A key raises the rate
limit from 3 → 10 req/s; configure via NCBI_API_KEY env var if needed.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_NCBI_API_KEY = os.environ.get("NCBI_API_KEY", "")

# ── Helpers ───────────────────────────────────────────────────────────────────

def _ncbi_params(**kw: str) -> dict:
    p = {"tool": "EvidencePlatform", "email": "noreply@evidenceplatform.app", **kw}
    if _NCBI_API_KEY:
        p["api_key"] = _NCBI_API_KEY
    return p


# ── 1. Strategy generation ────────────────────────────────────────────────────

async def generate_search_strategy(
    research_question: str,
    model: str = "claude-haiku-4-5-20251001",
    api_key: Optional[str] = None,
) -> dict:
    """
    Returns {"query": str, "explanation": str, "pico": dict}.
    """
    import anthropic

    resolved_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not resolved_key:
        raise ValueError("No Anthropic API key — add one in Settings")
    client = anthropic.AsyncAnthropic(api_key=resolved_key)
    prompt = f"""You are an expert medical librarian. A researcher wants to search PubMed for papers relevant to this research question:

"{research_question}"

Generate a comprehensive PubMed search strategy. Return a JSON object with these fields:
- "query": the full PubMed search string, using MeSH terms in [MeSH] brackets, free-text synonyms with OR, field tags like [tiab], AND to combine concepts. Make it thorough but not overly broad.
- "explanation": 2-3 sentences explaining what the strategy covers and why.
- "pico": an object with keys "population", "intervention", "comparison", "outcome" (any can be null if not applicable).
- "suggested_filters": list of suggested PubMed filters as plain strings (e.g. "Randomized Controlled Trial[pt]", "English[lang]") — leave empty if none needed.

Return only valid JSON, no markdown fences."""

    message = await client.messages.create(
        model=model,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    import json
    text = message.content[0].text.strip()
    # Strip markdown fences if model adds them anyway
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"query": text, "explanation": "", "pico": {}, "suggested_filters": []}


# ── 2. Execute search (count + preview) ───────────────────────────────────────

async def execute_search(
    query: str,
    max_results: int = 200,
    filters: Optional[list[str]] = None,
) -> dict:
    """
    Returns {"total": int, "preview": [{"pmid": str, "title": str, "year": str}]}.
    """
    full_query = query
    if filters:
        full_query = f"({query}) AND ({' AND '.join(filters)})"

    async with httpx.AsyncClient(timeout=30) as client:
        # esearch to get count + PMIDs
        search_resp = await client.get(
            f"{_EUTILS_BASE}/esearch.fcgi",
            params=_ncbi_params(
                db="pubmed",
                term=full_query,
                retmax=str(min(max_results, 500)),
                retmode="json",
                usehistory="y",
            ),
        )
        search_resp.raise_for_status()
        search_data = search_resp.json()
        result = search_data.get("esearchresult", {})
        total = int(result.get("count", 0))
        pmids = result.get("idlist", [])

        if not pmids:
            return {"total": total, "preview": [], "webenv": "", "query_key": ""}

        web_env = result.get("webenv", "")
        query_key = result.get("querykey", "1")

        # efetch summary for preview (titles + years only)
        preview_pmids = pmids[:20]
        summary_resp = await client.get(
            f"{_EUTILS_BASE}/esummary.fcgi",
            params=_ncbi_params(
                db="pubmed",
                id=",".join(preview_pmids),
                retmode="json",
            ),
        )
        summary_resp.raise_for_status()
        summary_data = summary_resp.json()
        uid_map = summary_data.get("result", {})

        preview = []
        for pmid in preview_pmids:
            rec = uid_map.get(pmid, {})
            preview.append({
                "pmid": pmid,
                "title": rec.get("title", "(unknown title)"),
                "year": rec.get("pubdate", "")[:4],
                "authors": _fmt_authors(rec.get("authors", [])),
                "source": rec.get("source", ""),
            })

    return {
        "total": total,
        "preview": preview,
        "webenv": web_env,
        "query_key": query_key,
        "pmids": pmids,
    }


def _fmt_authors(authors: list) -> str:
    if not authors:
        return ""
    names = [a.get("name", "") for a in authors[:3]]
    suffix = " et al." if len(authors) > 3 else ""
    return ", ".join(names) + suffix


# ── 3. Fetch full MEDLINE text ────────────────────────────────────────────────

async def fetch_medline_bytes(
    pmids: list[str],
    chunk_size: int = 200,
) -> bytes:
    """
    Fetches full MEDLINE records for the given PMIDs in chunks.
    Returns raw bytes suitable for passing directly to parse_file().
    """
    chunks: list[bytes] = []
    async with httpx.AsyncClient(timeout=60) as client:
        for i in range(0, len(pmids), chunk_size):
            batch = pmids[i : i + chunk_size]
            resp = await client.get(
                f"{_EUTILS_BASE}/efetch.fcgi",
                params=_ncbi_params(
                    db="pubmed",
                    id=",".join(batch),
                    rettype="medline",
                    retmode="text",
                ),
            )
            resp.raise_for_status()
            chunks.append(resp.content)
            # Respect NCBI rate limit (3 req/s without key, 10 with)
            if i + chunk_size < len(pmids):
                await asyncio.sleep(0.4 if _NCBI_API_KEY else 0.35)

    return b"\n".join(chunks)
