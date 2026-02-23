"""Multi-source import: sources table, canonical records, record_sources join table.

Revision ID: 002
Revises: 001
Create Date: 2026-02-23

Changes:
  - New table: sources  (named bibliographic databases per project)
  - Altered: import_jobs  (add source_id FK)
  - Rebuilt: records  (full bib columns + normalized_doi uniqueness; drops stub)
  - Rebuilt: record_sources  (join table record_id+source_id; drops raw-data store)
  - Rebuilt: dedup_pairs  (source_a_id/source_b_id still reference record_sources.id)
  - Preserved stubs: screening_decisions, extracted_data  (schema unchanged)

No production data exists; stubs are dropped and recreated cleanly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. sources ────────────────────────────────────────────────────────────
    op.create_table(
        "sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_source_name"),
    )
    op.create_index("ix_sources_project_id", "sources", ["project_id"])

    # ── 2. import_jobs — add source_id ────────────────────────────────────────
    op.add_column(
        "import_jobs",
        sa.Column("source_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("sources.id", ondelete="SET NULL"), nullable=True),
    )

    # ── 3. Drop Phase-2/3 stubs that depend on records/record_sources ─────────
    op.drop_table("extracted_data")
    op.drop_table("screening_decisions")
    op.drop_table("dedup_pairs")

    # ── 4. Drop records stub ──────────────────────────────────────────────────
    op.drop_table("records")

    # ── 5. Drop old record_sources (raw-data store) ───────────────────────────
    op.drop_index("ix_record_sources_title", table_name="record_sources")
    op.drop_index("ix_record_sources_project_year", table_name="record_sources")
    op.drop_index("ix_record_sources_project_id", table_name="record_sources")
    op.drop_table("record_sources")

    # ── 6. Rebuild records (canonical store) ──────────────────────────────────
    op.create_table(
        "records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        # Normalized DOI used for dedup: lower(trim(doi)).
        # NULL for records without a DOI — those are never deduplicated in Slice 2.
        sa.Column("normalized_doi", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("abstract", sa.Text(), nullable=True),
        sa.Column("authors", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("year", sa.Integer(), nullable=True),
        sa.Column("journal", sa.Text(), nullable=True),
        sa.Column("volume", sa.String(), nullable=True),
        sa.Column("issue", sa.String(), nullable=True),
        sa.Column("pages", sa.String(), nullable=True),
        sa.Column("doi", sa.Text(), nullable=True),
        sa.Column("issn", sa.String(), nullable=True),
        sa.Column("keywords", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("source_format", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_records_project_id", "records", ["project_id"])
    op.create_index("ix_records_project_year", "records", ["project_id", "year"])
    # Partial unique index: one canonical record per DOI per project.
    # Records without a DOI are excluded (they are stored as distinct rows).
    op.create_index(
        "uq_records_project_normalized_doi",
        "records",
        ["project_id", "normalized_doi"],
        unique=True,
        postgresql_where=sa.text("normalized_doi IS NOT NULL"),
    )

    # ── 7. Rebuild record_sources (join table) ────────────────────────────────
    op.create_table(
        "record_sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("sources.id", ondelete="CASCADE"), nullable=False),
        sa.Column("import_job_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("import_jobs.id"), nullable=False),
        # Raw parsed fields from this source's file — preserved verbatim.
        # Includes "source_record_id" key when a stable source ID (PMID, EID) is present.
        sa.Column("raw_data", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    # One membership per (canonical record, source). Re-importing the same
    # DOI from the same source is a no-op (ON CONFLICT DO NOTHING).
    op.create_index(
        "uq_record_sources_record_source",
        "record_sources",
        ["record_id", "source_id"],
        unique=True,
    )

    # ── 8. Recreate Phase-2/3 stubs ───────────────────────────────────────────
    op.create_table(
        "dedup_pairs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id"), nullable=False),
        # reference record_sources (join-table rows, i.e. source-specific representations)
        sa.Column("source_a_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("source_b_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("decision", sa.String(), nullable=False, server_default="pending"),
        sa.Column("method", sa.String(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("decided_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "screening_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=False),
        sa.Column("round", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "extracted_data",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id"), nullable=False),
        sa.Column("extraction_form_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("extraction_forms.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=False),
        sa.Column("values", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("extracted_data")
    op.drop_table("screening_decisions")
    op.drop_table("dedup_pairs")

    op.drop_index("uq_record_sources_record_source", table_name="record_sources")
    op.drop_table("record_sources")

    op.drop_index("uq_records_project_normalized_doi", table_name="records")
    op.drop_index("ix_records_project_year", table_name="records")
    op.drop_index("ix_records_project_id", table_name="records")
    op.drop_table("records")

    op.drop_column("import_jobs", "source_id")

    op.drop_index("ix_sources_project_id", table_name="sources")
    op.drop_table("sources")

    # Recreate 001 stubs
    op.create_table(
        "records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("primary_source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "record_sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("import_job_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("import_jobs.id"), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("abstract", sa.Text(), nullable=True),
        sa.Column("authors", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("year", sa.Integer(), nullable=True),
        sa.Column("journal", sa.Text(), nullable=True),
        sa.Column("volume", sa.String(), nullable=True),
        sa.Column("issue", sa.String(), nullable=True),
        sa.Column("pages", sa.String(), nullable=True),
        sa.Column("doi", sa.String(), nullable=True),
        sa.Column("issn", sa.String(), nullable=True),
        sa.Column("keywords", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("source_format", sa.String(), nullable=False),
        sa.Column("raw_data", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("project_id", "doi", name="unique_doi_per_project"),
    )
    op.create_index("ix_record_sources_project_id", "record_sources", ["project_id"])
    op.create_index("ix_record_sources_project_year", "record_sources",
                    ["project_id", "year"])
    op.create_index("ix_record_sources_title", "record_sources", ["title"])
    op.create_table(
        "dedup_pairs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("source_a_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("source_b_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("decision", sa.String(), nullable=False, server_default="pending"),
        sa.Column("method", sa.String(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("decided_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "screening_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=False),
        sa.Column("round", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "extracted_data",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id"), nullable=False),
        sa.Column("extraction_form_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("extraction_forms.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=False),
        sa.Column("values", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
