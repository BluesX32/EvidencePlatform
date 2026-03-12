"""Add drawing_data JSONB column to fulltext_pdfs for per-page freehand annotations.

Revision ID: 019
Revises: 018
Create Date: 2026-03-12

upgrade:
  fulltext_pdfs: drawing_data JSONB nullable column.
  Stores a dict keyed by page number (1-indexed strings) whose values are
  lists of stroke objects: {"color": str, "width": int, "points": [[x,y],...]}.

downgrade:
  Drop the column.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "fulltext_pdfs",
        sa.Column(
            "drawing_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="Freehand annotation strokes keyed by page number",
        ),
    )


def downgrade() -> None:
    op.drop_column("fulltext_pdfs", "drawing_data")
