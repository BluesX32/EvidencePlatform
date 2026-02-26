"""Overlap Resolution: overlap_clusters and overlap_cluster_members tables.

Revision ID: 004
Revises: 003
Create Date: 2026-02-25

Changes:
  - New table: overlap_clusters
      Stores detected overlap groups (within-source duplicates or cross-source matches).
      scope = 'within_source' | 'cross_source'
  - New table: overlap_cluster_members
      Join table linking record_sources to overlap_clusters with a 'role'.
      role = 'canonical' | 'duplicate'
  - match_strategies: ADD selected_fields JSONB column (for future UI builder)
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. overlap_clusters ───────────────────────────────────────────────────
    op.create_table(
        "overlap_clusters",
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
        # The dedup_job that created this cluster (nullable for preview/manual runs)
        sa.Column(
            "job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("dedup_jobs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # 'within_source' — duplicate records in the same source file
        # 'cross_source'  — same paper appearing across multiple sources
        sa.Column("scope", sa.String(20), nullable=False),
        # Tier that caused this cluster (1=DOI/PMID, 2=title+year, 3=fuzzy)
        sa.Column("match_tier", sa.Integer(), nullable=False),
        # Machine-readable basis string (e.g. 'tier1_doi', 'tier2_title_year')
        sa.Column("match_basis", sa.String(50), nullable=False),
        # Human-readable explanation of why these records were grouped
        sa.Column("match_reason", sa.Text(), nullable=True),
        # Fuzzy similarity score (0-1), null for exact matches
        sa.Column("similarity_score", sa.Float(), nullable=True),
        # Extra details (e.g. matched DOI, matched title)
        sa.Column(
            "reason_json",
            postgresql.JSONB(),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_overlap_clusters_project_id", "overlap_clusters", ["project_id"])
    op.create_index("ix_overlap_clusters_job_id", "overlap_clusters", ["job_id"])
    op.create_index("ix_overlap_clusters_scope", "overlap_clusters", ["scope"])

    # ── 2. overlap_cluster_members ────────────────────────────────────────────
    op.create_table(
        "overlap_cluster_members",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "cluster_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("overlap_clusters.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "record_source_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("record_sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # 'canonical' — the representative record kept for this cluster
        # 'duplicate' — records merged/linked to the canonical
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_ocm_cluster_id", "overlap_cluster_members", ["cluster_id"]
    )
    op.create_index(
        "ix_ocm_record_source_id", "overlap_cluster_members", ["record_source_id"]
    )
    op.create_index(
        "ix_ocm_source_id", "overlap_cluster_members", ["source_id"]
    )
    # Unique: one role per record_source per cluster
    op.create_index(
        "uq_ocm_cluster_record_source",
        "overlap_cluster_members",
        ["cluster_id", "record_source_id"],
        unique=True,
    )

    # ── 3. match_strategies — add selected_fields for future builder UI ───────
    op.add_column(
        "match_strategies",
        sa.Column(
            "selected_fields",
            postgresql.JSONB(),
            nullable=True,
            comment=(
                "Ordered list of field names used in this strategy's rules "
                "(e.g. ['doi','pmid','title','year','author']). "
                "Null for legacy preset-based strategies."
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("match_strategies", "selected_fields")

    op.drop_index("uq_ocm_cluster_record_source", table_name="overlap_cluster_members")
    op.drop_index("ix_ocm_source_id", table_name="overlap_cluster_members")
    op.drop_index("ix_ocm_record_source_id", table_name="overlap_cluster_members")
    op.drop_index("ix_ocm_cluster_id", table_name="overlap_cluster_members")
    op.drop_table("overlap_cluster_members")

    op.drop_index("ix_overlap_clusters_scope", table_name="overlap_clusters")
    op.drop_index("ix_overlap_clusters_job_id", table_name="overlap_clusters")
    op.drop_index("ix_overlap_clusters_project_id", table_name="overlap_clusters")
    op.drop_table("overlap_clusters")
