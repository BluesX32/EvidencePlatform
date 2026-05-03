"""Fix project_samples FKs: child_project_id ON DELETE CASCADE,
parent_project_id ON DELETE CASCADE (removes sample record when either
project is deleted).

Revision ID: 035
Revises: 034
"""
from typing import Sequence, Union
from alembic import op

revision: str = "035"
down_revision: Union[str, None] = "034"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop existing FKs on project_samples (no ondelete action)
    op.drop_constraint("project_samples_child_project_id_fkey", "project_samples", type_="foreignkey")
    op.drop_constraint("project_samples_parent_project_id_fkey", "project_samples", type_="foreignkey")

    # Recreate with CASCADE so deleting either project cleans up the sample row
    op.create_foreign_key(
        "project_samples_child_project_id_fkey",
        "project_samples", "projects",
        ["child_project_id"], ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "project_samples_parent_project_id_fkey",
        "project_samples", "projects",
        ["parent_project_id"], ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("project_samples_child_project_id_fkey", "project_samples", type_="foreignkey")
    op.drop_constraint("project_samples_parent_project_id_fkey", "project_samples", type_="foreignkey")
    op.create_foreign_key(
        "project_samples_child_project_id_fkey",
        "project_samples", "projects",
        ["child_project_id"], ["id"],
    )
    op.create_foreign_key(
        "project_samples_parent_project_id_fkey",
        "project_samples", "projects",
        ["parent_project_id"], ["id"],
    )
