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
    # Drop the old single-reviewer unique constraints
    op.drop_index("uq_er_record",   table_name="extraction_records")
    op.drop_index("uq_er_cluster",  table_name="extraction_records")

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
