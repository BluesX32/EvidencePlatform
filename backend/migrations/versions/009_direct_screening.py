"""Direct project-level screening — remove corpus layer.

Revision ID: 009
Revises: 008
Create Date: 2026-03-01

upgrade:
  Safety: aborts if corpora table has rows unless FORCE_MIGRATION_009=1.
  DROP corpus tables (007-008): corpus_second_reviews, corpus_extractions,
    corpus_borderline_cases, corpus_decisions, corpus_queue_items, corpora
  DROP old Phase 2/3 stubs (001): extracted_data, extraction_forms, screening_decisions
  CREATE screening_decisions (new: project_id, record_id/cluster_id FKs, stage, decision)
  CREATE extraction_records (same FK pattern + extracted_json JSONB)
  CREATE screening_claims  (soft lock: claimed_at, 30-min TTL)

downgrade:
  DROP new tables.
  RECREATE old stubs (screening_decisions, extraction_forms, extracted_data).
  RECREATE corpus tables (corpora, corpus_queue_items+status, corpus_decisions,
    corpus_borderline_cases, corpus_extractions, corpus_second_reviews).
"""
import os
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Safety check ──────────────────────────────────────────────────────────
    bind = op.get_bind()
    result = bind.execute(text("SELECT COUNT(*) FROM corpora"))
    count = result.scalar() or 0
    if count > 0 and not os.environ.get("FORCE_MIGRATION_009"):
        raise SystemExit(
            f"Migration 009 aborted: {count} row(s) exist in 'corpora'. "
            "Set FORCE_MIGRATION_009=1 to override (corpus data will be discarded)."
        )

    # ── Drop corpus tables (child-first order) ────────────────────────────────
    op.drop_index("ix_corpus_second_reviews_corpus_id", table_name="corpus_second_reviews")
    op.drop_table("corpus_second_reviews")

    op.drop_constraint("uq_corpus_extractions_corpus_key", "corpus_extractions", type_="unique")
    op.drop_table("corpus_extractions")

    op.drop_index("ix_corpus_borderline_cases_corpus_id", table_name="corpus_borderline_cases")
    op.drop_table("corpus_borderline_cases")

    op.drop_index("ix_corpus_decisions_corpus_key_stage", table_name="corpus_decisions")
    op.drop_table("corpus_decisions")

    op.drop_index("ix_corpus_queue_items_corpus_status_order", table_name="corpus_queue_items")
    op.drop_index("ix_corpus_queue_items_corpus_order", table_name="corpus_queue_items")
    op.drop_constraint("uq_corpus_queue_items_corpus_key", "corpus_queue_items", type_="unique")
    op.drop_table("corpus_queue_items")

    op.drop_index("ix_corpora_project_id", table_name="corpora")
    op.drop_table("corpora")

    # ── Drop old Phase 2/3 stubs (from migration 001) ─────────────────────────
    op.drop_table("extracted_data")
    op.drop_table("extraction_forms")
    op.drop_table("screening_decisions")

    # ── Create screening_decisions (new schema) ────────────────────────────────
    op.create_table(
        "screening_decisions",
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
        sa.Column("stage", sa.String(10), nullable=False, comment="TA | FT"),
        sa.Column("decision", sa.String(20), nullable=False, comment="include | exclude"),
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
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_sd_exactly_one",
        ),
    )
    # Partial unique indexes (NULL-safe — standard UNIQUE ignores NULL equality)
    op.execute(
        "CREATE UNIQUE INDEX uq_sd_record ON screening_decisions "
        "(project_id, record_id, stage, reviewer_id) WHERE record_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_sd_cluster ON screening_decisions "
        "(project_id, cluster_id, stage, reviewer_id) WHERE cluster_id IS NOT NULL"
    )
    op.create_index("ix_sd_project_stage",   "screening_decisions", ["project_id", "stage"])
    op.create_index("ix_sd_project_record",  "screening_decisions", ["project_id", "record_id"])
    op.create_index("ix_sd_project_cluster", "screening_decisions", ["project_id", "cluster_id"])

    # ── Create extraction_records ──────────────────────────────────────────────
    op.create_table(
        "extraction_records",
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
        sa.Column("extracted_json", postgresql.JSONB, nullable=False),
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
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_er_exactly_one",
        ),
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_er_record ON extraction_records "
        "(project_id, record_id) WHERE record_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_er_cluster ON extraction_records "
        "(project_id, cluster_id) WHERE cluster_id IS NOT NULL"
    )

    # ── Create screening_claims (soft lock, 30-min TTL) ───────────────────────
    op.create_table(
        "screening_claims",
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
            "reviewer_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "claimed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR "
            "(record_id IS NULL AND cluster_id IS NOT NULL)",
            name="chk_sc_exactly_one",
        ),
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_sc_record ON screening_claims "
        "(project_id, record_id) WHERE record_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_sc_cluster ON screening_claims "
        "(project_id, cluster_id) WHERE cluster_id IS NOT NULL"
    )


def downgrade() -> None:
    # ── Drop new screening tables ──────────────────────────────────────────────
    op.execute("DROP INDEX IF EXISTS uq_sc_cluster")
    op.execute("DROP INDEX IF EXISTS uq_sc_record")
    op.drop_table("screening_claims")

    op.execute("DROP INDEX IF EXISTS uq_er_cluster")
    op.execute("DROP INDEX IF EXISTS uq_er_record")
    op.drop_table("extraction_records")

    op.execute("DROP INDEX IF EXISTS uq_sd_cluster")
    op.execute("DROP INDEX IF EXISTS uq_sd_record")
    op.drop_index("ix_sd_project_cluster", table_name="screening_decisions")
    op.drop_index("ix_sd_project_record",  table_name="screening_decisions")
    op.drop_index("ix_sd_project_stage",   table_name="screening_decisions")
    op.drop_table("screening_decisions")

    # ── Recreate old Phase 2/3 stubs (from migration 001) ─────────────────────
    op.create_table(
        "screening_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=False),
        sa.Column("round", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "extraction_forms",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("protocol_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("protocols.id"), nullable=False),
        sa.Column("schema", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "extracted_data",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("record_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("records.id"), nullable=False),
        sa.Column("extraction_form_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("extraction_forms.id"), nullable=False),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id"), nullable=False),
        sa.Column("values", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )

    # ── Recreate corpus tables (from migrations 007-008) ──────────────────────
    op.create_table(
        "corpora",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("source_ids", postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
                  nullable=False, server_default="{}"),
        sa.Column("saturation_threshold", sa.Integer, nullable=False, server_default="10"),
        sa.Column("consecutive_no_novelty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_extracted", sa.Integer, nullable=False, server_default="0"),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("queue_seed", sa.BigInteger, nullable=True),
        sa.Column("queue_generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("queue_size", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_corpora_project_id", "corpora", ["project_id"])

    op.create_table(
        "corpus_queue_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("corpus_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("corpora.id", ondelete="CASCADE"), nullable=False),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("order_index", sa.Integer, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending",
                  comment="pending | skipped | decided | extracted"),
    )
    op.create_unique_constraint("uq_corpus_queue_items_corpus_key", "corpus_queue_items",
                                ["corpus_id", "canonical_key"])
    op.create_index("ix_corpus_queue_items_corpus_order", "corpus_queue_items",
                    ["corpus_id", "order_index"])
    op.create_index("ix_corpus_queue_items_corpus_status_order", "corpus_queue_items",
                    ["corpus_id", "status", "order_index"])

    op.create_table(
        "corpus_decisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("corpus_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("corpora.id", ondelete="CASCADE"), nullable=False),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("stage", sa.String(10), nullable=False, comment="TA | FT"),
        sa.Column("decision", sa.String(20), nullable=False),
        sa.Column("reason_code", sa.String(50), nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_corpus_decisions_corpus_key_stage", "corpus_decisions",
                    ["corpus_id", "canonical_key", "stage"])

    op.create_table(
        "corpus_borderline_cases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("corpus_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("corpora.id", ondelete="CASCADE"), nullable=False),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("stage", sa.String(10), nullable=False, comment="TA | FT"),
        sa.Column("status", sa.String(20), nullable=False, server_default="open",
                  comment="open | resolved"),
        sa.Column("resolution_decision", sa.String(20), nullable=True),
        sa.Column("resolution_notes", sa.Text, nullable=True),
        sa.Column("resolved_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_corpus_borderline_cases_corpus_id", "corpus_borderline_cases", ["corpus_id"])

    op.create_table(
        "corpus_extractions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("corpus_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("corpora.id", ondelete="CASCADE"), nullable=False),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("extracted_json", postgresql.JSONB, nullable=False),
        sa.Column("novelty_flag", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("novelty_notes", sa.Text, nullable=True),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint("uq_corpus_extractions_corpus_key", "corpus_extractions",
                                ["corpus_id", "canonical_key"])

    op.create_table(
        "corpus_second_reviews",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("corpus_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("corpora.id", ondelete="CASCADE"), nullable=False),
        sa.Column("canonical_key", sa.String(100), nullable=False),
        sa.Column("stage", sa.String(20), nullable=False, comment="TA | FT | extraction"),
        sa.Column("agree", sa.Boolean, nullable=False),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column("reviewer_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_corpus_second_reviews_corpus_id", "corpus_second_reviews", ["corpus_id"])
