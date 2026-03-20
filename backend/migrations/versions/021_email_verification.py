"""Add email_verified and verification_token to users table.

Revision ID: 021
Revises: 020
Create Date: 2026-03-18

upgrade:
  users: email_verified BOOLEAN NOT NULL DEFAULT false
  users: verification_token VARCHAR nullable, indexed
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("email_verified", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "users",
        sa.Column("verification_token", sa.String(), nullable=True),
    )
    op.create_index("ix_users_verification_token", "users", ["verification_token"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_users_verification_token", table_name="users")
    op.drop_column("users", "verification_token")
    op.drop_column("users", "email_verified")
