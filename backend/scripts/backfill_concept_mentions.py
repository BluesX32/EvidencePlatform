"""Backfill concept_mentions for concept_extractions rows that predate them.

Run once after deploying migration 050 and all P0.1-P0.6 code, before
re-running the implementation-claim audit — see EP-Manuscript's
implementation_claim_audit.md, priority-0 items and step 9 of "Recommended
immediate implementation sequence."

Reuses the exact sync logic the live write paths use
(app.services.concept_mention_service.sync_mentions_for_extraction), so
backfilled mentions are structurally identical to ones created going
forward. Two fields are necessarily reconstructions rather than
contemporaneous data, and are recorded as such:

  - ai_job_id / llm_call_id: unknown for historical rows (no linkage existed
    before migration 050), so backfilled AI-origin mentions have both NULL.
  - sequence_index: resolved from the *current* screening-queue state, which
    may not reflect the queue as it existed when the extraction was
    originally made (queues can be reset).

Idempotent: skips any concept_extractions row that already has at least one
concept_mentions row, so re-running after a partial run or after new live
extractions land is safe.

Usage:
    python -m scripts.backfill_concept_mentions [--project-id UUID] [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from typing import Optional

from sqlalchemy import select

from app.database import SessionLocal
from app.models.concept_extraction import ConceptExtraction
from app.models.concept_mention import ConceptMention
from app.models.project import Project
from app.services.concept_mention_service import sync_mentions_for_extraction

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("backfill_concept_mentions")


async def _run(project_id: Optional[uuid.UUID], dry_run: bool) -> None:
    async with SessionLocal() as db:
        project_stmt = select(Project)
        if project_id is not None:
            project_stmt = project_stmt.where(Project.id == project_id)
        projects = (await db.execute(project_stmt)).scalars().all()

        total_backfilled = 0
        total_skipped = 0

        for project in projects:
            field_map = {f["id"]: f for f in (project.concept_template or {}).get("fields", [])}

            extractions = (await db.execute(
                select(ConceptExtraction).where(ConceptExtraction.project_id == project.id)
            )).scalars().all()

            for ce in extractions:
                has_mentions = (await db.execute(
                    select(ConceptMention.id)
                    .where(ConceptMention.concept_extraction_id == ce.id)
                    .limit(1)
                )).scalar_one_or_none()
                if has_mentions is not None:
                    total_skipped += 1
                    continue

                created = await sync_mentions_for_extraction(db, ce, field_map=field_map)
                total_backfilled += len(created)
                logger.info(
                    "project=%s extraction=%s origin=%s → %d mention(s)%s",
                    project.id, ce.id, ce.origin, len(created), " [dry-run]" if dry_run else "",
                )

        if dry_run:
            await db.rollback()
            logger.info("Dry run: would create %d mentions (%d extractions already had mentions).",
                        total_backfilled, total_skipped)
        else:
            await db.commit()
            logger.info("Backfilled %d mentions (%d extractions already had mentions, skipped).",
                        total_backfilled, total_skipped)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", type=str, default=None, help="Limit to one project")
    parser.add_argument("--dry-run", action="store_true", help="Roll back instead of committing")
    args = parser.parse_args()
    project_id = uuid.UUID(args.project_id) if args.project_id else None
    asyncio.run(_run(project_id, args.dry_run))


if __name__ == "__main__":
    main()
