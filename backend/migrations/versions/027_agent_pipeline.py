"""Add agent_mode, agent_pipeline, agent_outputs for multi-agent screening.

Revision ID: 027
Revises: 026
Create Date: 2026-04-05
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # llm_screening_runs: which agent mode was used + snapshot of pipeline config
    op.add_column(
        "llm_screening_runs",
        sa.Column("agent_mode", sa.String(20), nullable=False, server_default="single"),
    )
    op.add_column(
        "llm_screening_runs",
        sa.Column("agent_pipeline", postgresql.JSONB(), nullable=True),
    )
    # llm_screening_results: per-agent reasoning/outputs for multi-agent runs
    op.add_column(
        "llm_screening_results",
        sa.Column("agent_outputs", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("llm_screening_results", "agent_outputs")
    op.drop_column("llm_screening_runs", "agent_pipeline")
    op.drop_column("llm_screening_runs", "agent_mode")
