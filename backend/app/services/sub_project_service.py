"""
Sub-project service.

Creates a child project by randomly sampling N articles per corpus from a
parent project.  The same seed is applied to every corpus, so sampling is
deterministic and reproducible: the same (parent, seed, n_per_corpus) triple
always yields the same set of articles.

Sampling uses Python's random.Random (not the global RNG) so it never affects
any other code that calls random.*.

Articles are copied into the child project as independent records — the child
project is a full, standalone project with its own dedup, screening, and
extraction state.  The relationship back to the parent is stored in
project_samples for auditability.
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.import_job import ImportJob
from app.models.overlap_cluster_member import OverlapClusterMember
from app.models.project import Project
from app.models.project_sample import ProjectSample
from app.models.record import Record
from app.models.record_source import RecordSource
from app.models.screening_decision import ScreeningDecision
from app.models.source import Source
from app.repositories.project_repo import ProjectRepo
from app.repositories.record_repo import RecordRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.locks import release_project_lock, try_acquire_project_lock
from app.database import engine, SessionLocal

logger = logging.getLogger(__name__)


async def create_sub_project(
    db: AsyncSession,
    parent_project_id: uuid.UUID,
    name: str,
    description: Optional[str],
    n_per_corpus: int,
    seed: int,
    creator_id: uuid.UUID,
    source_ids: Optional[List[uuid.UUID]] = None,
    inherit_criteria: bool = False,
    inherit_extraction_template: bool = False,
    inherit_concept_template: bool = False,
) -> Project:
    """
    Sample n_per_corpus records from selected sources in parent_project_id and
    populate a new child project with those records.

    source_ids — restrict sampling to these sources; None means all sources.
    inherit_* — copy the corresponding setting from the parent into the child.

    Returns the newly created child Project.
    Raises ValueError for bad inputs; RuntimeError if the advisory lock is busy.
    """
    if n_per_corpus < 1:
        raise ValueError("n_per_corpus must be at least 1")

    parent = await ProjectRepo.get_by_id(db, parent_project_id)
    if parent is None:
        raise ValueError("Parent project not found")

    # Fetch sources — optionally filtered to the caller's selection
    sources_query = select(Source).where(Source.project_id == parent_project_id).order_by(Source.created_at)
    if source_ids:
        sources_query = sources_query.where(Source.id.in_(source_ids))
    sources_result = await db.execute(sources_query)
    parent_sources = list(sources_result.scalars().all())

    if not parent_sources:
        raise ValueError("No matching sources found in parent project")

    # For each source, fetch all (record_source, record) pairs
    rng = random.Random(seed)
    per_source_samples: dict[str, list[dict]] = {}  # source.name → list of parsed_record dicts
    sampled_ids_snapshot: dict[str, list[str]] = {}  # source.name → [str(record_source.id), ...]

    for source in parent_sources:
        rows_result = await db.execute(
            select(RecordSource, Record)
            .join(Record, Record.id == RecordSource.record_id)
            .where(RecordSource.source_id == source.id)
            .order_by(RecordSource.id)  # stable ordering before shuffle
        )
        rows = list(rows_result.all())

        if not rows:
            continue

        # Sample min(n, available) with the shared seed — same seed, different
        # sources, each gets a fresh shuffle of their own pool.
        k = min(n_per_corpus, len(rows))
        sampled = rng.sample(rows, k)

        per_source_samples[source.name] = [
            _build_parsed_record(rs, rec) for rs, rec in sampled
        ]
        sampled_ids_snapshot[source.name] = [str(rs.id) for rs, _ in sampled]

    if not any(per_source_samples.values()):
        raise ValueError("No records available to sample in the parent project")

    # Look up active dedup strategy preset for the child (inherit parent's)
    strategy = await StrategyRepo.get_active(db, parent_project_id)
    preset = strategy.preset if strategy else "doi_first_strict"

    # Create and commit the child project row so it is visible to the
    # write_db session that will insert Sources referencing it via FK.
    child = Project(
        name=name,
        description=description,
        created_by=creator_id,
        parent_project_id=parent_project_id,
        criteria=parent.criteria if inherit_criteria else {"inclusion": [], "exclusion": [], "levels": []},
        extraction_template=parent.extraction_template if inherit_extraction_template else None,
        concept_template=parent.concept_template if inherit_concept_template else None,
    )
    db.add(child)
    await db.commit()
    await db.refresh(child)

    # Populate the child project — one source + synthetic import_job per parent source
    async with engine.connect() as lock_conn:
        acquired = await try_acquire_project_lock(lock_conn, child.id)
        if not acquired:
            raise RuntimeError("Could not acquire advisory lock for child project")

        try:
            async with SessionLocal() as write_db:
                for source_name, parsed_records in per_source_samples.items():
                    if not parsed_records:
                        continue

                    # Mirror the parent source name in the child project
                    child_source = Source(project_id=child.id, name=source_name)
                    write_db.add(child_source)
                    await write_db.flush()

                    # Create a synthetic import job so record_sources.import_job_id is valid
                    job = ImportJob(
                        project_id=child.id,
                        created_by=creator_id,
                        filename=f"sampled_from_{parent_project_id}",
                        file_format="sampled",
                        status="completed",
                        record_count=len(parsed_records),
                        source_id=child_source.id,
                    )
                    write_db.add(job)
                    await write_db.flush()

                    await RecordRepo.upsert_and_link(
                        write_db,
                        parsed_records=parsed_records,
                        project_id=child.id,
                        source_id=child_source.id,
                        import_job_id=job.id,
                        preset=preset,
                    )

                # Store sampling provenance
                sample_row = ProjectSample(
                    parent_project_id=parent_project_id,
                    child_project_id=child.id,
                    seed=seed,
                    n_per_corpus=n_per_corpus,
                    created_by=creator_id,
                    sampled_record_ids=sampled_ids_snapshot,
                )
                write_db.add(sample_row)
                await write_db.commit()

        finally:
            await release_project_lock(lock_conn, child.id)

    logger.info(
        "Sub-project %s created from parent %s (seed=%d, n_per_corpus=%d, sources=%d)",
        child.id, parent_project_id, seed, n_per_corpus, len(per_source_samples),
    )
    return child


async def create_sub_project_from_human_screening(
    db: AsyncSession,
    parent_project_id: uuid.UUID,
    name: str,
    description: Optional[str],
    decision: str,
    stage: Optional[str],
    creator_id: uuid.UUID,
    reason_code: Optional[str] = None,
) -> Project:
    """
    Create a child project from human screening decisions.

    decision — "include" or "exclude"
    stage    — "TA", "FT", or None (both stages)
    """
    if decision not in ("include", "exclude"):
        raise ValueError("decision must be 'include' or 'exclude'")
    if stage is not None and stage not in ("TA", "FT"):
        raise ValueError("stage must be 'TA', 'FT', or null")

    parent = await ProjectRepo.get_by_id(db, parent_project_id)
    if parent is None:
        raise ValueError("Parent project not found")

    stmt = select(ScreeningDecision).where(
        ScreeningDecision.project_id == parent_project_id,
        ScreeningDecision.decision == decision,
    )
    if stage:
        stmt = stmt.where(ScreeningDecision.stage == stage)
    if reason_code:
        stmt = stmt.where(ScreeningDecision.reason_code == reason_code)
    decisions = (await db.execute(stmt)).scalars().all()

    # Collect unique record_ids (resolve cluster → record where needed)
    record_ids: set[uuid.UUID] = set()
    for d in decisions:
        if d.record_id:
            record_ids.add(d.record_id)
        elif d.cluster_id:
            member = (await db.execute(
                select(OverlapClusterMember)
                .where(OverlapClusterMember.cluster_id == d.cluster_id)
                .limit(1)
            )).scalar_one_or_none()
            if member:
                rs = await db.get(RecordSource, member.record_source_id)
                if rs:
                    record_ids.add(rs.record_id)

    if not record_ids:
        stage_label = f" at {stage} stage" if stage else ""
        reason_label = f" with reason '{reason_code}'" if reason_code else ""
        raise ValueError(f"No {decision}d records found{stage_label}{reason_label} in this project")

    strategy = await StrategyRepo.get_active(db, parent_project_id)
    preset = strategy.preset if strategy else "doi_first_strict"

    stage_suffix = f" ({stage})" if stage else ""
    source_label = ("Human Included" if decision == "include" else "Human Excluded") + stage_suffix

    child = Project(
        name=name,
        description=description,
        created_by=creator_id,
        parent_project_id=parent_project_id,
        criteria=parent.criteria,
        extraction_template=parent.extraction_template,
        concept_template=parent.concept_template,
    )
    db.add(child)
    await db.commit()
    await db.refresh(child)

    async with engine.connect() as lock_conn:
        acquired = await try_acquire_project_lock(lock_conn, child.id)
        if not acquired:
            raise RuntimeError("Could not acquire advisory lock for child project")
        try:
            async with SessionLocal() as write_db:
                child_source = Source(project_id=child.id, name=source_label)
                write_db.add(child_source)
                await write_db.flush()

                job = ImportJob(
                    project_id=child.id,
                    source_id=child_source.id,
                    created_by=creator_id,
                    filename=f"human_screening_{parent_project_id}_{decision}",
                    file_format="screening_export",
                    status="completed",
                    record_count=len(record_ids),
                    completed_at=datetime.now(tz=timezone.utc),
                )
                write_db.add(job)
                await write_db.flush()

                for record_id in record_ids:
                    orig = await write_db.get(Record, record_id)
                    if orig is None:
                        continue
                    rs_orig = (await write_db.execute(
                        select(RecordSource)
                        .where(RecordSource.record_id == orig.id)
                        .limit(1)
                    )).scalar_one_or_none()

                    raw = dict(rs_orig.raw_data) if rs_orig else {}
                    raw["_human_screening"] = {
                        "decision": decision,
                        "stage": stage,
                        "parent_project_id": str(parent_project_id),
                    }

                    new_rec = Record(
                        project_id=child.id,
                        normalized_doi=orig.normalized_doi,
                        match_key=orig.match_key,
                        match_basis=orig.match_basis,
                        title=orig.title,
                        abstract=orig.abstract,
                        authors=orig.authors,
                        year=orig.year,
                        journal=orig.journal,
                        volume=orig.volume,
                        issue=orig.issue,
                        pages=orig.pages,
                        doi=orig.doi,
                        issn=orig.issn,
                        keywords=orig.keywords,
                        source_format=orig.source_format,
                    )
                    write_db.add(new_rec)
                    await write_db.flush()

                    write_db.add(RecordSource(
                        record_id=new_rec.id,
                        source_id=child_source.id,
                        import_job_id=job.id,
                        raw_data=raw,
                        norm_title=rs_orig.norm_title if rs_orig else None,
                        norm_first_author=rs_orig.norm_first_author if rs_orig else None,
                        match_year=rs_orig.match_year if rs_orig else None,
                        match_doi=rs_orig.match_doi if rs_orig else None,
                    ))

                await write_db.commit()
        finally:
            await release_project_lock(lock_conn, child.id)

    logger.info(
        "Sub-project %s created from human screening (parent=%s, decision=%s, stage=%s, records=%d)",
        child.id, parent_project_id, decision, stage, len(record_ids),
    )
    return child


def _build_parsed_record(rs: RecordSource, rec: Record) -> dict:
    """
    Build a parsed_record dict (as expected by RecordRepo.upsert_and_link)
    from a parent record_source + its canonical record.
    """
    return {
        "title": rec.title,
        "abstract": rec.abstract,
        "authors": rec.authors or [],
        "year": rec.year,
        "journal": rec.journal,
        "volume": rec.volume,
        "issue": rec.issue,
        "pages": rec.pages,
        "doi": rec.doi,
        "issn": rec.issn,
        "keywords": rec.keywords or [],
        "source_format": rec.source_format,
        "raw_data": rs.raw_data,
    }
