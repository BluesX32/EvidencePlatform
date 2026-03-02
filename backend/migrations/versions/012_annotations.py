"""Add record_annotations table for anchored comments.

Revision ID: 012
Revises: 011
Create Date: 2026-03-02

upgrade:
  Create record_annotations table with project_id, record_id|cluster_id,
  selected_text, comment, reviewer_id, created_at.
  CHECK constraint: exactly one of record_id / cluster_id must be non-NULL.

downgrade:
  Drop record_annotations table.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "record_annotations",
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
            "record_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("records.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "cluster_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("overlap_clusters.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("selected_text", sa.Text, nullable=False),
        sa.Column(
            "comment",
            sa.Text,
            nullable=False,
            server_default="",
        ),
        sa.Column(
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) "
            "OR (record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_ann_exactly_one",
        ),
    )
    op.create_index("ix_ann_project", "record_annotations", ["project_id"])
    op.create_index(
        "ix_ann_record",
        "record_annotations",
        ["record_id"],
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "ix_ann_cluster",
        "record_annotations",
        ["cluster_id"],
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("record_annotations")
