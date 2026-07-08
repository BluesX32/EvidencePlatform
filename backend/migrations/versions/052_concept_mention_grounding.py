"""Human passage-grounding curation: status, actor, timestamp.

The AI concept-extraction path (P0-core hardening pass) populates
concept_mentions.source_quote/locator, but historical human concepts —
including the disease-severity case study's — were only article-linked,
with no supporting quotation. Adds a tri-state grounding_status
('verified' | 'unverified' | 'unavailable') plus who/when attached it, so
human curation (via a new endpoint or the structured CSV import workflow)
is itself provenance-tracked, not just the mention's current quote/locator.

Also extends the concept_events action vocabulary with 'ground' so
attaching/correcting grounding is an auditable, actor/timestamped ledger
entry — consistent with merge/map/unmap/rename/reparent/map_ontology.

Revision ID: 052
Revises: 051
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "052"
down_revision = "051"
branch_labels = None
depends_on = None

_OLD_ACTIONS = (
    "'create','accept','reject','map','unmap','merge','split',"
    "'rename','reparent','retype','relabel','map_ontology','unmap_ontology'"
)
_NEW_ACTIONS = (
    "'create','accept','reject','map','unmap','merge','split',"
    "'rename','reparent','retype','relabel','map_ontology','unmap_ontology','ground'"
)


def upgrade():
    op.add_column(
        "concept_mentions",
        sa.Column("grounding_status", sa.String(12), nullable=False, server_default="unavailable"),
    )
    op.create_check_constraint(
        "chk_cm_grounding_status", "concept_mentions",
        "grounding_status IN ('verified', 'unverified', 'unavailable')",
    )
    op.add_column(
        "concept_mentions",
        sa.Column(
            "grounded_by", UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.add_column(
        "concept_mentions",
        sa.Column("grounded_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Existing AI-grounded mentions already satisfy "verified" semantics
    # (their quote was substring-validated against the source text).
    op.execute(
        "UPDATE concept_mentions SET grounding_status = 'verified' "
        "WHERE source_quote IS NOT NULL AND (locator->>'grounded')::boolean IS TRUE"
    )

    op.drop_constraint("chk_cev_action", "concept_events", type_="check")
    op.create_check_constraint(
        "chk_cev_action", "concept_events", f"action IN ({_NEW_ACTIONS})",
    )


def downgrade():
    op.drop_constraint("chk_cev_action", "concept_events", type_="check")
    op.create_check_constraint(
        "chk_cev_action", "concept_events", f"action IN ({_OLD_ACTIONS})",
    )

    op.drop_column("concept_mentions", "grounded_at")
    op.drop_column("concept_mentions", "grounded_by")
    op.drop_constraint("chk_cm_grounding_status", "concept_mentions", type_="check")
    op.drop_column("concept_mentions", "grounding_status")
