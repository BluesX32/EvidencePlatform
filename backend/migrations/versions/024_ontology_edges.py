"""Add ontology_edges table for explicit directed relationships between ontology nodes.

Revision ID: 024
Revises: 023
Create Date: 2026-03-16

upgrade:
  Create ontology_edges (directed edges between ontology_nodes within a project).
  Each edge has an optional label (relationship type) and optional color.
  UNIQUE(project_id, source_id, target_id) — one edge per ordered pair.

downgrade:
  Drop ontology_edges.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "024"
down_revision: Union[str, None] = "023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ontology_edges",
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
        sa.Column(
            "source_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.String(200), nullable=True),
        sa.Column("color", sa.String(7), nullable=True),
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
        sa.UniqueConstraint("project_id", "source_id", "target_id", name="uq_ontology_edge"),
    )
    op.create_index("ix_oe_project", "ontology_edges", ["project_id"])
    op.create_index("ix_oe_source", "ontology_edges", ["source_id"])
    op.create_index("ix_oe_target", "ontology_edges", ["target_id"])


def downgrade() -> None:
    op.drop_table("ontology_edges")
