"""Add thematic analysis tables for iterative code/theme management.

Revision ID: 015
Revises: 014
Create Date: 2026-03-09

upgrade:
  code_extractions: links ontology "code" nodes to extraction_records with
    optional snippet text (the supporting quote) and analyst note.
    Codes are stored as ontology_nodes with namespace="code"; themes use
    namespace="theme".  This table is the evidence bridge.

  thematic_history: immutable audit trail of every code create, theme
    assignment/change, and rename.  Survives code deletion (code_id SET NULL).

downgrade:
  Drop both tables (order matters — history references code_extractions only
  indirectly, so either order is fine; we drop history first for clarity).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── code_extractions ──────────────────────────────────────────────────────
    op.create_table(
        "code_extractions",
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
            "code_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "extraction_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("extraction_records.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # The specific quote from the paper that supports this code
        sa.Column("snippet_text", sa.Text, nullable=True),
        # Analyst annotation for this code-paper link
        sa.Column("note", sa.Text, nullable=True),
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
    )
    op.create_index("ix_ce_project", "code_extractions", ["project_id"])
    op.create_index("ix_ce_code", "code_extractions", ["code_id"])
    op.create_index("ix_ce_extraction", "code_extractions", ["extraction_id"])

    # ── thematic_history ──────────────────────────────────────────────────────
    op.create_table(
        "thematic_history",
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
        # SET NULL so history survives code deletion
        sa.Column(
            "code_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Snapshot of code name at time of action (survives rename)
        sa.Column("code_name", sa.String(200), nullable=False),
        # create_code | create_theme | assign_theme | remove_theme | rename_code | rename_theme
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("old_theme_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("old_theme_name", sa.String(200), nullable=True),
        sa.Column("new_theme_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("new_theme_name", sa.String(200), nullable=True),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column(
            "changed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_th_project", "thematic_history", ["project_id"])
    op.create_index("ix_th_code", "thematic_history", ["code_id"])


def downgrade() -> None:
    op.drop_table("thematic_history")
    op.drop_table("code_extractions")