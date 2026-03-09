"""SQLAlchemy model for ontology_nodes (hierarchical taxonomy, migration 014)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class OntologyNode(Base):
    """A named concept in a project-scoped taxonomy tree.

    Nodes form a forest (multiple root nodes) via self-referential parent_id.
    Deleting a parent promotes its children to the grandparent (SET NULL).
    """

    __tablename__ = "ontology_nodes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    parent_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ontology_nodes.id", ondelete="SET NULL"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Grouping namespace: level | dimension | concept | population | intervention | outcome
    namespace: Mapped[str] = mapped_column(
        String(50), nullable=False, server_default="concept"
    )
    color: Mapped[Optional[str]] = mapped_column(
        String(7), nullable=True, comment="Optional hex color #RRGGBB"
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", "parent_id", "name", name="uq_ontology_sibling_name"),
    )
