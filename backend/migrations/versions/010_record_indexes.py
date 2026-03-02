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

Note: uses op.execute() with raw DDL because Alembic's create_index()
postgresql_ops parameter is for operator class names (e.g. text_pattern_ops),
not for column sort directions (DESC NULLS LAST). Raw DDL is the correct
approach for sort-order index specifications.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_records_project_year "
        "ON records (project_id, year DESC NULLS LAST)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_records_project_created "
        "ON records (project_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_sd_project_stage_decision "
        "ON screening_decisions (project_id, stage, decision) "
        "WHERE record_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_sd_project_stage_decision")
    op.execute("DROP INDEX IF EXISTS ix_records_project_created")
    op.execute("DROP INDEX IF EXISTS ix_records_project_year")
