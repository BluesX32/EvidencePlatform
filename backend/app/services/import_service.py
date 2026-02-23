"""
Import service.

Runs as a FastAPI background task. The router creates the import_job row and
returns 202 immediately; this service does the actual work and updates the job
status. All errors are caught and written to import_jobs.error_msg — there are
no silent failures.
"""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal
from app.parsers import ris as ris_parser
from app.repositories.import_repo import ImportRepo
from app.repositories.record_repo import RecordRepo


async def process_import(job_id: uuid.UUID, project_id: uuid.UUID, file_bytes: bytes) -> None:
    """
    Background task entry point. Opens its own DB session because the request
    session is closed by the time this runs.
    """
    async with SessionLocal() as db:
        await ImportRepo.set_processing(db, job_id)
        try:
            records = ris_parser.parse(file_bytes)
        except ValueError as exc:
            await ImportRepo.set_failed(db, job_id, str(exc))
            return

        # Attach project and job foreign keys to each record dict.
        for rec in records:
            rec["project_id"] = project_id
            rec["import_job_id"] = job_id

        inserted = await RecordRepo.bulk_insert_ignore_duplicates(db, records)
        await ImportRepo.set_completed(db, job_id, inserted)
