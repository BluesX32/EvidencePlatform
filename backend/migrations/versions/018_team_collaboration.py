"""Team collaboration — project_members activation, invitations, consensus.

Revision ID: 018
Revises: 017
Create Date: 2026-03-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Activate project_members (already exists as stub) ────────────────────
    # Add invited_by and status columns
    op.add_column(
        "project_members",
        sa.Column("invited_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column(
        "project_members",
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
    )
    # Unique: one membership row per (project, user)
    op.create_unique_constraint("uq_project_members_project_user", "project_members", ["project_id", "user_id"])
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])

    # ── project_invitations ───────────────────────────────────────────────────
    op.create_table(
        "project_invitations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("invited_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role", sa.String(20), nullable=False, server_default="reviewer"),
        # token is the shareable accept-link token (UUID)
        sa.Column("token", sa.Text(), nullable=False),
        # pending / accepted / revoked
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_project_invitations_token", "project_invitations", ["token"], unique=True)
    op.create_index("ix_project_invitations_project_id", "project_invitations", ["project_id"])

    # ── consensus_decisions (adjudication) ───────────────────────────────────
    op.create_table(
        "consensus_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("record_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("records.id", ondelete="CASCADE"), nullable=True),
        sa.Column("cluster_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("overlap_clusters.id", ondelete="CASCADE"), nullable=True),
        sa.Column("stage", sa.String(10), nullable=False),       # TA | FT
        sa.Column("decision", sa.String(20), nullable=False),    # include | exclude
        sa.Column("reason_code", sa.String(50), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("adjudicator_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR (record_id IS NULL AND cluster_id IS NOT NULL)",
            name="ck_consensus_exactly_one",
        ),
    )
    # One consensus per (project, record|cluster, stage)
    op.create_unique_constraint(
        "uq_consensus_record_stage",
        "consensus_decisions",
        ["project_id", "record_id", "stage"],
        postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_unique_constraint(
        "uq_consensus_cluster_stage",
        "consensus_decisions",
        ["project_id", "cluster_id", "stage"],
        postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("consensus_decisions")
    op.drop_table("project_invitations")
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_constraint("uq_project_members_project_user", "project_members", type_="unique")
    op.drop_column("project_members", "status")
    op.drop_column("project_members", "invited_by")