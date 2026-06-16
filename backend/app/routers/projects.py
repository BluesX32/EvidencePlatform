import uuid
from typing import Annotated, Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_decision import ScreeningDecision
from app.models.source import Source
from app.models.user import User
from app.repositories.import_repo import ImportRepo
from app.repositories.project_repo import ProjectRepo
from app.services.sub_project_service import create_sub_project, create_sub_project_from_human_screening

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
    parent_project_id: Optional[str] = None
    shared_with_team: bool = False


class CriterionItem(BaseModel):
    id: str
    text: str


class ProjectCriteria(BaseModel):
    inclusion: List[CriterionItem] = []
    exclusion: List[CriterionItem] = []
    levels: List[str] = []     # editable levels vocabulary (Sprint 14)


class SubProjectSummary(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_at: str
    record_count: int
    seed: Optional[int] = None
    n_per_corpus: Optional[int] = None
    shared_with_team: bool = False


class SampleInfo(BaseModel):
    seed: int
    n_per_corpus: int
    parent_project_id: str
    parent_project_name: str


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
    extraction_template: Optional[Dict[str, Any]] = None
    concept_template: Optional[Dict[str, Any]] = None
    parent_project_id: Optional[str] = None
    sample_info: Optional[SampleInfo] = None
    sub_projects: List[SubProjectSummary] = []
    shared_with_team: bool = False


class UpdateExtractionTemplateRequest(BaseModel):
    rows: List[Dict[str, Any]] = []


class UpdateConceptTemplateRequest(BaseModel):
    fields: List[Dict[str, Any]] = []


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
            parent_project_id=str(p.parent_project_id) if p.parent_project_id else None,
            shared_with_team=p.shared_with_team,
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

    # Sub-project relationships
    sample_info: Optional[SampleInfo] = None
    if project.parent_project_id:
        ps = await ProjectRepo.get_sample_info(db, project.id)
        if ps:
            parent = await ProjectRepo.get_by_id(db, project.parent_project_id)
            sample_info = SampleInfo(
                seed=ps.seed,
                n_per_corpus=ps.n_per_corpus,
                parent_project_id=str(project.parent_project_id),
                parent_project_name=parent.name if parent else "",
            )

    sub_projects_raw = await ProjectRepo.list_sub_projects(db, project.id)
    sub_project_items: List[SubProjectSummary] = []
    for sp in sub_projects_raw:
        sp_count = await ProjectRepo.count_records(db, sp.id)
        sp_sample = await ProjectRepo.get_sample_info(db, sp.id)
        sub_project_items.append(SubProjectSummary(
            id=str(sp.id),
            name=sp.name,
            description=sp.description,
            created_at=sp.created_at.isoformat(),
            record_count=sp_count,
            seed=sp_sample.seed if sp_sample else None,
            n_per_corpus=sp_sample.n_per_corpus if sp_sample else None,
            shared_with_team=sp.shared_with_team,
        ))

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
        extraction_template=project.extraction_template,
        concept_template=project.concept_template,
        parent_project_id=str(project.parent_project_id) if project.parent_project_id else None,
        sample_info=sample_info,
        sub_projects=sub_project_items,
        shared_with_team=project.shared_with_team,
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
        extraction_template=project.extraction_template,
        concept_template=project.concept_template,
    )


@router.patch("/{project_id}/extraction-template", response_model=ProjectDetail)
async def update_extraction_template(
    project_id: uuid.UUID,
    body: UpdateExtractionTemplateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    project, role = await _get_project_and_role(db, project_id, current_user.id)
    if role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Admin access required to edit extraction template")

    project.extraction_template = {"rows": body.rows}
    await db.commit()
    await db.refresh(project)

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
        extraction_template=project.extraction_template,
        concept_template=project.concept_template,
    )


@router.patch("/{project_id}/concept-template", response_model=ProjectDetail)
async def update_concept_template(
    project_id: uuid.UUID,
    body: UpdateConceptTemplateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    project, role = await _get_project_and_role(db, project_id, current_user.id)
    if role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Admin access required to edit concept template")

    project.concept_template = {"fields": body.fields}
    await db.commit()
    await db.refresh(project)

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
        extraction_template=project.extraction_template,
        concept_template=project.concept_template,
    )


# ── Sub-project endpoints ──────────────────────────────────────────────────────

class CreateSubProjectRequest(BaseModel):
    name: str
    description: Optional[str] = None
    n_per_corpus: int = Field(default=50, ge=1, le=10_000)
    seed: Optional[int] = None  # None → auto-generated
    source_ids: Optional[List[str]] = None  # None = all sources
    inherit_criteria: bool = False
    inherit_extraction_template: bool = False
    inherit_concept_template: bool = False
    shared_with_team: bool = False


@router.post(
    "/{project_id}/sub-projects",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_sub_project_endpoint(
    project_id: uuid.UUID,
    body: CreateSubProjectRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    _, role = await _get_project_and_role(db, project_id, current_user.id)
    if role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Admin access required to create sub-projects")
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="name is required")

    import random as _random
    seed = body.seed if body.seed is not None else _random.randint(0, 2**31 - 1)

    source_uuids = [uuid.UUID(s) for s in body.source_ids] if body.source_ids else None

    try:
        child = await create_sub_project(
            db=db,
            parent_project_id=project_id,
            name=body.name.strip(),
            description=body.description,
            n_per_corpus=body.n_per_corpus,
            seed=seed,
            creator_id=current_user.id,
            source_ids=source_uuids,
            inherit_criteria=body.inherit_criteria,
            inherit_extraction_template=body.inherit_extraction_template,
            inherit_concept_template=body.inherit_concept_template,
            shared_with_team=body.shared_with_team,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return ProjectResponse.from_orm(child)


@router.get("/{project_id}/screening/excluded-reason-codes")
async def get_excluded_reason_codes(
    project_id: uuid.UUID,
    stage: Optional[str] = None,
    current_user: Annotated[User, Depends(get_current_user)] = None,
    db: Annotated[AsyncSession, Depends(get_db)] = None,
):
    await _get_project_and_role(db, project_id, current_user.id)
    from sqlalchemy import func as sqlfunc
    stmt = (
        select(ScreeningDecision.reason_code, sqlfunc.count().label("count"))
        .where(
            ScreeningDecision.project_id == project_id,
            ScreeningDecision.decision == "exclude",
            ScreeningDecision.reason_code.isnot(None),
            ScreeningDecision.reason_code != "",
        )
    )
    if stage:
        stmt = stmt.where(ScreeningDecision.stage == stage)
    stmt = stmt.group_by(ScreeningDecision.reason_code).order_by(sqlfunc.count().desc())
    rows = (await db.execute(stmt)).all()
    total_stmt = select(sqlfunc.count()).select_from(ScreeningDecision).where(
        ScreeningDecision.project_id == project_id,
        ScreeningDecision.decision == "exclude",
    )
    if stage:
        total_stmt = total_stmt.where(ScreeningDecision.stage == stage)
    total = (await db.execute(total_stmt)).scalar_one()
    return {
        "total_excluded": total,
        "reason_codes": [{"reason_code": r, "count": c} for r, c in rows],
        "has_reason_codes": len(rows) > 0,
    }


class CreateSubProjectFromScreeningRequest(BaseModel):
    name: str
    description: Optional[str] = None
    decision: str  # "include" or "exclude"
    stage: Optional[str] = None  # "TA", "FT", or null (both)
    reason_code: Optional[str] = None  # filter excluded by reason_code
    shared_with_team: bool = False


@router.post(
    "/{project_id}/sub-projects/from-screening",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_sub_project_from_screening_endpoint(
    project_id: uuid.UUID,
    body: CreateSubProjectFromScreeningRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    _, role = await _get_project_and_role(db, project_id, current_user.id)
    if role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Admin access required to create sub-projects")
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="name is required")
    try:
        child = await create_sub_project_from_human_screening(
            db=db,
            parent_project_id=project_id,
            name=body.name.strip(),
            description=body.description,
            decision=body.decision,
            stage=body.stage,
            reason_code=body.reason_code,
            creator_id=current_user.id,
            shared_with_team=body.shared_with_team,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return ProjectResponse.from_orm(child)


@router.delete("/{project_id}", response_model=None, status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Response:
    project, role = await _get_project_and_role(db, project_id, current_user.id)
    if role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can delete a project")
    if project.parent_project_id is None:
        raise HTTPException(status_code=400, detail="Only sub-projects can be deleted this way")

    # match_log.record_src_id and dedup_pairs.source_a/b_id use NO ACTION FKs
    # that are checked immediately during cascade, so we must clean them up first.
    record_ids_result = await db.execute(
        select(Record.id).where(Record.project_id == project_id)
    )
    record_ids = [r.id for r in record_ids_result]

    if record_ids:
        rs_ids_result = await db.execute(
            select(RecordSource.id).where(RecordSource.record_id.in_(record_ids))
        )
        rs_ids = [r.id for r in rs_ids_result]

        if rs_ids:
            await db.execute(
                text("DELETE FROM match_log WHERE record_src_id = ANY(:ids)"),
                {"ids": rs_ids},
            )
            await db.execute(
                text("DELETE FROM dedup_pairs WHERE source_a_id = ANY(:ids) OR source_b_id = ANY(:ids)"),
                {"ids": rs_ids},
            )

        await db.execute(
            text("DELETE FROM match_log WHERE new_record_id = ANY(:ids)"),
            {"ids": record_ids},
        )

        # record_sources.import_job_id → import_jobs.id is NO ACTION.
        # Deleting the project cascades to import_jobs, which would be blocked
        # while record_sources still reference those rows. Delete them first.
        # (overlap_cluster_members has ondelete=CASCADE so it cleans itself up.)
        if rs_ids:
            await db.execute(
                text("DELETE FROM record_sources WHERE id = ANY(:ids)"),
                {"ids": rs_ids},
            )

    await db.delete(project)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class SharedWithTeamRequest(BaseModel):
    shared_with_team: bool


@router.patch("/{project_id}/shared-with-team", response_model=None, status_code=status.HTTP_204_NO_CONTENT)
async def set_shared_with_team(
    project_id: uuid.UUID,
    body: SharedWithTeamRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    project, role = await _get_project_and_role(db, project_id, current_user.id)
    if role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Admin access required")
    if project.parent_project_id is None:
        raise HTTPException(status_code=400, detail="Only sub-projects can be shared with team")
    project.shared_with_team = body.shared_with_team
    await db.commit()


@router.get("/{project_id}/sub-projects", response_model=List[SubProjectSummary])
async def list_sub_projects_endpoint(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _get_project_and_role(db, project_id, current_user.id)
    sub_projects = await ProjectRepo.list_sub_projects(db, project_id)
    result: List[SubProjectSummary] = []
    for sp in sub_projects:
        sp_count = await ProjectRepo.count_records(db, sp.id)
        sp_sample = await ProjectRepo.get_sample_info(db, sp.id)
        result.append(SubProjectSummary(
            id=str(sp.id),
            name=sp.name,
            description=sp.description,
            created_at=sp.created_at.isoformat(),
            record_count=sp_count,
            seed=sp_sample.seed if sp_sample else None,
            n_per_corpus=sp_sample.n_per_corpus if sp_sample else None,
            shared_with_team=sp.shared_with_team,
        ))
    return result


@router.get("/{project_id}/prisma-stats")
async def get_prisma_stats(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Return PRISMA flow counts: per-source raw totals, dedup, and exclusion reason breakdowns."""
    await _get_project_and_role(db, project_id, current_user.id)

    # Per-source raw record counts (record_sources rows = one per source claim)
    source_rows = (
        await db.execute(
            select(Source.name, func.count(RecordSource.id).label("cnt"))
            .join(RecordSource, RecordSource.source_id == Source.id)
            .where(Source.project_id == project_id)
            .group_by(Source.id, Source.name)
            .order_by(Source.name)
        )
    ).all()
    by_source = [{"name": r.name, "count": r.cnt} for r in source_rows]
    total_identified = sum(s["count"] for s in by_source)

    # Unique canonical records after within-source dedup
    total_unique: int = (
        await db.execute(
            select(func.count(func.distinct(RecordSource.record_id)))
            .join(Source, Source.id == RecordSource.source_id)
            .where(Source.project_id == project_id)
        )
    ).scalar() or 0
    duplicates_removed = total_identified - total_unique

    # TA exclusion reasons
    ta_reason_rows = (
        await db.execute(
            select(ScreeningDecision.reason_code, func.count().label("cnt"))
            .where(
                ScreeningDecision.project_id == project_id,
                ScreeningDecision.stage == "TA",
                ScreeningDecision.decision == "exclude",
                ScreeningDecision.reviewer_id.isnot(None),
            )
            .group_by(ScreeningDecision.reason_code)
            .order_by(func.count().desc())
        )
    ).all()
    ta_exclude_reasons = [{"reason_code": r.reason_code, "count": r.cnt} for r in ta_reason_rows]

    # FT exclusion reasons
    ft_reason_rows = (
        await db.execute(
            select(ScreeningDecision.reason_code, func.count().label("cnt"))
            .where(
                ScreeningDecision.project_id == project_id,
                ScreeningDecision.stage == "FT",
                ScreeningDecision.decision == "exclude",
                ScreeningDecision.reviewer_id.isnot(None),
            )
            .group_by(ScreeningDecision.reason_code)
            .order_by(func.count().desc())
        )
    ).all()
    ft_exclude_reasons = [{"reason_code": r.reason_code, "count": r.cnt} for r in ft_reason_rows]

    return {
        "by_source": by_source,
        "total_identified": total_identified,
        "total_unique": total_unique,
        "duplicates_removed": duplicates_removed,
        "ta_exclude_reasons": ta_exclude_reasons,
        "ft_exclude_reasons": ft_exclude_reasons,
    }