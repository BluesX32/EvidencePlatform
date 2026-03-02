"""Performance indexes for records and screening_decisions.

Revision ID: 010
Revises: 009
Create Date: 2026-03-01

upgrade:
  ix_records_project_year       — records(project_id, year DESC NULLS LAST)
  ix_records_project_created    — records(project_id, created_at DESC)
  ix_sd_project_stage_decision  — screening_decisions(project_id, stage, decision)
                                   WHERE record_id IS NOT NULL

downgrade:
  DROP all three indexes.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_records_project_year",
        "records",
        ["project_id", "year"],
        postgresql_ops={"year": "DESC NULLS LAST"},
    )
    op.create_index(
        "ix_records_project_created",
        "records",
        ["project_id", "created_at"],
        postgresql_ops={"created_at": "DESC"},
    )
    op.create_index(
        "ix_sd_project_stage_decision",
        "screening_decisions",
        ["project_id", "stage", "decision"],
        postgresql_where="record_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_index("ix_sd_project_stage_decision", table_name="screening_decisions")
    op.drop_index("ix_records_project_created", table_name="records")
    op.drop_index("ix_records_project_year", table_name="records")
