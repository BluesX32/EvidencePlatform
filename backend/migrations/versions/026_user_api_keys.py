"""Add api_keys JSONB column to users table.

Revision ID: 026
Revises: 025
Create Date: 2026-04-05
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("api_keys", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "api_keys")
