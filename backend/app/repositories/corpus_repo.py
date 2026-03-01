"""
Corpus repository.

Handles CRUD for Corpus rows and the saturation counter update.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.corpus import Corpus


class CorpusRepo:

    @staticmethod
    async def create(
        db: AsyncSession,
        project_id: uuid.UUID,
        name: str,
        description: Optional[str],
        source_ids: List[uuid.UUID],
        saturation_threshold: int,
    ) -> Corpus:
        corpus = Corpus(
            project_id=project_id,
            name=name,
            description=description,
            source_ids=source_ids,
            saturation_threshold=saturation_threshold,
        )
        db.add(corpus)
        await db.flush()
        await db.refresh(corpus)
        return corpus

    @staticmethod
    async def get(
        db: AsyncSession, corpus_id: uuid.UUID
    ) -> Optional[Corpus]:
        return await db.get(Corpus, corpus_id)

    @staticmethod
    async def list_for_project(
        db: AsyncSession, project_id: uuid.UUID
    ) -> List[Corpus]:
        result = await db.execute(
            select(Corpus)
            .where(Corpus.project_id == project_id)
            .order_by(Corpus.created_at)
        )
        return list(result.scalars().all())

    @staticmethod
    async def update_queue_meta(
        db: AsyncSession,
        corpus: Corpus,
        queue_size: int,
        seed: int,
    ) -> None:
        corpus.queue_size = queue_size
        corpus.queue_seed = seed
        corpus.queue_generated_at = datetime.now(tz=timezone.utc)
        await db.flush()

    @staticmethod
    async def update_saturation(
        db: AsyncSession,
        corpus: Corpus,
        novelty_flag: bool,
    ) -> None:
        """Increment counters and fire stopped_at when threshold is reached."""
        corpus.total_extracted += 1
        if novelty_flag:
            corpus.consecutive_no_novelty = 0
        else:
            corpus.consecutive_no_novelty += 1
        if (
            corpus.stopped_at is None
            and corpus.consecutive_no_novelty >= corpus.saturation_threshold
        ):
            corpus.stopped_at = datetime.now(tz=timezone.utc)
        await db.flush()
