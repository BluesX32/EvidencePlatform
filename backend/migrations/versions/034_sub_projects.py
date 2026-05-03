"""Add sub-project support: parent_project_id on projects + project_samples table.

Revision ID: 034
Revises: 033
Create Date: 2026-04-28

upgrade:
  - Add nullable parent_project_id FK on projects (self-referential).
  - Create project_samples table: records the seed, n_per_corpus, and
    sampled record mapping for every sub-project created by sampling.

downgrade:
  - Drop project_samples.
  - Drop parent_project_id column from projects.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "034"
down_revision: Union[str, None] = "033"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "parent_project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    op.create_table(
        "project_samples",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("parent_project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("child_project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("seed", sa.Integer(), nullable=False),
        sa.Column("n_per_corpus", sa.Integer(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        # JSON snapshot: {source_name: [parent_record_source_id, ...]} for reproducibility
        sa.Column("sampled_record_ids", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    op.create_unique_constraint("uq_project_samples_child", "project_samples", ["child_project_id"])


def downgrade() -> None:
    op.drop_table("project_samples")
    op.drop_column("projects", "parent_project_id")
