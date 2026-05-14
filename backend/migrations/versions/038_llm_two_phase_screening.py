"""Two-phase LLM screening: ta_only / ft_only modes, source_run_id, abstract_only_count.

Adds:
  - llm_screening_runs.source_run_id  (UUID FK → llm_screening_runs, nullable)
  - llm_screening_runs.abstract_only_count (integer, default 0)
  - Drops the old mode CHECK constraint and adds a new one that includes
    'ta_only' and 'ft_only' in addition to 'prisma_scr' and 'saturation'.

Revision ID: 038
Revises: 037
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision: str = "038"
down_revision: Union[str, None] = "037"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop old mode CHECK constraint
    op.drop_constraint("ck_llm_run_mode", "llm_screening_runs", type_="check")

    # Add new mode CHECK constraint that includes ta_only and ft_only
    op.create_check_constraint(
        "ck_llm_run_mode",
        "llm_screening_runs",
        "mode IN ('prisma_scr', 'saturation', 'ta_only', 'ft_only')",
    )

    # Add source_run_id (FK to self — links an ft_only run to its ta_only run)
    op.add_column(
        "llm_screening_runs",
        sa.Column(
            "source_run_id",
            UUID(as_uuid=True),
            sa.ForeignKey("llm_screening_runs.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # Add abstract_only_count
    op.add_column(
        "llm_screening_runs",
        sa.Column(
            "abstract_only_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("llm_screening_runs", "abstract_only_count")
    op.drop_column("llm_screening_runs", "source_run_id")
    op.drop_constraint("ck_llm_run_mode", "llm_screening_runs", type_="check")
    op.create_check_constraint(
        "ck_llm_run_mode",
        "llm_screening_runs",
        "mode IN ('prisma_scr', 'saturation')",
    )
