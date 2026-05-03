"""Add ON DELETE CASCADE to remaining project_id FKs that had NO ACTION.

Affected tables: import_jobs, dedup_pairs, project_members, protocols.

Revision ID: 036
Revises: 035
"""
from typing import Sequence, Union
from alembic import op

revision: str = "036"
down_revision: Union[str, None] = "035"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_FIXES = [
    ("import_jobs_project_id_fkey",    "import_jobs",    "project_id"),
    ("dedup_pairs_project_id_fkey",     "dedup_pairs",    "project_id"),
    ("project_members_project_id_fkey", "project_members","project_id"),
    ("protocols_project_id_fkey",       "protocols",      "project_id"),
]


def upgrade() -> None:
    for constraint, table, column in _FIXES:
        op.drop_constraint(constraint, table, type_="foreignkey")
        op.create_foreign_key(
            constraint, table, "projects",
            [column], ["id"],
            ondelete="CASCADE",
        )


def downgrade() -> None:
    for constraint, table, column in _FIXES:
        op.drop_constraint(constraint, table, type_="foreignkey")
        op.create_foreign_key(
            constraint, table, "projects",
            [column], ["id"],
        )
