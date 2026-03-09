"""Add ontology_nodes table for hierarchical taxonomy management.

Revision ID: 014
Revises: 013
Create Date: 2026-03-09

upgrade:
  Create ontology_nodes with self-referential parent_id (recursive hierarchy).
  Nodes carry name, description, namespace, color, and position (sibling order).
  Unique constraint prevents duplicate names under the same parent within a project.

downgrade:
  Drop ontology_nodes.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ontology_nodes",
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
        # Self-referential: NULL = root node; SET NULL = promote children on parent delete
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        # Namespace for grouping: level, dimension, concept, population, intervention, outcome, …
        sa.Column("namespace", sa.String(50), nullable=False, server_default="concept"),
        # Optional hex color for visual encoding (#RRGGBB)
        sa.Column("color", sa.String(7), nullable=True),
        # Sibling order within the same parent
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
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
        # No two siblings with the same name under the same parent in a project
        sa.UniqueConstraint(
            "project_id", "parent_id", "name",
            name="uq_ontology_sibling_name",
        ),
    )
    op.create_index("ix_on_project", "ontology_nodes", ["project_id"])
    op.create_index(
        "ix_on_parent",
        "ontology_nodes",
        ["parent_id"],
        postgresql_where=sa.text("parent_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("ontology_nodes")
