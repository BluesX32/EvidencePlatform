from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import annotations, auth, dedup_jobs, extractions, imports, labels, ontology, overlaps, projects, records, sources, strategies, thematic
from app.routers import screening

app = FastAPI(title="EvidencePlatform API", version="0.1.0")

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
app.include_router(annotations.router)
app.include_router(labels.router)
app.include_router(ontology.router)
app.include_router(thematic.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
