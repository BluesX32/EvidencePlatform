"""Add citation_searches and citation_candidates for snowball sourcing.

Revision ID: 028
Revises: 027
Create Date: 2026-04-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "citation_searches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("triggered_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("direction", sa.String(20), nullable=False, server_default="both"),
        sa.Column("candidate_count", sa.Integer(), nullable=True),
        sa.Column("already_in_project_count", sa.Integer(), nullable=True),
        sa.Column("error_msg", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_citation_searches_project", "citation_searches", ["project_id"])

    op.create_table(
        "citation_candidates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("search_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("citation_searches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("direction", sa.String(20), nullable=False),
        sa.Column("source_record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id", ondelete="SET NULL"), nullable=True),
        sa.Column("s2_paper_id", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("abstract", sa.Text(), nullable=True),
        sa.Column("authors", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("year", sa.Integer(), nullable=True),
        sa.Column("doi", sa.Text(), nullable=True),
        sa.Column("pmid", sa.Text(), nullable=True),
        sa.Column("journal", sa.Text(), nullable=True),
        sa.Column("in_project", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("project_record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id", ondelete="SET NULL"), nullable=True),
        sa.Column("decision", sa.String(20), nullable=True),
        sa.Column("decided_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("import_job_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("import_jobs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_citation_candidates_search", "citation_candidates", ["search_id"])
    op.create_index("ix_citation_candidates_project", "citation_candidates", ["project_id"])

    # Partial unique indexes — must be raw SQL (SQLAlchemy cannot express WHERE clause)
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_doi  ON citation_candidates(search_id, doi)        WHERE doi        IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_pmid ON citation_candidates(search_id, pmid)       WHERE pmid       IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_s2   ON citation_candidates(search_id, s2_paper_id) WHERE s2_paper_id IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_table("citation_candidates")
    op.drop_table("citation_searches")
