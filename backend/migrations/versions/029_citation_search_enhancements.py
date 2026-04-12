"""Citation search enhancements: scope, source_record_ids, source_record_count.

Revision ID: 029
Revises: 028
Create Date: 2026-04-12

upgrade:
  citation_searches:
    - scope VARCHAR(20)  -- 'all' | 'new' | 'custom' (which extracted papers were used)
    - source_record_count INTEGER  -- how many extracted papers were used as source
    - source_record_ids JSONB  -- array of record UUID strings used as source

downgrade:
  Drop all three columns.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "citation_searches",
        sa.Column("scope", sa.VARCHAR(20), nullable=True, server_default="all"),
    )
    op.add_column(
        "citation_searches",
        sa.Column("source_record_count", sa.Integer(), nullable=True),
    )
    op.add_column(
        "citation_searches",
        sa.Column("source_record_ids", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("citation_searches", "source_record_ids")
    op.drop_column("citation_searches", "source_record_count")
    op.drop_column("citation_searches", "scope")
