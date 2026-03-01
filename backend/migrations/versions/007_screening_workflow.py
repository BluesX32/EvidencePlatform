"""Screening & Saturation workflow tables.

Revision ID: 007
Revises: 006
Create Date: 2026-03-01

Changes:
  - CREATE TABLE corpora
      Named subsets of project records for screening
  - CREATE TABLE corpus_queue_items
      Shuffled deterministic queue of canonical keys per corpus
  - CREATE TABLE corpus_decisions
      TA / FT screening decisions per canonical key
  - CREATE TABLE corpus_borderline_cases
      Escalated borderline papers awaiting committee resolution
  - CREATE TABLE corpus_extractions
      Structured conceptual extraction per canonical key
  - CREATE TABLE corpus_second_reviews
      Second-reviewer agreement check rows
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # corpora
    # ------------------------------------------------------------------
    op.create_table(
        "corpora",
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
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        # Array of source UUIDs in scope
        sa.Column(
            "source_ids",
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("saturation_threshold", sa.Integer, nullable=False, server_default="10"),
        sa.Column("consecutive_no_novelty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_extracted", sa.Integer, nullable=False, server_default="0"),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("queue_seed", sa.BigInteger, nullable=True),
        sa.Column("queue_generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("queue_size", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_corpora_project_id", "corpora", ["project_id"])

    # ------------------------------------------------------------------
    # corpus_queue_items
    # ------------------------------------------------------------------
    op.create_table(
        "corpus_queue_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "corpus_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("corpora.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("order_index", sa.Integer, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_unique_constraint(
        "uq_corpus_queue_items_corpus_key",
        "corpus_queue_items",
        ["corpus_id", "canonical_key"],
    )
    op.create_index(
        "ix_corpus_queue_items_corpus_order",
        "corpus_queue_items",
        ["corpus_id", "order_index"],
    )

    # ------------------------------------------------------------------
    # corpus_decisions
    # ------------------------------------------------------------------
    op.create_table(
        "corpus_decisions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "corpus_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("corpora.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column(
            "stage",
            sa.String(10),
            nullable=False,
            comment="TA | FT",
        ),
        sa.Column(
            "decision",
            sa.String(20),
            nullable=False,
            comment="include | exclude | borderline",
        ),
        sa.Column("reason_code", sa.String(50), nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_corpus_decisions_corpus_key_stage",
        "corpus_decisions",
        ["corpus_id", "canonical_key", "stage"],
    )

    # ------------------------------------------------------------------
    # corpus_borderline_cases
    # ------------------------------------------------------------------
    op.create_table(
        "corpus_borderline_cases",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "corpus_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("corpora.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("stage", sa.String(10), nullable=False, comment="TA | FT"),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="open",
            comment="open | resolved",
        ),
        sa.Column("resolution_decision", sa.String(20), nullable=True),
        sa.Column("resolution_notes", sa.Text, nullable=True),
        sa.Column(
            "resolved_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_corpus_borderline_cases_corpus_id",
        "corpus_borderline_cases",
        ["corpus_id"],
    )

    # ------------------------------------------------------------------
    # corpus_extractions
    # ------------------------------------------------------------------
    op.create_table(
        "corpus_extractions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "corpus_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("corpora.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("extracted_json", postgresql.JSONB, nullable=False),
        sa.Column("novelty_flag", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("novelty_notes", sa.Text, nullable=True),
        sa.Column(
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_unique_constraint(
        "uq_corpus_extractions_corpus_key",
        "corpus_extractions",
        ["corpus_id", "canonical_key"],
    )

    # ------------------------------------------------------------------
    # corpus_second_reviews
    # ------------------------------------------------------------------
    op.create_table(
        "corpus_second_reviews",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "corpus_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("corpora.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column(
            "stage",
            sa.String(20),
            nullable=False,
            comment="TA | FT | extraction",
        ),
        sa.Column("agree", sa.Boolean, nullable=False),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_corpus_second_reviews_corpus_id",
        "corpus_second_reviews",
        ["corpus_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_corpus_second_reviews_corpus_id", "corpus_second_reviews")
    op.drop_table("corpus_second_reviews")

    op.drop_constraint("uq_corpus_extractions_corpus_key", "corpus_extractions", type_="unique")
    op.drop_table("corpus_extractions")

    op.drop_index("ix_corpus_borderline_cases_corpus_id", "corpus_borderline_cases")
    op.drop_table("corpus_borderline_cases")

    op.drop_index("ix_corpus_decisions_corpus_key_stage", "corpus_decisions")
    op.drop_table("corpus_decisions")

    op.drop_index("ix_corpus_queue_items_corpus_order", "corpus_queue_items")
    op.drop_constraint("uq_corpus_queue_items_corpus_key", "corpus_queue_items", type_="unique")
    op.drop_table("corpus_queue_items")

    op.drop_index("ix_corpora_project_id", "corpora")
    op.drop_table("corpora")
