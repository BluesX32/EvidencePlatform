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

Format support: any format accepted by app.parsers.parse_file (RIS, MEDLINE).
Partial failures (some records corrupt) result in status='completed' with a
warning summary in error_msg rather than aborting the entire job.
"""
import logging
import uuid
from typing import Optional

from app.database import SessionLocal, engine
from app.parsers import parse_file
from app.repositories.import_repo import ImportRepo
from app.repositories.record_repo import RecordRepo
from app.repositories.strategy_repo import StrategyRepo
from app.services.locks import try_acquire_project_lock, release_project_lock

logger = logging.getLogger(__name__)


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

    All exceptions (including unexpected BaseException subclasses) are caught
    and recorded so the job never stays stuck in "processing".
    """
    try:
        await _run_import(job_id, project_id, source_id, file_bytes)
    except BaseException as exc:  # noqa: BLE001 — last-resort safety net
        logger.exception("Unhandled exception in process_import for job %s", job_id)
        try:
            async with SessionLocal() as db:
                await ImportRepo.set_failed(db, job_id, f"Unexpected error: {exc}")
        except Exception:
            logger.exception("Failed to record job failure for job %s", job_id)


async def _run_import(
    job_id: uuid.UUID,
    project_id: uuid.UUID,
    source_id: Optional[uuid.UUID],
    file_bytes: bytes,
) -> None:
    async with SessionLocal() as db:
        await ImportRepo.set_processing(db, job_id)

        # Detect format and parse — record-level errors are collected, not fatal
        parse_result = parse_file(file_bytes)

        if parse_result.valid_count == 0:
            # All records failed or format is undetectable — hard failure
            await ImportRepo.set_failed(db, job_id, parse_result.error_summary())
            return

        records = parse_result.records
        warning_msg: Optional[str] = (
            parse_result.error_summary() if parse_result.failed_count > 0 else None
        )
        if warning_msg:
            logger.warning(
                "Import job %s: %d records skipped during parsing",
                job_id, parse_result.failed_count,
            )

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
                    "Another import or dedup job is running for this project. Please wait and retry.",
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
                await ImportRepo.set_completed(db, job_id, inserted, warning_msg=warning_msg)
        except Exception as exc:
            logger.exception("Import DB write failed for job %s", job_id)
            safe_msg = "Database error during import. Please retry or contact support."
            async with SessionLocal() as db:
                await ImportRepo.set_failed(db, job_id, safe_msg)
        finally:
            await release_project_lock(lock_conn, project_id)
