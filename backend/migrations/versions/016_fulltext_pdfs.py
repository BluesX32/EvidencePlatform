"""Add fulltext_pdfs table for per-article PDF uploads during screening.

Revision ID: 016
Revises: 015
Create Date: 2026-03-09

upgrade:
  fulltext_pdfs: one uploaded PDF per (project, record|cluster).
  Partial UNIQUE indexes enforce the one-per-item constraint separately
  for direct records and clusters.
  storage_path holds the server-side file path (set by the upload router).

downgrade:
  Drop fulltext_pdfs.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "fulltext_pdfs",
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
        # CHECK: exactly one of record_id / cluster_id is non-null
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="ck_fulltext_pdfs_item",
        ),
        sa.Column("original_filename", sa.String(500), nullable=False),
        sa.Column("storage_path", sa.Text, nullable=False),
        sa.Column("file_size", sa.Integer, nullable=False),
        sa.Column(
            "content_type",
            sa.String(100),
            nullable=False,
            server_default="application/pdf",
        ),
        sa.Column(
            "uploaded_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_ftp_project", "fulltext_pdfs", ["project_id"])
    # One PDF per (project, record)
    op.create_index(
        "uq_ftp_record",
        "fulltext_pdfs",
        ["project_id", "record_id"],
        unique=True,
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    # One PDF per (project, cluster)
    op.create_index(
        "uq_ftp_cluster",
        "fulltext_pdfs",
        ["project_id", "cluster_id"],
        unique=True,
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("fulltext_pdfs")