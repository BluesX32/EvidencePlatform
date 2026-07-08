"""Export a CSV template for curating human passage grounding.

The disease-severity case study's human concept mentions are article-linked
but were captured before passage grounding existed — source_quote/locator
are NULL and grounding_status is 'unavailable'. This script lists exactly
those mentions (per project, optionally per reviewer) so a curator can
reread each included source and fill in a supporting quotation, producing a
CSV that import_concept_grounding.py applies back.

mention_id is the reliable join key for import — no fuzzy value matching.
title/field_label/value are read-only context for the curator; everything
from `quote` onward starts blank.

Usage:
    python -m scripts.export_grounding_template --project-id UUID \
        [--reviewer-id UUID] [--out grounding_template.csv]
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import sys
import uuid
from typing import Dict, Optional, Tuple

from sqlalchemy import select

from app.database import SessionLocal
from app.models.concept_extraction import ConceptExtraction
from app.models.concept_mention import ConceptMention
from app.models.project import Project
from app.services.concept_provenance_service import _resolve_identity

FIELDNAMES = [
    "mention_id", "title", "field_id", "field_label", "value",
    "quote", "page", "section", "char_start", "char_end", "status",
]


async def _run(project_id: uuid.UUID, reviewer_id: Optional[uuid.UUID], out_path: str) -> None:
    async with SessionLocal() as db:
        project = await db.get(Project, project_id)
        field_map = {f["id"]: f for f in (project.concept_template or {}).get("fields", [])} if project else {}

        stmt = (
            select(ConceptMention, ConceptExtraction)
            .join(ConceptExtraction, ConceptExtraction.id == ConceptMention.concept_extraction_id)
            .where(
                ConceptMention.project_id == project_id,
                ConceptMention.origin == "human",
                ConceptMention.grounding_status == "unavailable",
            )
        )
        if reviewer_id is not None:
            stmt = stmt.where(ConceptMention.reviewer_id == reviewer_id)
        rows = (await db.execute(stmt)).all()

        identity_cache: Dict[Tuple[Optional[uuid.UUID], Optional[uuid.UUID]], Dict] = {}
        out_rows = []
        for mention, ce in rows:
            key = (ce.record_id, ce.cluster_id)
            if key not in identity_cache:
                identity_cache[key] = await _resolve_identity(db, project_id, ce.record_id, ce.cluster_id)
            identity = identity_cache[key]
            out_rows.append({
                "mention_id": str(mention.id),
                "title": identity.get("title") or "",
                "field_id": mention.field_id,
                "field_label": field_map.get(mention.field_id, {}).get("label", mention.field_id),
                "value": mention.value,
                "quote": "", "page": "", "section": "", "char_start": "", "char_end": "", "status": "",
            })

        with open(out_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()
            writer.writerows(out_rows)

    print(f"Wrote {len(out_rows)} ungrounded human mention(s) to {out_path}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", required=True, type=str)
    parser.add_argument("--reviewer-id", type=str, default=None)
    parser.add_argument("--out", type=str, default="grounding_template.csv")
    args = parser.parse_args()
    asyncio.run(_run(
        uuid.UUID(args.project_id),
        uuid.UUID(args.reviewer_id) if args.reviewer_id else None,
        args.out,
    ))


if __name__ == "__main__":
    main()
