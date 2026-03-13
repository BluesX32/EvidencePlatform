"""Screening queues — seeded, persistent, position-tracked.

Revision ID: 021
Revises: 020
Create Date: 2026-03-13
"""
from typing import Sequence, Union
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "screening_queues",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_id", sa.Text(), nullable=False),   # "all" or UUID string
        sa.Column("stage", sa.String(20), nullable=False),   # "screen" | "fulltext" | "extract" | "mixed"
        sa.Column("seed", sa.Integer(), nullable=False),
        sa.Column("slots", postgresql.JSONB(), nullable=False),  # [{"type": "record"|"cluster", "id": "uuid"}]
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("project_id", "reviewer_id", "source_id", "stage", name="uq_screening_queue"),
    )
    op.create_index("ix_screening_queues_project_reviewer", "screening_queues", ["project_id", "reviewer_id"])


def downgrade() -> None:
    op.drop_index("ix_screening_queues_project_reviewer", table_name="screening_queues")
    op.drop_table("screening_queues")
