"""LLM section enhancements: two screening modes, extraction, prompt config, comparison.

Revision ID: 025
Revises: 024
Create Date: 2026-04-05

upgrade:
  1. llm_screening_runs: add mode, source_id, seed, saturation_threshold,
     include_extraction, stopped_at_saturation columns + CHECK constraint.
  2. llm_screening_results: add extracted_json JSONB column.
  3. projects: add llm_config JSONB column.

downgrade:
  Reverse all additions.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "025"
down_revision: Union[str, None] = "024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── llm_screening_runs: new columns ──────────────────────────────────────
    op.add_column(
        "llm_screening_runs",
        sa.Column("mode", sa.String(20), nullable=False, server_default="prisma_scr"),
    )
    op.create_check_constraint(
        "ck_llm_run_mode",
        "llm_screening_runs",
        "mode IN ('prisma_scr', 'saturation')",
    )
    op.add_column(
        "llm_screening_runs",
        sa.Column(
            "source_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sources.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "llm_screening_runs",
        sa.Column("seed", sa.Integer(), nullable=True),
    )
    op.add_column(
        "llm_screening_runs",
        sa.Column(
            "saturation_threshold",
            sa.Integer(),
            nullable=False,
            server_default="5",
        ),
    )
    op.add_column(
        "llm_screening_runs",
        sa.Column(
            "include_extraction",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )
    op.add_column(
        "llm_screening_runs",
        sa.Column(
            "stopped_at_saturation",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )

    # ── llm_screening_results: add extracted_json ─────────────────────────────
    op.add_column(
        "llm_screening_results",
        sa.Column("extracted_json", postgresql.JSONB(), nullable=True),
    )

    # ── projects: add llm_config ──────────────────────────────────────────────
    op.add_column(
        "projects",
        sa.Column("llm_config", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "llm_config")
    op.drop_column("llm_screening_results", "extracted_json")
    op.drop_constraint("ck_llm_run_mode", "llm_screening_runs", type_="check")
    op.drop_column("llm_screening_runs", "stopped_at_saturation")
    op.drop_column("llm_screening_runs", "include_extraction")
    op.drop_column("llm_screening_runs", "saturation_threshold")
    op.drop_column("llm_screening_runs", "seed")
    op.drop_column("llm_screening_runs", "source_id")
    op.drop_column("llm_screening_runs", "mode")
