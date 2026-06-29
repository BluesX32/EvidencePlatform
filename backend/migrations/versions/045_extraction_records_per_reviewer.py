"""Add reviewer_id to extraction_records unique indexes so each reviewer has an
independent row per paper. Previously the unique constraint was on
(project_id, record_id) and (project_id, cluster_id) with no reviewer column,
which meant only one reviewer's extraction could exist per paper.

Revision ID: 045
Revises: 044
"""
from alembic import op

revision = "045"
down_revision = "044"
branch_labels = None
depends_on = None


def upgrade():
    # Drop any pre-existing single-reviewer unique indexes (name may vary by environment)
    op.execute("DROP INDEX IF EXISTS uq_er_record")
    op.execute("DROP INDEX IF EXISTS uq_er_cluster")
    # Also drop any constraint-backed unique indexes the ORM may have created
    op.execute("""
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT indexname FROM pg_indexes
             WHERE tablename = 'extraction_records'
               AND indexname NOT IN ('uq_er_record_reviewer', 'uq_er_cluster_reviewer')
               AND (indexdef ILIKE '%record_id%' OR indexdef ILIKE '%cluster_id%')
               AND indexdef ILIKE '%unique%'
          LOOP
            EXECUTE 'DROP INDEX IF EXISTS ' || quote_ident(r.indexname);
          END LOOP;
        END $$
    """)

    # Recreate with reviewer_id so every reviewer gets their own independent row
    op.execute("""
        CREATE UNIQUE INDEX uq_er_record_reviewer
          ON extraction_records (project_id, record_id, reviewer_id)
         WHERE record_id IS NOT NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_er_cluster_reviewer
          ON extraction_records (project_id, cluster_id, reviewer_id)
         WHERE cluster_id IS NOT NULL
    """)


def downgrade():
    op.drop_index("uq_er_record_reviewer",  table_name="extraction_records")
    op.drop_index("uq_er_cluster_reviewer", table_name="extraction_records")

    op.execute("""
        CREATE UNIQUE INDEX uq_er_record
          ON extraction_records (project_id, record_id)
         WHERE record_id IS NOT NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_er_cluster
          ON extraction_records (project_id, cluster_id)
         WHERE cluster_id IS NOT NULL
    """)
