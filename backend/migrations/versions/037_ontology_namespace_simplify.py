"""Simplify ontology_nodes namespace vocabulary to entity | relationship.

All existing namespaces except 'relationships'/'relationship' → 'entity'.
'relationships' → 'relationship' (rename to singular, consistent with the UI).
Also updates server_default to 'entity'.

Revision ID: 037
Revises: 036
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "037"
down_revision: Union[str, None] = "036"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rename 'relationships' → 'relationship' first
    op.execute(
        "UPDATE ontology_nodes SET namespace = 'relationship' WHERE namespace IN ('relationships', 'relationship')"
    )
    # Collapse everything else into 'entity'
    op.execute(
        "UPDATE ontology_nodes SET namespace = 'entity' WHERE namespace NOT IN ('relationship')"
    )
    # Update column default
    op.alter_column("ontology_nodes", "namespace", server_default="entity")


def downgrade() -> None:
    # Best-effort: restore 'entity' to 'level' (original default), relationship → 'relationships'
    op.execute(
        "UPDATE ontology_nodes SET namespace = 'relationships' WHERE namespace = 'relationship'"
    )
    op.execute(
        "UPDATE ontology_nodes SET namespace = 'level' WHERE namespace = 'entity'"
    )
    op.alter_column("ontology_nodes", "namespace", server_default="concept")
