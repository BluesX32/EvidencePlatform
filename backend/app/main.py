from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.database import SessionLocal
from app.routers import annotations, auth, citations, concept_extraction, concept_provenance, concept_taxonomy, consensus, dedup_jobs, extractions, fulltext, imports, labels, ontology, overlaps, projects, records, search, sources, strategies, teams, thematic
from app.routers import screening
from app.routers import llm_screening
from app.routers import ai_pilot
from app.routers import llm_usage


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Mark any runs that were left in 'running' state (orphaned by a server restart) as failed.
    async with SessionLocal() as db:
        await db.execute(
            text("""
                UPDATE llm_screening_runs
                SET status = CASE status
                        WHEN 'cancelling' THEN 'cancelled'
                        ELSE 'interrupted'
                    END,
                    error_message = CASE status
                        WHEN 'cancelling' THEN NULL
                        ELSE 'Run interrupted by server restart. Click Resume to continue.'
                    END,
                    completed_at = :now
                WHERE status IN ('running', 'queued', 'cancelling')
            """),
            {"now": datetime.now(tz=timezone.utc)},
        )
        await db.commit()
    yield


app = FastAPI(title="EvidencePlatform API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(sources.router)
app.include_router(imports.router)
app.include_router(records.router)
app.include_router(strategies.router)
app.include_router(dedup_jobs.router)
app.include_router(overlaps.router)
app.include_router(screening.router)
app.include_router(extractions.router)
app.include_router(citations.router)
app.include_router(annotations.router)
app.include_router(labels.router)
app.include_router(ontology.router)
app.include_router(thematic.router)
app.include_router(concept_extraction.router)
app.include_router(concept_taxonomy.router)
app.include_router(concept_provenance.router)
app.include_router(fulltext.router)
app.include_router(llm_screening.router)
app.include_router(teams.router)
app.include_router(consensus.router)
app.include_router(search.router)
app.include_router(ai_pilot.router)
app.include_router(llm_usage.router)


@app.get("/health")
async def health():
    return {"status": "ok"}