"""Add page_num and highlight_rects to record_annotations for PDF text selection anchoring.

Revision ID: 020
Revises: 019
Create Date: 2026-03-12

upgrade:
  record_annotations: page_num INTEGER nullable — PDF page the selection is on.
  record_annotations: highlight_rects JSONB nullable — array of normalised rect
    objects [{x, y, w, h}] where coordinates are 0-1 fractions of page dimensions.

downgrade:
  Drop both columns.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "record_annotations",
        sa.Column("page_num", sa.Integer(), nullable=True,
                  comment="PDF page number (1-indexed) of the text selection"),
    )
    op.add_column(
        "record_annotations",
        sa.Column(
            "highlight_rects",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            comment="Array of {x,y,w,h} normalised rects for the selection highlight",
        ),
    )


def downgrade() -> None:
    op.drop_column("record_annotations", "highlight_rects")
    op.drop_column("record_annotations", "page_num")
