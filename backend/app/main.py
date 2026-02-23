from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import auth, imports, projects, records, sources

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


@app.get("/health")
async def health():
    return {"status": "ok"}
