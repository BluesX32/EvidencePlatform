"""Per-run history for overlap detection.

Revision ID: 006
Revises: 005
Create Date: 2026-03-01

Changes:
  - CREATE TABLE overlap_strategy_runs
      Stores one row per cross-source overlap detection run with:
        * status, triggered_by, started_at / finished_at
        * within/cross source result counts
        * params_snapshot (OverlapConfig JSON at time of run)
        * error_message (on failure)
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "overlap_strategy_runs",
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
            sa.ForeignKey("match_strategies.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="running",
            comment="running | completed | failed",
        ),
        sa.Column(
            "triggered_by",
            sa.String(10),
            nullable=False,
            server_default="manual",
            comment="manual | auto",
        ),
        sa.Column("within_source_groups", sa.Integer, nullable=True),
        sa.Column("within_source_records", sa.Integer, nullable=True),
        sa.Column("cross_source_groups", sa.Integer, nullable=True),
        sa.Column("cross_source_records", sa.Integer, nullable=True),
        sa.Column("sources_count", sa.Integer, nullable=True),
        sa.Column("params_snapshot", postgresql.JSONB, nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
    )
    op.create_index(
        "ix_overlap_strategy_runs_project_started",
        "overlap_strategy_runs",
        ["project_id", "started_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_overlap_strategy_runs_project_started", "overlap_strategy_runs")
    op.drop_table("overlap_strategy_runs")
