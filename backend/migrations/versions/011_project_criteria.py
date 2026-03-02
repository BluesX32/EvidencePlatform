"""Add criteria JSONB column to projects table.

Revision ID: 011
Revises: 010
Create Date: 2026-03-02

upgrade:
  Add criteria JSONB column with default {"inclusion": [], "exclusion": []}

downgrade:
  DROP criteria column
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "criteria",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default='{"inclusion": [], "exclusion": []}',
        ),
    )


def downgrade() -> None:
    op.drop_column("projects", "criteria")
