"""Fix citation_candidate dedup indexes to be direction-aware.

Previously the unique indexes were (search_id, doi/pmid/s2_paper_id), which prevented
the same paper from appearing as both a backward reference AND a forward citation.
Now the indexes include direction so each (direction, identifier) pair is unique within
a search — the same paper can be a separate candidate for each direction.

Revision ID: 030
Revises: 029
"""
from alembic import op

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop old direction-unaware indexes
    op.execute("DROP INDEX IF EXISTS ix_cc_search_doi")
    op.execute("DROP INDEX IF EXISTS ix_cc_search_pmid")
    op.execute("DROP INDEX IF EXISTS ix_cc_search_s2")

    # Recreate with direction included
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_doi  "
        "ON citation_candidates(search_id, direction, doi)        WHERE doi        IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_pmid "
        "ON citation_candidates(search_id, direction, pmid)       WHERE pmid       IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_s2   "
        "ON citation_candidates(search_id, direction, s2_paper_id) WHERE s2_paper_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_cc_search_doi")
    op.execute("DROP INDEX IF EXISTS ix_cc_search_pmid")
    op.execute("DROP INDEX IF EXISTS ix_cc_search_s2")

    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_doi  "
        "ON citation_candidates(search_id, doi)        WHERE doi        IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_pmid "
        "ON citation_candidates(search_id, pmid)       WHERE pmid       IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX ix_cc_search_s2   "
        "ON citation_candidates(search_id, s2_paper_id) WHERE s2_paper_id IS NOT NULL"
    )
