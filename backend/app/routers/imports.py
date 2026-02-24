import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.import_repo import ImportRepo
from app.repositories.project_repo import ProjectRepo
from app.repositories.source_repo import SourceRepo
from app.services.import_service import process_import

router = APIRouter(prefix="/projects", tags=["imports"])

_MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
_SUPPORTED_FORMATS = {".ris": "ris", ".txt": "ris"}  # .txt RIS exports from OVID/Embase


class ImportJobResponse(BaseModel):
    id: str
    filename: str
    status: str
    source_id: Optional[str]
    record_count: Optional[int]
    error_msg: Optional[str]
    created_at: str
    completed_at: Optional[str]

    @classmethod
    def from_orm(cls, job):
        return cls(
            id=str(job.id),
            filename=job.filename,
            status=job.status,
            source_id=str(job.source_id) if job.source_id else None,
            record_count=job.record_count,
            error_msg=job.error_msg,
            created_at=job.created_at.isoformat(),
            completed_at=job.completed_at.isoformat() if job.completed_at else None,
        )


class StartImportResponse(BaseModel):
    import_job_id: str
    status: str = "pending"


async def _get_owned_project(project_id: uuid.UUID, user: User, db: AsyncSession):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return project


@router.post("/{project_id}/imports", response_model=StartImportResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_import(
    project_id: uuid.UUID,
    file: UploadFile,
    background_tasks: BackgroundTasks,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    source_id: Annotated[Optional[uuid.UUID], Form()] = None,
):
    await _get_owned_project(project_id, current_user, db)

    # Validate source belongs to this project when provided.
    if source_id is not None:
        source = await SourceRepo.get_by_id(db, project_id, source_id)
        if source is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found in project")

    suffix = "." + (file.filename or "").rsplit(".", 1)[-1].lower()
    file_format = _SUPPORTED_FORMATS.get(suffix)
    if not file_format:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{suffix}'. Supported: .ris and .txt (RIS content)",
        )

    file_bytes = await file.read()
    if len(file_bytes) > _MAX_FILE_SIZE:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds 100 MB limit")

    job = await ImportRepo.create(
        db,
        project_id=project_id,
        user_id=current_user.id,
        filename=file.filename or "upload.ris",
        file_format=file_format,
        source_id=source_id,
    )

    background_tasks.add_task(process_import, job.id, project_id, source_id, file_bytes)
    return StartImportResponse(import_job_id=str(job.id))


@router.get("/{project_id}/imports", response_model=list[ImportJobResponse])
async def list_imports(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _get_owned_project(project_id, current_user, db)
    jobs = await ImportRepo.list_by_project(db, project_id)
    return [ImportJobResponse.from_orm(j) for j in jobs]


@router.get("/{project_id}/imports/{job_id}", response_model=ImportJobResponse)
async def get_import(
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _get_owned_project(project_id, current_user, db)
    job = await ImportRepo.get_by_id(db, job_id)
    if job is None or job.project_id != project_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Import job not found")
    return ImportJobResponse.from_orm(job)
