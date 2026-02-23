"""Flexible dedup: match_key on records, norm fields on record_sources,
match_strategies, dedup_jobs, match_log tables.

Revision ID: 003
Revises: 002
Create Date: 2026-02-23

Changes:
  - records: ADD match_key TEXT, match_basis VARCHAR(50)
             DROP uq_records_project_normalized_doi
             CREATE uq_records_project_match_key (project_id, match_key WHERE NOT NULL)
  - record_sources: ADD norm_title, norm_first_author TEXT; match_year INT; match_doi TEXT
  - New table: match_strategies
  - New table: dedup_jobs
  - New table: match_log
  - Seed: insert doi_first_strict strategy (is_active=TRUE) for every existing project
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. records — add match_key + match_basis ──────────────────────────────
    op.add_column(
        "records",
        sa.Column("match_key", sa.Text(), nullable=True),
    )
    op.add_column(
        "records",
        sa.Column("match_basis", sa.String(50), nullable=True),
    )

    # Drop DOI-specific partial index; replace with strategy-agnostic one.
    op.drop_index("uq_records_project_normalized_doi", table_name="records")
    op.create_index(
        "uq_records_project_match_key",
        "records",
        ["project_id", "match_key"],
        unique=True,
        postgresql_where=sa.text("match_key IS NOT NULL"),
    )

    # Backfill match_key for existing records that have a normalized_doi.
    # Records without normalized_doi remain NULL (isolated, not deduplicated).
    op.execute(
        sa.text(
            "UPDATE records SET match_key = 'doi:' || normalized_doi,"
            "                   match_basis = 'doi'"
            " WHERE normalized_doi IS NOT NULL"
        )
    )

    # ── 2. record_sources — add precomputed norm fields ───────────────────────
    op.add_column("record_sources", sa.Column("norm_title", sa.Text(), nullable=True))
    op.add_column(
        "record_sources", sa.Column("norm_first_author", sa.Text(), nullable=True)
    )
    op.add_column(
        "record_sources", sa.Column("match_year", sa.Integer(), nullable=True)
    )
    op.add_column("record_sources", sa.Column("match_doi", sa.Text(), nullable=True))

    op.create_index(
        "ix_rs_match_doi",
        "record_sources",
        ["match_doi"],
        postgresql_where=sa.text("match_doi IS NOT NULL"),
    )

    # ── 3. match_strategies ───────────────────────────────────────────────────
    op.create_table(
        "match_strategies",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("preset", sa.String(50), nullable=False),
        # preset values: doi_first_strict | doi_first_medium | strict | medium | loose
        sa.Column(
            "config", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'")
        ),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("project_id", "name", name="uq_strategy_project_name"),
    )
    op.create_index(
        "ix_match_strategies_project_id", "match_strategies", ["project_id"]
    )

    # Seed a default doi_first_strict strategy for every existing project.
    op.execute(
        sa.text(
            "INSERT INTO match_strategies (project_id, name, preset, is_active)"
            " SELECT id, 'Default (DOI + Strict fallback)', 'doi_first_strict', TRUE"
            " FROM projects"
        )
    )

    # ── 4. dedup_jobs ─────────────────────────────────────────────────────────
    op.create_table(
        "dedup_jobs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "strategy_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_strategies.id"),
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(20), nullable=False, server_default="pending"
        ),
        # pending | running | completed | failed
        sa.Column("records_before", sa.Integer(), nullable=True),
        sa.Column("records_after", sa.Integer(), nullable=True),
        sa.Column("merges", sa.Integer(), nullable=True),
        sa.Column("clusters_created", sa.Integer(), nullable=True),
        sa.Column("clusters_deleted", sa.Integer(), nullable=True),
        sa.Column("error_msg", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_dedup_jobs_project_id", "dedup_jobs", ["project_id"])
    op.create_index("ix_dedup_jobs_strategy_id", "dedup_jobs", ["strategy_id"])

    # ── 5. match_log ──────────────────────────────────────────────────────────
    op.create_table(
        "match_log",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "dedup_job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("dedup_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "record_src_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("record_sources.id"),
            nullable=False,
        ),
        sa.Column(
            "old_record_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("records.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "new_record_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("records.id"),
            nullable=False,
        ),
        sa.Column("match_key", sa.Text(), nullable=True),
        sa.Column("match_basis", sa.String(50), nullable=True),
        sa.Column("action", sa.String(20), nullable=False),
        # unchanged | merged | split | created
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_match_log_dedup_job_id", "match_log", ["dedup_job_id"])
    op.create_index("ix_match_log_record_src_id", "match_log", ["record_src_id"])


def downgrade() -> None:
    op.drop_index("ix_match_log_record_src_id", table_name="match_log")
    op.drop_index("ix_match_log_dedup_job_id", table_name="match_log")
    op.drop_table("match_log")

    op.drop_index("ix_dedup_jobs_strategy_id", table_name="dedup_jobs")
    op.drop_index("ix_dedup_jobs_project_id", table_name="dedup_jobs")
    op.drop_table("dedup_jobs")

    op.drop_index("ix_match_strategies_project_id", table_name="match_strategies")
    op.drop_table("match_strategies")

    op.drop_index("ix_rs_match_doi", table_name="record_sources")
    op.drop_column("record_sources", "match_doi")
    op.drop_column("record_sources", "match_year")
    op.drop_column("record_sources", "norm_first_author")
    op.drop_column("record_sources", "norm_title")

    op.drop_index("uq_records_project_match_key", table_name="records")
    op.create_index(
        "uq_records_project_normalized_doi",
        "records",
        ["project_id", "normalized_doi"],
        unique=True,
        postgresql_where=sa.text("normalized_doi IS NOT NULL"),
    )
    op.drop_column("records", "match_basis")
    op.drop_column("records", "match_key")
