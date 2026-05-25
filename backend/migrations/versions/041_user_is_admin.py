"""Add is_admin to users; seed earliest registered user as admin.

Revision ID: 041
Revises: 040
Create Date: 2026-05-25

The first user ever created (MIN created_at) is granted is_admin=true so
existing pre-invite-code accounts gain admin access automatically.
Subsequent users default to false.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "041"
down_revision: Union[str, None] = "040"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default="false"),
    )
    # Promote the earliest registered user to admin.
    op.execute(
        """
        UPDATE users
        SET    is_admin = true
        WHERE  created_at = (SELECT MIN(created_at) FROM users)
        """
    )


def downgrade() -> None:
    op.drop_column("users", "is_admin")
