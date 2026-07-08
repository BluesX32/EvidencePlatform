"""SQLAlchemy model for concept_events (migration 050).

Append-only transformation ledger for the concept pipeline, generalizing the
thematic_history pattern (app.models.thematic_history): every row snapshots
enough state (prior_state/resulting_state) to reconstruct an action even
after the row it describes has been renamed or deleted (e.g. a merged
concept_taxonomy_node). Only 'merge' and 'map_ontology' are written today;
the rest of the action vocabulary is reserved for future CRUD instrumentation
of concept_taxonomy.py so it doesn't require another migration.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ConceptEvent(Base):
    __tablename__ = "concept_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False)
    mention_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("concept_mentions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    taxonomy_node_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("concept_taxonomy_nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    ontology_node_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ontology_nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    mapping_type: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    prior_state: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    resulting_state: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    actor_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 'human' | 'ai'
    actor_origin: Mapped[str] = mapped_column(String(12), nullable=False, server_default="human")
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "action IN ('create','accept','reject','map','unmap','merge','split',"
            "'rename','reparent','retype','relabel','map_ontology','unmap_ontology')",
            name="chk_cev_action",
        ),
        CheckConstraint(
            "entity_type IN ('mention','taxonomy_node','ontology_mapping')",
            name="chk_cev_entity_type",
        ),
        CheckConstraint("actor_origin IN ('human', 'ai')", name="chk_cev_actor_origin"),
        Index("ix_concept_events_project_created", "project_id", "created_at"),
    )
