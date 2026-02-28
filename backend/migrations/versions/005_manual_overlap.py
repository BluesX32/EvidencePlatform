"""Manual overlap linking: origin, locked, added_by, note columns.

Revision ID: 005
Revises: 004
Create Date: 2026-02-27

Changes:
  - overlap_clusters: ADD origin VARCHAR(10) DEFAULT 'auto'
        ('auto' = algorithmic, 'manual' = user-created, 'mixed' = started auto then user modified)
  - overlap_clusters: ADD locked BOOLEAN DEFAULT false
        (locked clusters are never modified or deleted by algorithmic reruns)
  - overlap_cluster_members: ADD added_by VARCHAR(10) DEFAULT 'auto'
        ('auto' = detector, 'user' = manually added)
  - overlap_cluster_members: ADD note TEXT NULL
        (optional user note when manually linking)
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── overlap_clusters: origin and locked ───────────────────────────────────
    op.add_column(
        "overlap_clusters",
        sa.Column(
            "origin",
            sa.String(10),
            nullable=False,
            server_default="auto",
            comment="'auto' | 'manual' | 'mixed'",
        ),
    )
    op.add_column(
        "overlap_clusters",
        sa.Column(
            "locked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
            comment="If True, algorithm reruns will not modify or delete this cluster",
        ),
    )

    # ── overlap_cluster_members: added_by and note ────────────────────────────
    op.add_column(
        "overlap_cluster_members",
        sa.Column(
            "added_by",
            sa.String(10),
            nullable=False,
            server_default="auto",
            comment="'auto' | 'user'",
        ),
    )
    op.add_column(
        "overlap_cluster_members",
        sa.Column(
            "note",
            sa.Text(),
            nullable=True,
            comment="Optional user note attached when manually linking",
        ),
    )


def downgrade() -> None:
    op.drop_column("overlap_cluster_members", "note")
    op.drop_column("overlap_cluster_members", "added_by")
    op.drop_column("overlap_clusters", "locked")
    op.drop_column("overlap_clusters", "origin")
