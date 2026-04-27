from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ConceptTaxonomyNode(Base):
    """Curated concept node — stores user-defined hierarchy and merge groups.

    A node represents one canonical concept value within a project template
    field. Its `aliases` list holds other raw extracted values that have been
    merged into this canonical name.  `parent_id` (self-referential) supports
    arbitrary depth parent-child trees.
    """

    __tablename__ = "concept_taxonomy_nodes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    field_id: Mapped[str] = mapped_column(Text, nullable=False)
    field_type: Mapped[str] = mapped_column(Text, nullable=False)
    parent_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concept_taxonomy_nodes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    aliases: Mapped[List[str]] = mapped_column(
        JSONB, nullable=False, default=list
    )
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", "field_id", "name", name="uq_ctn_project_field_name"),
    )
