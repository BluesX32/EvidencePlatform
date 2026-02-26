import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy import ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MatchStrategy(Base):
    __tablename__ = "match_strategies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # preset: doi_first_strict | doi_first_medium | strict | medium | loose
    # (used for backward-compat with existing strategies; new strategies store
    #  all config in the `config` JSONB and set preset='custom')
    preset: Mapped[str] = mapped_column(String(50), nullable=False)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    # Ordered list of field names used by this strategy's rules
    # e.g. ["doi", "pmid", "title", "year", "author"]
    # Null for legacy preset-based strategies.
    selected_fields: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True, default=None)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
