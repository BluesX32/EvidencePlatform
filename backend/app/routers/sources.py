import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.project_repo import ProjectRepo
from app.repositories.source_repo import SourceRepo

router = APIRouter(prefix="/projects", tags=["sources"])


class SourceResponse(BaseModel):
    id: str
    name: str
    created_at: str

    @classmethod
    def from_orm(cls, s):
        return cls(id=str(s.id), name=s.name, created_at=s.created_at.isoformat())


class CreateSourceRequest(BaseModel):
    name: str


async def _get_owned_project(project_id: uuid.UUID, user: User, db: AsyncSession):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return project


@router.post("/{project_id}/sources", response_model=SourceResponse, status_code=status.HTTP_201_CREATED)
async def create_source(
    project_id: uuid.UUID,
    body: CreateSourceRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _get_owned_project(project_id, current_user, db)
    try:
        source = await SourceRepo.create(db, project_id, body.name.strip())
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Source '{body.name.strip()}' already exists in this project",
        )
    return SourceResponse.from_orm(source)


@router.get("/{project_id}/sources", response_model=list[SourceResponse])
async def list_sources(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _get_owned_project(project_id, current_user, db)
    sources = await SourceRepo.list_by_project(db, project_id)
    return [SourceResponse.from_orm(s) for s in sources]
