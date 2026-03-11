"""Add LLM screening infrastructure: llm_screening_runs + llm_screening_results.

Revision ID: 017
Revises: 016
Create Date: 2026-03-11
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── llm_screening_runs ───────────────────────────────────────────────────
    op.create_table(
        "llm_screening_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),  # queued/running/completed/failed
        sa.Column("model", sa.String(80), nullable=False),
        sa.Column("total_records", sa.Integer, nullable=True),
        sa.Column("processed_records", sa.Integer, nullable=False, server_default="0"),
        sa.Column("included_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("excluded_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("uncertain_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("new_concepts_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("estimated_cost_usd", sa.Numeric(10, 6), nullable=True),
        sa.Column("actual_cost_usd", sa.Numeric(10, 6), nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("triggered_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_llm_runs_project", "llm_screening_runs", ["project_id"])

    # ── llm_screening_results ────────────────────────────────────────────────
    op.create_table(
        "llm_screening_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("llm_screening_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("record_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("records.id", ondelete="CASCADE"), nullable=True),
        sa.Column("cluster_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("overlap_clusters.id", ondelete="CASCADE"), nullable=True),
        # Decisions
        sa.Column("ta_decision", sa.String(10), nullable=True),   # include/exclude/uncertain
        sa.Column("ta_reason", sa.Text, nullable=True),
        sa.Column("ft_decision", sa.String(10), nullable=True),   # include/exclude/uncertain/null
        sa.Column("ft_reason", sa.Text, nullable=True),
        # Theme mapping
        sa.Column("matched_codes", postgresql.JSONB, nullable=True),   # [{code_id, code_name, snippet, confidence}]
        sa.Column("new_concepts", postgresql.JSONB, nullable=True),    # [{name, category_suggestion, snippet, rationale}]
        # Metadata
        sa.Column("full_text_source", sa.String(30), nullable=True),   # uploaded_pdf/unpaywall/pubmed_central/europe_pmc/abstract_only
        sa.Column("input_tokens", sa.Integer, nullable=True),
        sa.Column("output_tokens", sa.Integer, nullable=True),
        sa.Column("model", sa.String(80), nullable=True),
        # Human review
        sa.Column("reviewed_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_action", sa.String(20), nullable=True),  # accepted/rejected/merged
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(record_id IS NOT NULL AND cluster_id IS NULL) OR (record_id IS NULL AND cluster_id IS NOT NULL)",
            name="ck_llm_results_item",
        ),
    )
    op.create_index("ix_llm_results_run", "llm_screening_results", ["run_id"])
    op.create_index("ix_llm_results_project", "llm_screening_results", ["project_id"])


def downgrade() -> None:
    op.drop_table("llm_screening_results")
    op.drop_table("llm_screening_runs")
