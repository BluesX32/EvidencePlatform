"""Initial schema — all tables for the full system.

Creates every table defined in the roadmap Phase 0 schema so that
foreign-key relationships are correct from day one. Tables used in
later slices are created as stubs with no API surface yet.

Revision ID: 001
Revises:
Create Date: 2026-02-23
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users ────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    # ── projects ─────────────────────────────────────────────────────────────
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── project_members (Phase 2) ────────────────────────────────────────────
    op.create_table(
        "project_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── protocols (Phase 2) ──────────────────────────────────────────────────
    op.create_table(
        "protocols",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("content", postgresql.JSONB(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── import_jobs ──────────────────────────────────────────────────────────
    op.create_table(
        "import_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("file_format", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("record_count", sa.Integer(), nullable=True),
        sa.Column("error_msg", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_import_jobs_project_id", "import_jobs", ["project_id"])

    # ── record_sources ───────────────────────────────────────────────────────
    op.create_table(
        "record_sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("import_job_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("import_jobs.id"), nullable=False),
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
        # Raw imported fields preserved verbatim — this column is never updated.
        sa.Column("raw_data", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # Partial unique constraint: DOI uniqueness per project.
        # Enforced at DB level; application uses INSERT ... ON CONFLICT DO NOTHING.
        sa.UniqueConstraint("project_id", "doi", name="unique_doi_per_project"),
    )
    op.create_index("ix_record_sources_project_id", "record_sources", ["project_id"])
    op.create_index("ix_record_sources_project_year", "record_sources", ["project_id", "year"])
    # Title index for ILIKE search (MVP). A GIN tsvector index can replace this post-MVP
    # once search volume warrants it — requires an IMMUTABLE wrapper function in PostgreSQL.
    op.create_index("ix_record_sources_title", "record_sources", ["title"])

    # ── records (Slice 2) ────────────────────────────────────────────────────
    op.create_table(
        "records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("primary_source_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── dedup_pairs (Slice 2) ────────────────────────────────────────────────
    op.create_table(
        "dedup_pairs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("source_a_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("source_b_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("record_sources.id"), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("decision", sa.String(), nullable=False, server_default="pending"),
        sa.Column("method", sa.String(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("decided_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── screening_decisions (Phase 2) ────────────────────────────────────────
    op.create_table(
        "screening_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("round", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── extraction_forms (Phase 3) ───────────────────────────────────────────
    op.create_table(
        "extraction_forms",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("protocol_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("protocols.id"), nullable=False),
        sa.Column("schema", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── extracted_data (Phase 3) ─────────────────────────────────────────────
    op.create_table(
        "extracted_data",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("extraction_form_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("extraction_forms.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("values", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("extracted_data")
    op.drop_table("extraction_forms")
    op.drop_table("screening_decisions")
    op.drop_table("dedup_pairs")
    op.drop_table("records")
    op.drop_index("ix_record_sources_title", table_name="record_sources")
    op.drop_index("ix_record_sources_project_year", table_name="record_sources")
    op.drop_index("ix_record_sources_project_id", table_name="record_sources")
    op.drop_table("record_sources")
    op.drop_index("ix_import_jobs_project_id", table_name="import_jobs")
    op.drop_table("import_jobs")
    op.drop_table("protocols")
    op.drop_table("project_members")
    op.drop_table("projects")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
