import uuid
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.repositories.import_repo import ImportRepo
from app.repositories.project_repo import ProjectRepo

router = APIRouter(prefix="/projects", tags=["projects"])

# Roles with write-level access (can edit project settings, import, configure)
_WRITE_ROLES = frozenset({"owner", "admin"})
# Roles with any access (observer can view)
_ANY_ROLES = frozenset({"owner", "admin", "reviewer", "observer"})


async def _get_project_and_role(
    db: AsyncSession,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
) -> tuple:
    """Return (project, role) or raise 404/403."""
    project = await ProjectRepo.get_by_id(db, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    role = await ProjectRepo.user_role(db, project_id, user_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return project, role


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
    my_role: str


class CriterionItem(BaseModel):
    id: str
    text: str


class ProjectCriteria(BaseModel):
    inclusion: List[CriterionItem] = []
    exclusion: List[CriterionItem] = []
    levels: List[str] = []     # editable levels vocabulary (Sprint 14)


class ProjectDetail(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_by: str
    created_at: str
    record_count: int        # canonical records (unique after dedup)
    import_count: int        # completed import jobs
    failed_import_count: int
    criteria: ProjectCriteria
    my_role: str             # owner | admin | reviewer | observer


class UpdateCriteriaRequest(BaseModel):
    inclusion: List[CriterionItem] = []
    exclusion: List[CriterionItem] = []
    levels: List[str] = []     # editable levels vocabulary (Sprint 14)


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
        role = await ProjectRepo.user_role(db, p.id, current_user.id) or "owner"
        result.append(ProjectListItem(
            id=str(p.id),
            name=p.name,
            description=p.description,
            created_at=p.created_at.isoformat(),
            record_count=count,
            my_role=role,
        ))
    return result


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    project, role = await _get_project_and_role(db, project_id, current_user.id)

    record_count = await ProjectRepo.count_records(db, project.id)
    import_count = await ImportRepo.count_completed(db, project.id)
    jobs = await ImportRepo.list_by_project(db, project.id)
    failed_count = sum(1 for j in jobs if j.status == "failed")

    raw = project.criteria or {"inclusion": [], "exclusion": [], "levels": []}
    raw.setdefault("levels", [])
    return ProjectDetail(
        id=str(project.id),
        name=project.name,
        description=project.description,
        created_by=str(project.created_by),
        created_at=project.created_at.isoformat(),
        record_count=record_count,
        import_count=import_count,
        failed_import_count=failed_count,
        criteria=ProjectCriteria(**raw),
        my_role=role,
    )


@router.patch("/{project_id}/criteria", response_model=ProjectDetail)
async def update_criteria(
    project_id: uuid.UUID,
    body: UpdateCriteriaRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    project, role = await _get_project_and_role(db, project_id, current_user.id)
    if role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Admin access required to edit criteria")

    criteria_dict = {
        "inclusion": [c.model_dump() for c in body.inclusion],
        "exclusion": [c.model_dump() for c in body.exclusion],
        "levels": body.levels,
    }
    project = await ProjectRepo.update_criteria(db, project_id, criteria_dict)
    await db.commit()

    record_count = await ProjectRepo.count_records(db, project_id)
    import_count = await ImportRepo.count_completed(db, project_id)
    jobs = await ImportRepo.list_by_project(db, project_id)
    failed_count = sum(1 for j in jobs if j.status == "failed")

    raw = project.criteria or {"inclusion": [], "exclusion": [], "levels": []}
    raw.setdefault("levels", [])
    return ProjectDetail(
        id=str(project.id),
        name=project.name,
        description=project.description,
        created_by=str(project.created_by),
        created_at=project.created_at.isoformat(),
        record_count=record_count,
        import_count=import_count,
        failed_import_count=failed_count,
        criteria=ProjectCriteria(**raw),
        my_role=role,
    )