"""Add concept_taxonomy_nodes table for concept hierarchy and merging.

Revision ID: 033
Revises: 032
Create Date: 2026-04-27

upgrade:
  - Create concept_taxonomy_nodes table (self-referential tree via parent_id)
    with aliases JSONB for merged values.

downgrade:
  - Drop concept_taxonomy_nodes.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "033"
down_revision: Union[str, None] = "032"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "concept_taxonomy_nodes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("field_id", sa.Text(), nullable=False),
        sa.Column("field_type", sa.Text(), nullable=False),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concept_taxonomy_nodes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "aliases",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("project_id", "field_id", "name", name="uq_ctn_project_field_name"),
    )
    op.create_index("ix_ctn_project", "concept_taxonomy_nodes", ["project_id"])
    op.create_index("ix_ctn_parent", "concept_taxonomy_nodes", ["parent_id"])


def downgrade() -> None:
    op.drop_table("concept_taxonomy_nodes")
