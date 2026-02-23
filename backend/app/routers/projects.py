import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.import_repo import ImportRepo
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_by: str
    created_at: str

    @classmethod
    def from_orm(cls, p):
        return cls(
            id=str(p.id),
            name=p.name,
            description=p.description,
            created_by=str(p.created_by),
            created_at=p.created_at.isoformat(),
        )


class ProjectListItem(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_at: str
    record_count: int


class ProjectDetail(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_by: str
    created_at: str
    record_count: int
    import_count: int


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: CreateProjectRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if not body.name.strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name is required")
    project = await ProjectRepo.create(db, name=body.name.strip(), description=body.description, user_id=current_user.id)
    return ProjectResponse.from_orm(project)


@router.get("", response_model=list[ProjectListItem])
async def list_projects(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    projects = await ProjectRepo.list_by_user(db, current_user.id)
    result = []
    for p in projects:
        count = await ProjectRepo.count_records(db, p.id)
        result.append(ProjectListItem(
            id=str(p.id),
            name=p.name,
            description=p.description,
            created_at=p.created_at.isoformat(),
            record_count=count,
        ))
    return result


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.created_by != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    record_count = await ProjectRepo.count_records(db, project.id)
    jobs = await ImportRepo.list_by_project(db, project.id)

    return ProjectDetail(
        id=str(project.id),
        name=project.name,
        description=project.description,
        created_by=str(project.created_by),
        created_at=project.created_at.isoformat(),
        record_count=record_count,
        import_count=len(jobs),
    )
