"""Add source_record_ids UUID[] to citation_candidates for multi-source tracking.

When the same paper is referenced by multiple extracted papers (or manually tagged
to different source articles), it previously stored only the first source encountered.
The new source_record_ids array accumulates all sources, enabling accurate filtering
by source article and correct attribution for manual imports and cluster-based sources.

Revision ID: 031
Revises: 030
"""
from alembic import op

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE citation_candidates "
        "ADD COLUMN source_record_ids UUID[] NOT NULL DEFAULT '{}'"
    )
    # Backfill: copy existing single source_record_id into the new array
    op.execute(
        "UPDATE citation_candidates "
        "SET source_record_ids = ARRAY[source_record_id]::UUID[] "
        "WHERE source_record_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE citation_candidates DROP COLUMN source_record_ids")
