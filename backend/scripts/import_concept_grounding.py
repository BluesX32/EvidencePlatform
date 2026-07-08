"""Import curated passage grounding from a CSV produced (and hand-filled)
from export_grounding_template.py.

Reuses app.services.concept_mention_service.attach_grounding — the exact
function the manual grounding endpoint calls — so imported and manually
curated grounding are structurally identical, both recorded with an actor,
a timestamp, and an append-only concept_events(action="ground") row.

Rows with an empty `quote` and empty `status` are treated as not-yet-curated
and skipped (the curator hasn't gotten to that row yet). A row with
status="unavailable" is applied even without a quote — that's a deliberate
"reread the source, no supporting quotation exists" result.

Usage:
    python -m scripts.import_concept_grounding --csv grounding_template.csv \
        --project-id UUID --actor-email curator@example.com [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import logging
import uuid
from typing import Any, Dict, Optional

from sqlalchemy import select

from app.database import SessionLocal
from app.models.concept_mention import ConceptMention
from app.models.user import User
from app.services.concept_mention_service import attach_grounding

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("import_concept_grounding")


def _locator_from_row(row: Dict[str, str]) -> Optional[Dict[str, Any]]:
    locator = {}
    if row.get("page"):
        locator["page"] = row["page"].strip()
    if row.get("section"):
        locator["section"] = row["section"].strip()
    if row.get("char_start"):
        locator["char_start"] = int(row["char_start"])
    if row.get("char_end"):
        locator["char_end"] = int(row["char_end"])
    return locator or None


async def _run(csv_path: str, project_id: uuid.UUID, actor_email: str, dry_run: bool) -> None:
    async with SessionLocal() as db:
        actor = (await db.execute(select(User).where(User.email == actor_email))).scalar_one_or_none()
        if actor is None:
            raise SystemExit(f"No user found with email {actor_email!r}")

        applied = 0
        skipped = 0
        errors = 0

        with open(csv_path, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                quote = (row.get("quote") or "").strip()
                status = (row.get("status") or "").strip()
                if not quote and not status:
                    skipped += 1
                    continue

                mention_id_str = (row.get("mention_id") or "").strip()
                try:
                    mention_id = uuid.UUID(mention_id_str)
                except ValueError:
                    logger.warning("Skipping row with invalid mention_id: %r", mention_id_str)
                    errors += 1
                    continue

                mention = (await db.execute(
                    select(ConceptMention).where(
                        ConceptMention.id == mention_id, ConceptMention.project_id == project_id,
                    )
                )).scalar_one_or_none()
                if mention is None:
                    logger.warning("Skipping row — mention not found in project %s: %s", project_id, mention_id)
                    errors += 1
                    continue

                try:
                    await attach_grounding(
                        db, mention,
                        source_quote=quote or None,
                        locator=_locator_from_row(row),
                        status=status or "verified",
                        actor_id=actor.id,
                    )
                except ValueError as exc:
                    logger.warning("Skipping mention %s: %s", mention_id, exc)
                    errors += 1
                    continue

                applied += 1
                logger.info("mention=%s status=%s%s", mention_id, status or "verified", " [dry-run]" if dry_run else "")

        if dry_run:
            await db.rollback()
        else:
            await db.commit()
        logger.info(
            "%s: applied %d, skipped (not yet curated) %d, errors %d.",
            "Dry run" if dry_run else "Done", applied, skipped, errors,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=str)
    parser.add_argument("--project-id", required=True, type=str)
    parser.add_argument("--actor-email", required=True, type=str)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    asyncio.run(_run(args.csv, uuid.UUID(args.project_id), args.actor_email, args.dry_run))


if __name__ == "__main__":
    main()
