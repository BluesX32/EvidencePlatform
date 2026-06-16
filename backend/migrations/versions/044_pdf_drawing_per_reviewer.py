"""Isolate PDF freehand drawing annotations per reviewer.

Revision ID: 044
Revises: 043
Create Date: 2026-06-16

upgrade:
  Create pdf_drawing_annotations (fulltext_pdf_id, reviewer_id, drawing_data).
  Unique index on (fulltext_pdf_id, reviewer_id) so each reviewer owns one
  drawing layer per PDF while sharing the underlying file.
  Migrate any existing fulltext_pdfs.drawing_data rows into the new table
  using uploaded_by as the reviewer_id.
  Drop drawing_data column from fulltext_pdfs.

downgrade:
  Re-add drawing_data to fulltext_pdfs, copy back the first drawing per pdf,
  drop pdf_drawing_annotations.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "044"
down_revision: Union[str, None] = "043"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pdf_drawing_annotations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "fulltext_pdf_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("fulltext_pdfs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "drawing_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "uq_pdf_drawing_reviewer",
        "pdf_drawing_annotations",
        ["fulltext_pdf_id", "reviewer_id"],
        unique=True,
    )

    # Migrate existing drawing_data (uploaded_by becomes the reviewer owner)
    op.execute(
        """
        INSERT INTO pdf_drawing_annotations (fulltext_pdf_id, reviewer_id, drawing_data)
        SELECT id, uploaded_by, drawing_data
        FROM fulltext_pdfs
        WHERE drawing_data IS NOT NULL
        ON CONFLICT DO NOTHING
        """
    )

    op.drop_column("fulltext_pdfs", "drawing_data")


def downgrade() -> None:
    op.add_column(
        "fulltext_pdfs",
        sa.Column(
            "drawing_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    # Restore the most recently updated drawing per pdf
    op.execute(
        """
        UPDATE fulltext_pdfs fp
        SET drawing_data = pda.drawing_data
        FROM (
            SELECT DISTINCT ON (fulltext_pdf_id)
                fulltext_pdf_id, drawing_data
            FROM pdf_drawing_annotations
            ORDER BY fulltext_pdf_id, updated_at DESC
        ) pda
        WHERE fp.id = pda.fulltext_pdf_id
        """
    )
    op.drop_table("pdf_drawing_annotations")
