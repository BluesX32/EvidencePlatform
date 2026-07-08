"""Fix concept_extractions uniqueness; add screening_queue_id to concept_mentions.

Re-audit finding (EP-Manuscript/p0_implementation_decision.md, item 2):
migration 050's `uq_ce_reviewer_item_origin` is a single 5-column unique
constraint spanning both nullable `record_id` and `cluster_id`. Postgres
treats NULL as distinct from NULL in uniqueness checks, so two rows sharing
`(project_id, reviewer_id, origin)` with both `cluster_id IS NULL` never
collide on that column alone — the constraint does not actually prevent a
second human (or AI) row for the same *record* item. Replace it with two
partial unique indexes, mirroring migration 032's original pattern.

Also implements item 4: `concept_mentions.screening_queue_id` records which
frozen review-order sequence (ScreeningQueue row) a mention's sequence_index
came from, so discovery analysis never treats positions from two different
corpus queues as comparable.

Revision ID: 051
Revises: 050
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "051"
down_revision = "050"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("uq_ce_reviewer_item_origin", "concept_extractions", type_="unique")
    op.create_index(
        "uq_ce_record_reviewer_origin", "concept_extractions",
        ["project_id", "reviewer_id", "record_id", "origin"],
        unique=True, postgresql_where=sa.text("record_id IS NOT NULL"),
    )
    op.create_index(
        "uq_ce_cluster_reviewer_origin", "concept_extractions",
        ["project_id", "reviewer_id", "cluster_id", "origin"],
        unique=True, postgresql_where=sa.text("cluster_id IS NOT NULL"),
    )

    op.add_column(
        "concept_mentions",
        sa.Column(
            "screening_queue_id",
            UUID(as_uuid=True),
            sa.ForeignKey("screening_queues.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_concept_mentions_screening_queue_id", "concept_mentions", ["screening_queue_id"]
    )


def downgrade():
    op.drop_index("ix_concept_mentions_screening_queue_id", table_name="concept_mentions")
    op.drop_column("concept_mentions", "screening_queue_id")

    op.drop_index("uq_ce_cluster_reviewer_origin", table_name="concept_extractions")
    op.drop_index("uq_ce_record_reviewer_origin", table_name="concept_extractions")
    op.create_unique_constraint(
        "uq_ce_reviewer_item_origin",
        "concept_extractions",
        ["project_id", "reviewer_id", "record_id", "cluster_id", "origin"],
    )
