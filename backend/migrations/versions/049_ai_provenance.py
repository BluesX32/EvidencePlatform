"""Structured AI provenance on decision/extraction tables.

Adds an `origin` column ('human' | 'ai') to every table AI can write to,
replacing implicit conventions (reviewer_id IS NULL, "[AI]" note prefixes),
plus `llm_run_id` linkage where rows are produced by a screening run.
Backfills origin from the old conventions.

Revision ID: 049
Revises: 048
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "049"
down_revision = "048"
branch_labels = None
depends_on = None

_ORIGIN_TABLES = [
    "screening_decisions",
    "consensus_decisions",
    "code_extractions",
    "concept_extractions",
    "extraction_records",
]


def upgrade():
    for table in _ORIGIN_TABLES:
        op.add_column(
            table,
            sa.Column("origin", sa.String(12), nullable=False, server_default="human"),
        )
        op.create_check_constraint(
            f"ck_{table}_origin", table, "origin IN ('human', 'ai')"
        )

    for table in ("screening_decisions", "extraction_records"):
        op.add_column(
            table,
            sa.Column(
                "llm_run_id",
                UUID(as_uuid=True),
                sa.ForeignKey("llm_screening_runs.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )

    # Backfill from the old implicit conventions
    op.execute("UPDATE screening_decisions SET origin = 'ai' WHERE reviewer_id IS NULL")
    op.execute("UPDATE extraction_records SET origin = 'ai' WHERE reviewer_id IS NULL")
    op.execute("UPDATE consensus_decisions SET origin = 'ai' WHERE notes LIKE '[AI]%'")
    op.execute("UPDATE code_extractions SET origin = 'ai' WHERE note = '[AI assigned]'")


def downgrade():
    for table in ("screening_decisions", "extraction_records"):
        op.drop_column(table, "llm_run_id")
    for table in _ORIGIN_TABLES:
        op.drop_constraint(f"ck_{table}_origin", table)
        op.drop_column(table, "origin")
