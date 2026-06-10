"""Add shared_with_team boolean to projects for sub-project visibility control.

Revision ID: 043
Revises: 042
Create Date: 2026-06-10

When shared_with_team=True on a sub-project, all team members of the parent
project can see and use the sub-project.  Default is False (private to owner).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "043"
down_revision: Union[str, None] = "042"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "shared_with_team",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("projects", "shared_with_team")
