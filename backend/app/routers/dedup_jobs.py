"""Dedup-job endpoints.

POST /projects/{project_id}/dedup-jobs           — trigger a dedup run
GET  /projects/{project_id}/dedup-jobs           — list dedup jobs
GET  /projects/{project_id}/dedup-jobs/{job_id}  — get job status + stats
"""
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.dedup_repo import DedupJobRepo
from app.repositories.import_repo import ImportRepo
from app.repositories.project_repo import ProjectRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services import dedup_service

router = APIRouter(prefix="/projects/{project_id}/dedup-jobs", tags=["dedup-jobs"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class DedupJobCreate(BaseModel):
    strategy_id: uuid.UUID


class StrategyInfo(BaseModel):
    id: uuid.UUID
    name: str
    preset: str


class DedupJobResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    strategy_id: uuid.UUID
    strategy: Optional[StrategyInfo]
    status: str
    records_before: Optional[int]
    records_after: Optional[int]
    merges: Optional[int]
    clusters_created: Optional[int]
    clusters_deleted: Optional[int]
    error_msg: Optional[str]
    created_at: str
    completed_at: Optional[str]

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _require_project_access(
    project_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Forbidden")
    return project


def _job_to_response(job, strategy=None) -> DedupJobResponse:
    return DedupJobResponse(
        id=job.id,
        project_id=job.project_id,
        strategy_id=job.strategy_id,
        strategy=StrategyInfo(
            id=strategy.id, name=strategy.name, preset=strategy.preset
        ) if strategy else None,
        status=job.status,
        records_before=job.records_before,
        records_after=job.records_after,
        merges=job.merges,
        clusters_created=job.clusters_created,
        clusters_deleted=job.clusters_deleted,
        error_msg=job.error_msg,
        created_at=job.created_at.isoformat(),
        completed_at=job.completed_at.isoformat() if job.completed_at else None,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def start_dedup_job(
    project_id: uuid.UUID,
    body: DedupJobCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _require_project_access(project_id, current_user, db)

    # Validate strategy belongs to project
    strategy = await StrategyRepo.get_by_id(db, project_id, body.strategy_id)
    if strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")

    # Check no job is already running
    running = await DedupJobRepo.get_running(db, project_id)
    if running:
        # Check if there's also a running import
        import_running = await ImportRepo.get_running(db, project_id)
        active_job = None
        if import_running:
            active_job = {
                "id": str(import_running.id),
                "type": "import",
                "status": import_running.status,
                "created_at": import_running.created_at.isoformat(),
            }
        elif running:
            active_job = {
                "id": str(running.id),
                "type": "dedup",
                "status": running.status,
                "created_at": running.created_at.isoformat(),
            }
        raise HTTPException(
            status_code=409,
            detail={
                "error": "project_locked",
                "message": "Another job is already running for this project. Try again when it completes.",
                "project_id": str(project_id),
                "active_job": active_job,
            },
        )

    job = await DedupJobRepo.create(db, project_id, body.strategy_id, current_user.id)
    background_tasks.add_task(
        dedup_service.run_dedup, job.id, project_id, body.strategy_id
    )
    return {"dedup_job_id": str(job.id), "status": "pending"}


@router.get("", response_model=list[DedupJobResponse])
async def list_dedup_jobs(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _require_project_access(project_id, current_user, db)
    jobs = await DedupJobRepo.list_by_project(db, project_id)

    # Fetch strategies for all jobs in one go
    strategy_ids = list({j.strategy_id for j in jobs})
    strategies = {}
    for sid in strategy_ids:
        s = await StrategyRepo.get_by_id(db, project_id, sid)
        if s:
            strategies[sid] = s

    return [_job_to_response(j, strategies.get(j.strategy_id)) for j in jobs]


@router.get("/{job_id}", response_model=DedupJobResponse)
async def get_dedup_job(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _require_project_access(project_id, current_user, db)
    job = await DedupJobRepo.get_by_id(db, project_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Dedup job not found")
    strategy = await StrategyRepo.get_by_id(db, project_id, job.strategy_id)
    return _job_to_response(job, strategy)
