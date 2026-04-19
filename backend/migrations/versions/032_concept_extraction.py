"""Add concept_template to projects + concept_extractions table.

Revision ID: 032
Revises: 031
Create Date: 2026-04-19

upgrade:
  - Add concept_template JSONB column to projects (nullable).
  - Create concept_extractions table: stores per-item concept extraction
    responses keyed by ConceptTemplateField.id.
  - Partial unique indexes: one extraction per (project, record) or
    (project, cluster) per reviewer.

downgrade:
  - Drop concept_extractions.
  - Drop concept_template column from projects.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "032"
down_revision: Union[str, None] = "031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("concept_template", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    op.create_table(
        "concept_extractions",
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
            "extracted_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) "
            "OR (record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_ce_exactly_one",
        ),
    )

    op.create_index("ix_cext_project", "concept_extractions", ["project_id"])
    op.create_index(
        "ix_cext_record",
        "concept_extractions",
        ["record_id"],
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "ix_cext_cluster",
        "concept_extractions",
        ["cluster_id"],
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )
    # One concept extraction per item per reviewer
    op.create_index(
        "uq_cext_record_reviewer",
        "concept_extractions",
        ["project_id", "record_id", "reviewer_id"],
        unique=True,
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "uq_cext_cluster_reviewer",
        "concept_extractions",
        ["project_id", "cluster_id", "reviewer_id"],
        unique=True,
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("concept_extractions")
    op.drop_column("projects", "concept_template")
