"""Add record_concepts table for tagging records/clusters with ontology nodes.

Revision ID: 023
Revises: 022
Create Date: 2026-03-15

upgrade:
  Create record_concepts (many-to-many between records/clusters and ontology_nodes).
  Each row targets exactly one of record_id or cluster_id.
  Duplicate assignments prevented by partial unique indexes.

downgrade:
  Drop record_concepts.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "023"
down_revision: Union[str, None] = "022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "record_concepts",
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
            "record_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("records.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "cluster_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("overlap_clusters.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "node_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "assigned_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "assigned_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) "
            "OR (record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_rc_exactly_one",
        ),
    )
    op.create_index("ix_rc_project", "record_concepts", ["project_id"])
    op.create_index(
        "ix_rc_record",
        "record_concepts",
        ["record_id"],
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "ix_rc_cluster",
        "record_concepts",
        ["cluster_id"],
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )
    # Prevent duplicate assignments
    op.create_index(
        "uq_rc_record_node",
        "record_concepts",
        ["project_id", "record_id", "node_id"],
        unique=True,
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "uq_rc_cluster_node",
        "record_concepts",
        ["project_id", "cluster_id", "node_id"],
        unique=True,
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("record_concepts")
