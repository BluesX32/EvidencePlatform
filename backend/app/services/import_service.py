"""
Import service.

Runs as a FastAPI background task. The router creates the import_job row and
returns 202 immediately; this service does the actual work and updates the job
status. All errors are caught and written to import_jobs.error_msg — no silent
failures.

Two-phase write per record:
  1. Upsert into `records` (canonical; dedup on match_key from active strategy).
  2. Insert into `record_sources` (join table; idempotent per source).

Advisory lock: acquired at the start of the upsert section so that only one
mutation job (import or dedup) can modify a project's records at a time.
"""
import uuid
from typing import Optional

from app.database import SessionLocal, engine
from app.parsers import ris as ris_parser
from app.repositories.import_repo import ImportRepo
from app.repositories.record_repo import RecordRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.locks import try_acquire_project_lock, release_project_lock


async def process_import(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    source_id: Optional[uuid.UUID],
    file_bytes: bytes,
) -> None:
    """
    Background task entry point. Opens its own DB session because the request
    session is closed by the time this runs.

    File parsing happens before lock acquisition (parsing is read-only).
    The advisory lock is held only during the DB write phase.
    """
    async with SessionLocal() as db:
        await ImportRepo.set_processing(db, job_id)
        try:
            records = ris_parser.parse(file_bytes)
        except ValueError as exc:
            await ImportRepo.set_failed(db, job_id, str(exc))
            return

        if not records:
            await ImportRepo.set_completed(db, job_id, 0)
            return

        # Look up the active strategy for this project (default preset if none)
        strategy = await StrategyRepo.get_active(db, project_id)
        preset = strategy.preset if strategy else "doi_first_strict"

    # Re-open session inside advisory lock scope so the lock connection stays alive
    async with engine.connect() as lock_conn:
        acquired = await try_acquire_project_lock(lock_conn, project_id)
        if not acquired:
            async with SessionLocal() as db:
                await ImportRepo.set_failed(
                    db, job_id,
                    "Could not acquire project lock: another job is running"
                )
            return

        try:
            async with SessionLocal() as db:
                inserted = await RecordRepo.upsert_and_link(
                    db,
                    parsed_records=records,
                    project_id=project_id,
                    source_id=source_id,
                    import_job_id=job_id,
                    preset=preset,
                )
                await ImportRepo.set_completed(db, job_id, inserted)
        except Exception as exc:
            async with SessionLocal() as db:
                await ImportRepo.set_failed(db, job_id, str(exc))
        finally:
            await release_project_lock(lock_conn, project_id)
