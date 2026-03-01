"""Add status column to corpus_queue_items.

Revision ID: 008
Revises: 007
Create Date: 2026-03-01

Changes:
  - ALTER TABLE corpus_queue_items ADD COLUMN status VARCHAR(20) DEFAULT 'pending'
      Values: 'pending' | 'skipped' | 'decided' | 'extracted'
  - CREATE INDEX on (corpus_id, status, order_index) for efficient next-item queries
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "corpus_queue_items",
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
            comment="pending | skipped | decided | extracted",
        ),
    )
    op.create_index(
        "ix_corpus_queue_items_corpus_status_order",
        "corpus_queue_items",
        ["corpus_id", "status", "order_index"],
    )


def downgrade() -> None:
    op.drop_index("ix_corpus_queue_items_corpus_status_order", "corpus_queue_items")
    op.drop_column("corpus_queue_items", "status")
