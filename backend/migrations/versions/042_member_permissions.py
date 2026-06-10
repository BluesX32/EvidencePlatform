"""Add permissions JSONB to project_members for per-member section visibility.

Revision ID: 042
Revises: 041
Create Date: 2026-06-10

NULL = all sections visible (default, backward-compatible).
Non-null = {"allowed_sections": ["overview", "screening", ...]}
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "042"
down_revision: Union[str, None] = "041"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "project_members",
        sa.Column("permissions", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("project_members", "permissions")
