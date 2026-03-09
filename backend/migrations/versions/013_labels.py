"""Add project_labels and record_labels tables for article tagging.

Revision ID: 013
Revises: 012
Create Date: 2026-03-09

upgrade:
  Create project_labels (label definitions scoped to a project) and
  record_labels (many-to-many assignments between labels and records/clusters).
  Each record_label row targets exactly one of record_id or cluster_id.
  Duplicate assignments are prevented by partial unique indexes.

downgrade:
  Drop record_labels then project_labels.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Label definitions ──────────────────────────────────────────────────────
    op.create_table(
        "project_labels",
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
        # Hex color, e.g. "#6366f1"
        sa.Column("color", sa.String(7), nullable=False, server_default="#6366f1"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # No two labels with the same name in a project
        sa.UniqueConstraint("project_id", "name", name="uq_project_label_name"),
    )
    op.create_index("ix_pl_project", "project_labels", ["project_id"])

    # ── Label assignments ──────────────────────────────────────────────────────
    op.create_table(
        "record_labels",
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
        sa.Column(
            "label_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("project_labels.id", ondelete="CASCADE"),
            nullable=False,
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
            name="chk_rl_exactly_one",
        ),
    )
    op.create_index("ix_rl_project", "record_labels", ["project_id"])
    op.create_index(
        "ix_rl_record",
        "record_labels",
        ["record_id"],
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "ix_rl_cluster",
        "record_labels",
        ["cluster_id"],
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )
    # Prevent duplicate assignments
    op.create_index(
        "uq_rl_record_label",
        "record_labels",
        ["project_id", "record_id", "label_id"],
        unique=True,
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "uq_rl_cluster_label",
        "record_labels",
        ["project_id", "cluster_id", "label_id"],
        unique=True,
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("record_labels")
    op.drop_table("project_labels")