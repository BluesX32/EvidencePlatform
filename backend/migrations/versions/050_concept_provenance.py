"""Concept provenance — mentions, canonical mapping, transformation events.

Addresses the implementation audit's Priority-0 gaps in the concept pipeline:
  - concept_mentions: passage-grounded, first-class raw values extracted from
    a concept_extractions row, with AI-call/job linkage and canonical mapping.
  - concept_events: append-only ledger for merge and ontology-mapping actions
    (generalizes the thematic_history pattern — snapshot names/state so a
    deleted or renamed node remains reconstructable).
  - concept_extractions.derived_from_id + a per-origin unique constraint, so
    a human edit of an AI suggestion creates a distinct row instead of
    silently overwriting the AI original.
  - llm_calls.ai_job_id, so a batch job's calls are directly traceable.

Revision ID: 050
Revises: 049
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "050"
down_revision = "049"
branch_labels = None
depends_on = None


def upgrade():
    # ── llm_calls: link each call to the batch job that triggered it ────────
    op.add_column(
        "llm_calls",
        sa.Column(
            "ai_job_id",
            UUID(as_uuid=True),
            sa.ForeignKey("ai_jobs.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_llm_calls_ai_job_id", "llm_calls", ["ai_job_id"])

    # ── concept_extractions: preserve AI originals across human edits ───────
    # Migration 032's partial unique indexes enforced exactly one row per
    # (project, item, reviewer) regardless of origin — precisely the
    # constraint that must be relaxed so a human edit of an AI suggestion can
    # coexist with the AI original instead of overwriting it.
    op.drop_index("uq_cext_record_reviewer", table_name="concept_extractions")
    op.drop_index("uq_cext_cluster_reviewer", table_name="concept_extractions")

    op.add_column(
        "concept_extractions",
        sa.Column(
            "derived_from_id",
            UUID(as_uuid=True),
            sa.ForeignKey("concept_extractions.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_concept_extractions_derived_from_id", "concept_extractions", ["derived_from_id"]
    )
    op.create_unique_constraint(
        "uq_ce_reviewer_item_origin",
        "concept_extractions",
        ["project_id", "reviewer_id", "record_id", "cluster_id", "origin"],
    )

    # ── concept_mentions: passage-grounded raw values ────────────────────────
    op.create_table(
        "concept_mentions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id", UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "concept_extraction_id", UUID(as_uuid=True),
            sa.ForeignKey("concept_extractions.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("field_id", sa.Text, nullable=False),
        sa.Column("field_type", sa.Text, nullable=False),
        sa.Column("value", sa.Text, nullable=False),
        sa.Column("source_quote", sa.Text, nullable=True),
        sa.Column("locator", JSONB, nullable=True),
        sa.Column("origin", sa.String(12), nullable=False, server_default="human"),
        sa.Column(
            "reviewer_id", UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "ai_job_id", UUID(as_uuid=True),
            sa.ForeignKey("ai_jobs.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "llm_call_id", UUID(as_uuid=True),
            sa.ForeignKey("llm_calls.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "canonical_node_id", UUID(as_uuid=True),
            sa.ForeignKey("concept_taxonomy_nodes.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("sequence_index", sa.Integer, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("origin IN ('human', 'ai')", name="chk_cm_origin"),
    )
    op.create_index("ix_concept_mentions_project_id", "concept_mentions", ["project_id"])
    op.create_index(
        "ix_concept_mentions_concept_extraction_id", "concept_mentions", ["concept_extraction_id"]
    )
    op.create_index("ix_concept_mentions_canonical_node_id", "concept_mentions", ["canonical_node_id"])
    op.create_index(
        "ix_concept_mentions_project_field_value", "concept_mentions", ["project_id", "field_id", "value"]
    )

    # ── concept_events: append-only transformation ledger ────────────────────
    op.create_table(
        "concept_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id", UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("entity_type", sa.String(20), nullable=False),
        sa.Column(
            "mention_id", UUID(as_uuid=True),
            sa.ForeignKey("concept_mentions.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "taxonomy_node_id", UUID(as_uuid=True),
            sa.ForeignKey("concept_taxonomy_nodes.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "ontology_node_id", UUID(as_uuid=True),
            sa.ForeignKey("ontology_nodes.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("mapping_type", sa.String(30), nullable=True),
        sa.Column("prior_state", JSONB, nullable=True),
        sa.Column("resulting_state", JSONB, nullable=True),
        sa.Column(
            "actor_id", UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("actor_origin", sa.String(12), nullable=False, server_default="human"),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "action IN ('create','accept','reject','map','unmap','merge','split',"
            "'rename','reparent','retype','relabel','map_ontology','unmap_ontology')",
            name="chk_cev_action",
        ),
        sa.CheckConstraint(
            "entity_type IN ('mention','taxonomy_node','ontology_mapping')",
            name="chk_cev_entity_type",
        ),
        sa.CheckConstraint("actor_origin IN ('human', 'ai')", name="chk_cev_actor_origin"),
    )
    op.create_index("ix_concept_events_project_created", "concept_events", ["project_id", "created_at"])
    op.create_index("ix_concept_events_mention_id", "concept_events", ["mention_id"])
    op.create_index("ix_concept_events_taxonomy_node_id", "concept_events", ["taxonomy_node_id"])
    op.create_index("ix_concept_events_ontology_node_id", "concept_events", ["ontology_node_id"])


def downgrade():
    op.drop_table("concept_events")
    op.drop_table("concept_mentions")
    op.drop_constraint("uq_ce_reviewer_item_origin", "concept_extractions", type_="unique")
    op.drop_index("ix_concept_extractions_derived_from_id", table_name="concept_extractions")
    op.drop_column("concept_extractions", "derived_from_id")
    op.create_index(
        "uq_cext_record_reviewer", "concept_extractions",
        ["project_id", "record_id", "reviewer_id"],
        unique=True, postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "uq_cext_cluster_reviewer", "concept_extractions",
        ["project_id", "cluster_id", "reviewer_id"],
        unique=True, postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )
    op.drop_index("ix_llm_calls_ai_job_id", table_name="llm_calls")
    op.drop_column("llm_calls", "ai_job_id")
