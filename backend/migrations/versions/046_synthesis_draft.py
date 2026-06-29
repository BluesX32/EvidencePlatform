"""Add synthesis_draft JSONB column to projects for AI-generated reports.

Revision ID: 046
Revises: 045
"""
from alembic import op
import sqlalchemy as sa

revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("projects", sa.Column("synthesis_draft", sa.Text, nullable=True))


def downgrade():
    op.drop_column("projects", "synthesis_draft")
