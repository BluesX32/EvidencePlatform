import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import ADMIN_ROLE, get_current_user, require_project_role, ANY_ROLE
from app.models.record import Record
from app.models.record_source import RecordSource
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


async def _get_owned_project(project_id: uuid.UUID, user: User, db: AsyncSession, allowed=ANY_ROLE):
    await require_project_role(db, project_id, user.id, allowed=allowed)
    project = await ProjectRepo.get_by_id(db, project_id)
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


@router.delete("/{project_id}/sources/{source_id}", status_code=204)
async def delete_source(
    project_id: uuid.UUID,
    source_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Response:
    """Delete a source (corpus) and all records that belong exclusively to it.

    Records shared with other sources are kept; only exclusively-owned records
    are removed. Requires admin role.

    Cascade order:
      1. Clean up match_log / dedup_pairs (ON DELETE NO ACTION FKs).
      2. Delete the source → record_sources and overlap_cluster_members cascade.
      3. Delete records that now have no source membership.
    """
    await _get_owned_project(project_id, current_user, db, allowed=ADMIN_ROLE)

    source = await SourceRepo.get_by_id(db, project_id, source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found")

    # -- 1a. Collect record_source IDs for this source (needed for match_log cleanup)
    rs_result = await db.execute(
        select(RecordSource.id, RecordSource.record_id)
        .where(RecordSource.source_id == source_id)
    )
    rs_rows = list(rs_result.all())
    rs_ids = [row.id for row in rs_rows]
    all_record_ids = list({row.record_id for row in rs_rows})

    if rs_ids:
        # Clean NO ACTION FKs pointing at record_sources rows
        await db.execute(
            text("DELETE FROM match_log WHERE record_src_id = ANY(:ids)"),
            {"ids": rs_ids},
        )
        await db.execute(
            text("DELETE FROM dedup_pairs WHERE source_a_id = ANY(:ids) OR source_b_id = ANY(:ids)"),
            {"ids": rs_ids},
        )

    # -- 1b. Find records that belong ONLY to this source (will become orphans)
    orphan_result = await db.execute(
        text("""
            SELECT record_id FROM record_sources
            WHERE record_id = ANY(:rids)
            GROUP BY record_id
            HAVING count(DISTINCT source_id) = 1
        """),
        {"rids": all_record_ids},
    )
    orphan_ids = [row.record_id for row in orphan_result]

    if orphan_ids:
        # Clean match_log.new_record_id (NO ACTION) for orphan records
        await db.execute(
            text("DELETE FROM match_log WHERE new_record_id = ANY(:ids)"),
            {"ids": orphan_ids},
        )

    # -- 2. Update citation_candidates that reference orphan records so they no
    #       longer show "already in project" after those records are gone.
    #       (The FK is ON DELETE SET NULL, so project_record_id becomes NULL
    #       automatically, but in_project must be reset explicitly.)
    if orphan_ids:
        await db.execute(
            text("""
                UPDATE citation_candidates
                SET in_project = FALSE, project_record_id = NULL
                WHERE project_record_id = ANY(:ids)
            """),
            {"ids": orphan_ids},
        )

    # -- 3. Delete the source (cascades record_sources + overlap_cluster_members)
    await db.delete(source)
    await db.flush()

    # -- 4. Delete orphan records (cascade their downstream data)
    if orphan_ids:
        orphan_records_result = await db.execute(
            select(Record).where(Record.id.in_(orphan_ids))
        )
        for rec in orphan_records_result.scalars().all():
            await db.delete(rec)

    await db.commit()
    return Response(status_code=204)


@router.get("/{project_id}/sources", response_model=list[SourceResponse])
async def list_sources(
    project_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _get_owned_project(project_id, current_user, db)
    sources = await SourceRepo.list_by_project(db, project_id)
    return [SourceResponse.from_orm(s) for s in sources]
