"""Add reason_code to llm_screening_results for structured exclusion categorization.

Revision ID: 039
Revises: 038
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "039"
down_revision: Union[str, None] = "038"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "llm_screening_results",
        sa.Column("reason_code", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("llm_screening_results", "reason_code")
