"""
Automated PubMed search router.

Three endpoints:
  POST /projects/{id}/search/strategy  — LLM generates PubMed search string
  POST /projects/{id}/search/execute   — runs esearch, returns count + preview
  POST /projects/{id}/search/import    — fetches MEDLINE, imports into project
"""
from __future__ import annotations

import logging
import os
import uuid
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_project_role, ADMIN_ROLE
from app.models.user import User
from app.repositories.import_repo import ImportRepo
from app.repositories.source_repo import SourceRepo
from app.services import pubmed_service
from app.services.import_service import process_import

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["search"])


# ── Request / response models ─────────────────────────────────────────────────

class StrategyRequest(BaseModel):
    research_question: str
    model: str = "claude-haiku-4-5-20251001"


class StrategyResponse(BaseModel):
    query: str
    explanation: str
    pico: dict
    suggested_filters: List[str]


class ExecuteRequest(BaseModel):
    query: str
    filters: Optional[List[str]] = None
    max_results: int = 200


class PreviewRecord(BaseModel):
    pmid: str
    title: str
    year: str
    authors: str
    source: str


class ExecuteResponse(BaseModel):
    total: int
    preview: List[PreviewRecord]
    pmids: List[str]


class ImportRequest(BaseModel):
    query: str
    filters: Optional[List[str]] = None
    max_results: int = 200
    source_name: Optional[str] = None


class ImportResponse(BaseModel):
    import_job_id: str
    source_id: str
    status: str = "pending"
    estimated_records: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

def _resolve_keys(user: User) -> tuple[Optional[str], Optional[str]]:
    profile_keys = user.api_keys or {}
    anthropic_key = profile_keys.get("anthropic") or os.environ.get("ANTHROPIC_API_KEY")
    openrouter_key = profile_keys.get("openrouter") or os.environ.get("OPENROUTER_API_KEY")
    return anthropic_key, openrouter_key


@router.post("/{project_id}/search/strategy", response_model=StrategyResponse)
async def generate_strategy(
    project_id: uuid.UUID,
    body: StrategyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    anthropic_key, openrouter_key = _resolve_keys(user)
    if not anthropic_key and not openrouter_key:
        raise HTTPException(status_code=400, detail="No API key configured — add an Anthropic or OpenRouter key in Settings")
    try:
        result = await pubmed_service.generate_search_strategy(
            body.research_question, model=body.model,
            api_key=anthropic_key, openrouter_api_key=openrouter_key,
        )
    except Exception as exc:
        logger.exception("Strategy generation failed")
        raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}")
    return StrategyResponse(
        query=result.get("query", ""),
        explanation=result.get("explanation", ""),
        pico=result.get("pico", {}),
        suggested_filters=result.get("suggested_filters", []),
    )


@router.post("/{project_id}/search/execute", response_model=ExecuteResponse)
async def execute_search(
    project_id: uuid.UUID,
    body: ExecuteRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)
    try:
        result = await pubmed_service.execute_search(
            body.query, max_results=body.max_results, filters=body.filters
        )
    except Exception as exc:
        logger.exception("PubMed search failed")
        raise HTTPException(status_code=502, detail=f"PubMed API error: {exc}")
    return ExecuteResponse(
        total=result["total"],
        preview=[PreviewRecord(**r) for r in result["preview"]],
        pmids=result.get("pmids", []),
    )


@router.post("/{project_id}/search/import", response_model=ImportResponse)
async def import_from_pubmed(
    project_id: uuid.UUID,
    body: ImportRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await require_project_role(db, project_id, user.id, allowed=ADMIN_ROLE)

    # 1. Get PMIDs
    try:
        search_result = await pubmed_service.execute_search(
            body.query, max_results=body.max_results, filters=body.filters
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PubMed search failed: {exc}")

    pmids = search_result.get("pmids", [])
    if not pmids:
        raise HTTPException(status_code=404, detail="No results found for this query.")

    # 2. Create a source for this search
    source_name = body.source_name or f"PubMed: {body.query[:60]}"
    source = await SourceRepo.create(db, project_id, source_name)

    # 3. Fetch MEDLINE bytes in a background task so request returns quickly
    job = await ImportRepo.create(
        db,
        project_id=project_id,
        user_id=user.id,
        filename=f"pubmed_search_{len(pmids)}_records.txt",
        file_format="medline",
        source_id=source.id,
    )

    async def _fetch_and_import():
        try:
            medline_bytes = await pubmed_service.fetch_medline_bytes(pmids)
            await process_import(job.id, project_id, source.id, medline_bytes)
        except Exception as exc:
            logger.exception("PubMed import background task failed for job %s", job.id)
            try:
                from app.database import SessionLocal
                async with SessionLocal() as db2:
                    await ImportRepo.set_failed(db2, job.id, str(exc))
            except Exception:
                pass

    background_tasks.add_task(_fetch_and_import)

    return ImportResponse(
        import_job_id=str(job.id),
        source_id=str(source.id),
        estimated_records=len(pmids),
    )
