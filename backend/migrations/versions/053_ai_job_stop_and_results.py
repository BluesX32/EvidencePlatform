"""AI job stop/resume control + per-job result linkage.

Every AI-batch feature (bulk extraction, bulk concept extraction, bulk
conflict resolution, theme suggestion, draft setup) should support stopping
mid-run and always let the user see what the AI produced. Adds:

  - ai_jobs.stop_requested: cooperative stop flag checked by the running
    loop; combined with an in-memory cancel set (app/routers/ai_pilot.py)
    for immediate effect within the same process.
  - ai_jobs.result_json: persisted output for one-shot jobs (suggest_themes,
    draft_setup) that don't create their own rows elsewhere, so their
    result stays viewable after the request/response cycle ends.
  - ai_job_id on extraction_records, concept_extractions, and
    consensus_decisions: links each row back to the exact batch job that
    created it, so "view AI results" can list precisely what one run did
    (extending the same linkage pattern already used for concept_mentions).

"Resume" itself needs no new column: bulk extraction/concepts/resolve-all
already recompute their remaining-work set each time they start (items
without an existing row / still-unresolved conflicts), so re-invoking the
same start endpoint after a stop naturally continues rather than restarts.

Revision ID: 053
Revises: 052
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "053"
down_revision = "052"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "ai_jobs",
        sa.Column("stop_requested", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.add_column("ai_jobs", sa.Column("result_json", JSONB, nullable=True))

    for table in ("extraction_records", "concept_extractions", "consensus_decisions"):
        op.add_column(
            table,
            sa.Column(
                "ai_job_id", UUID(as_uuid=True),
                sa.ForeignKey("ai_jobs.id", ondelete="SET NULL"), nullable=True,
            ),
        )
        op.create_index(f"ix_{table}_ai_job_id", table, ["ai_job_id"])


def downgrade():
    for table in ("extraction_records", "concept_extractions", "consensus_decisions"):
        op.drop_index(f"ix_{table}_ai_job_id", table_name=table)
        op.drop_column(table, "ai_job_id")

    op.drop_column("ai_jobs", "result_json")
    op.drop_column("ai_jobs", "stop_requested")
