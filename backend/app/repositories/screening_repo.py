"""
Screening repository.

Handles queue items, decisions, borderline cases, extractions,
and second reviews for a corpus.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.corpus_borderline_case import CorpusBorderlineCase
from app.models.corpus_decision import CorpusDecision
from app.models.corpus_extraction import CorpusExtraction
from app.models.corpus_queue_item import CorpusQueueItem
from app.models.corpus_second_review import CorpusSecondReview


class ScreeningRepo:

    # ------------------------------------------------------------------
    # Queue
    # ------------------------------------------------------------------

    @staticmethod
    async def delete_queue(db: AsyncSession, corpus_id: uuid.UUID) -> None:
        await db.execute(
            delete(CorpusQueueItem).where(CorpusQueueItem.corpus_id == corpus_id)
        )

    @staticmethod
    async def insert_queue_items(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        canonical_keys: List[str],
    ) -> None:
        """Insert queue items in order (order_index = position in list)."""
        items = [
            CorpusQueueItem(
                corpus_id=corpus_id,
                canonical_key=key,
                order_index=idx,
            )
            for idx, key in enumerate(canonical_keys)
        ]
        db.add_all(items)
        await db.flush()

    @staticmethod
    async def get_queue_page(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        offset: int,
        limit: int,
    ) -> List[CorpusQueueItem]:
        result = await db.execute(
            select(CorpusQueueItem)
            .where(CorpusQueueItem.corpus_id == corpus_id)
            .order_by(CorpusQueueItem.order_index)
            .offset(offset)
            .limit(limit)
        )
        return list(result.scalars().all())

    @staticmethod
    async def count_queue(db: AsyncSession, corpus_id: uuid.UUID) -> int:
        from sqlalchemy import func
        result = await db.execute(
            select(func.count()).where(CorpusQueueItem.corpus_id == corpus_id)
        )
        return result.scalar_one()

    @staticmethod
    async def get_next_undecided(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        decided_keys: set,
    ) -> Optional[CorpusQueueItem]:
        """Return the lowest-order-index queue item not yet decided at TA stage."""
        result = await db.execute(
            select(CorpusQueueItem)
            .where(CorpusQueueItem.corpus_id == corpus_id)
            .order_by(CorpusQueueItem.order_index)
        )
        for item in result.scalars().all():
            if item.canonical_key not in decided_keys:
                return item
        return None

    # ------------------------------------------------------------------
    # Decisions
    # ------------------------------------------------------------------

    @staticmethod
    async def insert_decision(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        canonical_key: str,
        stage: str,
        decision: str,
        reason_code: Optional[str],
        notes: Optional[str],
        reviewer_id: Optional[uuid.UUID],
    ) -> CorpusDecision:
        row = CorpusDecision(
            corpus_id=corpus_id,
            canonical_key=canonical_key,
            stage=stage,
            decision=decision,
            reason_code=reason_code,
            notes=notes,
            reviewer_id=reviewer_id,
        )
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return row

    @staticmethod
    async def get_decided_keys(
        db: AsyncSession, corpus_id: uuid.UUID, stage: str
    ) -> set:
        """Return set of canonical_keys that have a non-borderline decision for stage."""
        result = await db.execute(
            select(CorpusDecision.canonical_key)
            .where(
                CorpusDecision.corpus_id == corpus_id,
                CorpusDecision.stage == stage,
                CorpusDecision.decision.in_(["include", "exclude"]),
            )
        )
        return set(result.scalars().all())

    @staticmethod
    async def list_decisions(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        stage: Optional[str] = None,
        canonical_key: Optional[str] = None,
    ) -> List[CorpusDecision]:
        stmt = select(CorpusDecision).where(CorpusDecision.corpus_id == corpus_id)
        if stage:
            stmt = stmt.where(CorpusDecision.stage == stage)
        if canonical_key:
            stmt = stmt.where(CorpusDecision.canonical_key == canonical_key)
        stmt = stmt.order_by(CorpusDecision.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def list_included_keys(
        db: AsyncSession, corpus_id: uuid.UUID, stage: str
    ) -> List[str]:
        """Return canonical_keys that have been included at the given stage."""
        result = await db.execute(
            select(CorpusDecision.canonical_key)
            .where(
                CorpusDecision.corpus_id == corpus_id,
                CorpusDecision.stage == stage,
                CorpusDecision.decision == "include",
            )
            .distinct()
        )
        return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Borderline cases
    # ------------------------------------------------------------------

    @staticmethod
    async def insert_borderline(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        canonical_key: str,
        stage: str,
    ) -> CorpusBorderlineCase:
        row = CorpusBorderlineCase(
            corpus_id=corpus_id,
            canonical_key=canonical_key,
            stage=stage,
        )
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return row

    @staticmethod
    async def get_borderline(
        db: AsyncSession, case_id: uuid.UUID
    ) -> Optional[CorpusBorderlineCase]:
        return await db.get(CorpusBorderlineCase, case_id)

    @staticmethod
    async def resolve_borderline(
        db: AsyncSession,
        case: CorpusBorderlineCase,
        resolution_decision: str,
        resolution_notes: Optional[str],
        resolved_by: Optional[uuid.UUID],
    ) -> CorpusBorderlineCase:
        case.status = "resolved"
        case.resolution_decision = resolution_decision
        case.resolution_notes = resolution_notes
        case.resolved_by = resolved_by
        case.resolved_at = datetime.now(tz=timezone.utc)
        await db.flush()
        await db.refresh(case)
        return case

    @staticmethod
    async def list_borderline(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        status: Optional[str] = None,
    ) -> List[CorpusBorderlineCase]:
        stmt = select(CorpusBorderlineCase).where(
            CorpusBorderlineCase.corpus_id == corpus_id
        )
        if status:
            stmt = stmt.where(CorpusBorderlineCase.status == status)
        stmt = stmt.order_by(CorpusBorderlineCase.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Extractions
    # ------------------------------------------------------------------

    @staticmethod
    async def upsert_extraction(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        canonical_key: str,
        extracted_json: dict,
        novelty_flag: bool,
        novelty_notes: Optional[str],
        reviewer_id: Optional[uuid.UUID],
    ) -> CorpusExtraction:
        """Insert or update extraction (UNIQUE on corpus_id + canonical_key)."""
        # Try existing
        result = await db.execute(
            select(CorpusExtraction).where(
                CorpusExtraction.corpus_id == corpus_id,
                CorpusExtraction.canonical_key == canonical_key,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.extracted_json = extracted_json
            existing.novelty_flag = novelty_flag
            existing.novelty_notes = novelty_notes
            existing.reviewer_id = reviewer_id
            await db.flush()
            await db.refresh(existing)
            return existing
        row = CorpusExtraction(
            corpus_id=corpus_id,
            canonical_key=canonical_key,
            extracted_json=extracted_json,
            novelty_flag=novelty_flag,
            novelty_notes=novelty_notes,
            reviewer_id=reviewer_id,
        )
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return row

    @staticmethod
    async def list_extractions(
        db: AsyncSession, corpus_id: uuid.UUID
    ) -> List[CorpusExtraction]:
        result = await db.execute(
            select(CorpusExtraction)
            .where(CorpusExtraction.corpus_id == corpus_id)
            .order_by(CorpusExtraction.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_extracted_keys(
        db: AsyncSession, corpus_id: uuid.UUID
    ) -> set:
        result = await db.execute(
            select(CorpusExtraction.canonical_key).where(
                CorpusExtraction.corpus_id == corpus_id
            )
        )
        return set(result.scalars().all())

    # ------------------------------------------------------------------
    # Second reviews
    # ------------------------------------------------------------------

    @staticmethod
    async def insert_second_review(
        db: AsyncSession,
        corpus_id: uuid.UUID,
        canonical_key: str,
        stage: str,
        agree: bool,
        notes: Optional[str],
        reviewer_id: Optional[uuid.UUID],
    ) -> CorpusSecondReview:
        row = CorpusSecondReview(
            corpus_id=corpus_id,
            canonical_key=canonical_key,
            stage=stage,
            agree=agree,
            notes=notes,
            reviewer_id=reviewer_id,
        )
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return row
