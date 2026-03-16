"""Add extraction_template JSONB column to projects.

Revision ID: 022
Revises: 021
Create Date: 2026-03-15
"""
from typing import Sequence, Union
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "extraction_template",
            postgresql.JSONB(),
            nullable=True,
            server_default=sa.text("NULL"),
        ),
    )


def downgrade() -> None:
    op.drop_column("projects", "extraction_template")
