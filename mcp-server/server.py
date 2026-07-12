"""EvidencePlatform MCP Server.

Exposes EvidencePlatform's REST API as MCP tools so Claude can control the
platform programmatically: manage projects, import literature, run
deduplication, screen records, launch LLM screening runs, and review results.

Configuration (environment variables):
    EVIDENCE_API_URL      Base URL of the EvidencePlatform backend
                          (default: http://localhost:8000)
    EVIDENCE_API_TOKEN    Pre-existing JWT token (optional)
    EVIDENCE_USERNAME     Username for auto-login (used if no token provided)
    EVIDENCE_PASSWORD     Password for auto-login

Usage:
    pip install -r requirements.txt
    export EVIDENCE_USERNAME=researcher@example.com
    export EVIDENCE_PASSWORD=yourpassword
    python server.py
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("EVIDENCE_API_URL", "http://localhost:8000").rstrip("/")

mcp = FastMCP(
    name="EvidencePlatform",
    instructions=(
        "You have access to EvidencePlatform, an open-source systematic review "
        "and evidence synthesis platform. Use the provided tools to manage projects, "
        "import literature, run deduplication, screen records, and review LLM-assisted "
        "screening results. Always check the project_id before performing project-scoped "
        "operations. Screening decisions must be 'include', 'exclude', or 'uncertain'."
    ),
)


# ---------------------------------------------------------------------------
# HTTP client with lazy auth
# ---------------------------------------------------------------------------

_token: Optional[str] = None


async def _get_token() -> str:
    global _token
    if _token:
        return _token

    env_token = os.environ.get("EVIDENCE_API_TOKEN")
    if env_token:
        _token = env_token
        return _token

    username = os.environ.get("EVIDENCE_USERNAME")
    password = os.environ.get("EVIDENCE_PASSWORD")
    if not username or not password:
        raise RuntimeError(
            "Set EVIDENCE_API_TOKEN or both EVIDENCE_USERNAME and EVIDENCE_PASSWORD."
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/login",
            json={"email": username, "password": password},
        )
        resp.raise_for_status()
        _token = resp.json()["access_token"]
    return _token


async def _request(
    method: str,
    path: str,
    *,
    params: Optional[dict] = None,
    json_body: Optional[Any] = None,
    files: Optional[Any] = None,
    data: Optional[dict] = None,
    extra_headers: Optional[dict] = None,
) -> Any:
    """Authenticated request to the EvidencePlatform API."""
    token = await _get_token()
    headers = {"Authorization": f"Bearer {token}"}
    if extra_headers:
        headers.update(extra_headers)

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.request(
            method,
            f"{BASE_URL}{path}",
            params=params,
            json=json_body,
            files=files,
            data=data,
            headers=headers,
        )
        resp.raise_for_status()
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()


# ---------------------------------------------------------------------------
# Tools: Projects
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_projects() -> str:
    """List all EvidencePlatform projects the authenticated user has access to.

    Returns a JSON array of projects, each with id, name, description,
    record_count, and my_role.
    """
    result = await _request("GET", "/projects")
    return json.dumps(result, indent=2)


@mcp.tool()
async def create_project(name: str, description: str = "") -> str:
    """Create a new evidence synthesis project.

    Args:
        name: Project name (required).
        description: Optional description of the review scope.

    Returns the newly created project with its id.
    """
    body = {"name": name, "description": description or None}
    result = await _request("POST", "/projects", json_body=body)
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_project(project_id: str) -> str:
    """Get details for a specific project including its inclusion/exclusion criteria.

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}")
    return json.dumps(result, indent=2)


@mcp.tool()
async def update_project_criteria(
    project_id: str,
    inclusion_criteria: list[str],
    exclusion_criteria: list[str],
) -> str:
    """Set the inclusion and exclusion criteria for a project.

    Args:
        project_id: UUID of the project.
        inclusion_criteria: List of inclusion criterion texts.
            Example: ["Randomised controlled trial", "Adults aged 18+"]
        exclusion_criteria: List of exclusion criterion texts.
            Example: ["Non-English language", "Conference abstracts only"]
    """
    import uuid

    inclusion = [{"id": str(uuid.uuid4()), "text": t} for t in inclusion_criteria]
    exclusion = [{"id": str(uuid.uuid4()), "text": t} for t in exclusion_criteria]
    body = {"inclusion": inclusion, "exclusion": exclusion}
    result = await _request("PATCH", f"/projects/{project_id}/criteria", json_body=body)
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Sources & Imports
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_sources(project_id: str) -> str:
    """List all literature sources (import batches) for a project.

    Args:
        project_id: UUID of the project.

    Returns source names, record counts, and dedup status.
    """
    result = await _request("GET", f"/projects/{project_id}/sources")
    return json.dumps(result, indent=2)


@mcp.tool()
async def list_import_jobs(project_id: str) -> str:
    """List all import jobs for a project, showing their status and record counts.

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}/imports")
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Records
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_records(
    project_id: str,
    page: int = 1,
    page_size: int = 25,
    search: str = "",
    status_filter: str = "",
    sort: str = "created_desc",
) -> str:
    """List records (articles) in a project with pagination and filtering.

    Args:
        project_id: UUID of the project.
        page: Page number (1-indexed).
        page_size: Records per page (max 200).
        search: Free-text search across title, abstract, and authors.
        status_filter: Filter by screening status — 'unscreened', 'included',
            or 'excluded'. Leave empty for all records.
        sort: Sort order. Options: title_asc, title_desc, year_asc, year_desc,
            author_asc, author_desc, created_asc, created_desc.

    Returns paginated list with total count.
    """
    params: dict[str, Any] = {"page": page, "page_size": page_size, "sort": sort}
    if search:
        params["search"] = search
    if status_filter:
        params["status"] = status_filter
    result = await _request("GET", f"/projects/{project_id}/records", params=params)
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_record(project_id: str, record_id: str) -> str:
    """Get full details for a single record including abstract, authors, DOI.

    Args:
        project_id: UUID of the project.
        record_id: UUID of the record.
    """
    result = await _request("GET", f"/projects/{project_id}/records/{record_id}")
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Deduplication
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_dedup_strategies(project_id: str) -> str:
    """List deduplication strategies configured for a project.

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}/strategies")
    return json.dumps(result, indent=2)


@mcp.tool()
async def list_dedup_jobs(project_id: str) -> str:
    """List all deduplication jobs for a project and their statuses.

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}/dedup-jobs")
    return json.dumps(result, indent=2)


@mcp.tool()
async def run_deduplication(project_id: str, source_id: str, strategy_id: str) -> str:
    """Trigger a deduplication run for a specific source using a strategy.

    Args:
        project_id: UUID of the project.
        source_id: UUID of the source to deduplicate.
        strategy_id: UUID of the dedup strategy to apply.

    Returns the created dedup job with its initial status.
    """
    body = {"source_id": source_id, "strategy_id": strategy_id}
    result = await _request(
        "POST", f"/projects/{project_id}/dedup-jobs", json_body=body
    )
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Screening
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_screening_sources(project_id: str) -> str:
    """List sources with screening progress statistics (counts per stage).

    Args:
        project_id: UUID of the project.

    Returns each source with unscreened, included, excluded, and uncertain
    counts for title-abstract and full-text screening stages.
    """
    result = await _request("GET", f"/projects/{project_id}/screening/sources")
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_next_screening_item(
    project_id: str,
    mode: str = "screen",
    source_id: str = "all",
    strategy: str = "sequential",
) -> str:
    """Fetch the next record to screen in the screening queue.

    Args:
        project_id: UUID of the project.
        mode: Screening mode — 'screen' (title/abstract), 'fulltext', 'extract',
            or 'mixed'.
        source_id: UUID of source to screen from, or 'all' for any source.
        strategy: Workflow strategy — 'sequential' (TA then FT) or 'mixed'.

    Returns the next record's metadata, abstract, and screening stage,
    or null if the queue is empty.
    """
    params: dict[str, Any] = {
        "mode": mode,
        "source_id": source_id,
        "strategy": strategy,
    }
    result = await _request(
        "GET", f"/projects/{project_id}/screening/next", params=params
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def submit_screening_decision(
    project_id: str,
    stage: str,
    decision: str,
    record_id: str = "",
    cluster_id: str = "",
    reason_code: str = "",
    notes: str = "",
) -> str:
    """Submit a title/abstract or full-text screening decision for a record.

    Args:
        project_id: UUID of the project.
        stage: Screening stage — 'TA' (title/abstract) or 'FT' (full-text).
        decision: Decision — 'include', 'exclude', or 'uncertain'.
        record_id: UUID of the record (provide record_id or cluster_id).
        cluster_id: UUID of the overlap cluster (alternative to record_id).
        reason_code: Optional short reason code for the decision.
        notes: Optional free-text notes.

    Returns the saved screening decision.
    """
    if not record_id and not cluster_id:
        return json.dumps({"error": "Provide either record_id or cluster_id."})
    if decision not in ("include", "exclude", "uncertain"):
        return json.dumps({"error": "decision must be 'include', 'exclude', or 'uncertain'."})
    if stage not in ("TA", "FT"):
        return json.dumps({"error": "stage must be 'TA' or 'FT'."})

    body: dict[str, Any] = {"stage": stage, "decision": decision}
    if record_id:
        body["record_id"] = record_id
    if cluster_id:
        body["cluster_id"] = cluster_id
    if reason_code:
        body["reason_code"] = reason_code
    if notes:
        body["notes"] = notes

    result = await _request(
        "POST", f"/projects/{project_id}/screening/decisions", json_body=body
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def list_screening_decisions(
    project_id: str, stage: str = "TA"
) -> str:
    """List existing screening decisions for a project.

    Args:
        project_id: UUID of the project.
        stage: 'TA' or 'FT'.
    """
    result = await _request(
        "GET",
        f"/projects/{project_id}/screening/decisions",
        params={"stage": stage},
    )
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: LLM Screening
# ---------------------------------------------------------------------------


@mcp.tool()
async def get_llm_screening_estimate(
    project_id: str, model: str = "claude-sonnet-4-6"
) -> str:
    """Estimate the cost and time for an LLM screening run before launching it.

    Args:
        project_id: UUID of the project.
        model: LLM model identifier. Examples:
            'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
            'openai/gpt-4o', 'google/gemini-2.0-flash-001',
            'meta-llama/llama-4-scout', 'deepseek/deepseek-chat'.

    Returns estimated record count, token usage, cost in USD, and minutes.
    """
    result = await _request(
        "GET",
        f"/projects/{project_id}/llm-screening/estimate",
        params={"model": model},
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def launch_llm_screening(
    project_id: str,
    model: str = "claude-sonnet-4-6",
    anthropic_api_key: str = "",
    openrouter_api_key: str = "",
) -> str:
    """Launch an LLM-assisted screening run against all records in a project.

    The run processes every record against the project's inclusion/exclusion
    criteria and thematic framework. Results are stored and can be reviewed
    with get_llm_run_results.

    Args:
        project_id: UUID of the project.
        model: LLM model to use (see get_llm_screening_estimate for options).
        anthropic_api_key: Anthropic API key (required for claude- models unless
            ANTHROPIC_API_KEY env var is set on the server).
        openrouter_api_key: OpenRouter API key (required for non-Claude models
            unless OPENROUTER_API_KEY env var is set on the server).

    Returns the created run object with its id and initial status ('queued').
    Poll get_llm_run_status to track progress.
    """
    body = {"model": model}
    extra_headers: dict[str, str] = {}
    if anthropic_api_key:
        extra_headers["X-Anthropic-Api-Key"] = anthropic_api_key
    if openrouter_api_key:
        extra_headers["X-Openrouter-Api-Key"] = openrouter_api_key

    result = await _request(
        "POST",
        f"/projects/{project_id}/llm-screening/runs",
        json_body=body,
        extra_headers=extra_headers or None,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def list_llm_runs(project_id: str) -> str:
    """List all LLM screening runs for a project, newest first.

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}/llm-screening/runs")
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_llm_run_status(project_id: str, run_id: str) -> str:
    """Get the current status and progress of an LLM screening run.

    Args:
        project_id: UUID of the project.
        run_id: UUID of the LLM screening run.

    Returns status ('queued', 'running', 'completed', 'failed'),
    progress percentage, record counts by decision, and cost so far.
    """
    result = await _request(
        "GET", f"/projects/{project_id}/llm-screening/runs/{run_id}"
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def get_llm_run_results(
    project_id: str,
    run_id: str,
    page: int = 1,
    page_size: int = 50,
    ta_decision: str = "",
) -> str:
    """Fetch paginated results from a completed LLM screening run.

    Args:
        project_id: UUID of the project.
        run_id: UUID of the LLM screening run.
        page: Page number (1-indexed).
        page_size: Results per page (max 200).
        ta_decision: Filter by TA decision — 'include', 'exclude', or
            'uncertain'. Leave empty to return all results.

    Returns paginated results with ta_decision, ta_reason, matched_codes,
    and new_concepts for each record.
    """
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if ta_decision:
        params["ta_decision"] = ta_decision
    result = await _request(
        "GET",
        f"/projects/{project_id}/llm-screening/runs/{run_id}/results",
        params=params,
    )
    return json.dumps(result, indent=2)


@mcp.tool()
async def review_llm_result(
    project_id: str,
    run_id: str,
    result_id: str,
    action: str,
) -> str:
    """Mark an LLM screening result as reviewed (accepted, rejected, or merged).

    Args:
        project_id: UUID of the project.
        run_id: UUID of the LLM screening run.
        result_id: UUID of the individual result to review.
        action: Review action — 'accepted' (agree with LLM decision),
            'rejected' (disagree), or 'merged' (applied to screening queue).
    """
    if action not in ("accepted", "rejected", "merged"):
        return json.dumps({"error": "action must be 'accepted', 'rejected', or 'merged'."})
    result = await _request(
        "POST",
        f"/projects/{project_id}/llm-screening/runs/{run_id}/results/{result_id}/review",
        json_body={"action": action},
    )
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Extractions
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_extractions(
    project_id: str,
    page: int = 1,
    page_size: int = 25,
    search: str = "",
) -> str:
    """List structured data extractions from included records in a project.

    Args:
        project_id: UUID of the project.
        page: Page number (1-indexed).
        page_size: Extractions per page.
        search: Free-text filter over extraction content and record metadata.
    """
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if search:
        params["search"] = search
    result = await _request(
        "GET", f"/projects/{project_id}/extractions", params=params
    )
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Thematic Analysis
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_themes(project_id: str) -> str:
    """List themes and codes in the project's thematic framework (codebook).

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}/thematic")
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Tools: Overlap Detection
# ---------------------------------------------------------------------------


@mcp.tool()
async def get_overlap_summary(project_id: str) -> str:
    """Get the cross-source overlap summary for a project.

    Returns cluster counts, pairwise overlap matrix, and top intersections
    showing where the same papers appear in multiple imported sources.

    Args:
        project_id: UUID of the project.
    """
    result = await _request("GET", f"/projects/{project_id}/overlaps")
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
