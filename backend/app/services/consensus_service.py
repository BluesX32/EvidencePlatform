"""Consensus and inter-rater reliability service.

Provides:
  - detect_conflicts()     — find items where reviewers disagree at TA or FT stage
  - adjudicate()           — admin submits final consensus decision
  - compute_reliability()  — % agreement + Cohen's kappa per reviewer pair
  - team_screening_stats() — per-reviewer progress breakdown
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Optional

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.consensus_decision import ConsensusDecision
from app.models.screening_decision import ScreeningDecision
from app.models.extraction_record import ExtractionRecord
from app.models.user import User
from app.repositories.team_repo import TeamRepo


# ── Conflict detection ────────────────────────────────────────────────────────

async def detect_conflicts(
    db: AsyncSession,
    project_id: uuid.UUID,
    stage: Optional[str] = None,
    only_unresolved: bool = True,
) -> list[dict]:
    """Return items where ≥2 reviewers disagree at the same stage.

    An item is in conflict when the set of decisions for (project, item, stage)
    contains both 'include' and 'exclude'.
    """
    q = select(
        ScreeningDecision.record_id,
        ScreeningDecision.cluster_id,
        ScreeningDecision.stage,
        ScreeningDecision.decision,
        ScreeningDecision.reviewer_id,
        ScreeningDecision.reason_code,
        ScreeningDecision.notes,
        ScreeningDecision.created_at,
    ).where(ScreeningDecision.project_id == project_id)

    if stage:
        q = q.where(ScreeningDecision.stage == stage)

    rows = await db.execute(q)
    all_decisions = rows.fetchall()

    # Group by (record_id or cluster_id, stage)
    groups: dict = defaultdict(list)
    for row in all_decisions:
        key = (str(row.record_id or row.cluster_id), "record" if row.record_id else "cluster", row.stage)
        groups[key].append({
            "reviewer_id": str(row.reviewer_id) if row.reviewer_id else None,
            "decision": row.decision,
            "reason_code": row.reason_code,
            "notes": row.notes,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        })

    # Find conflicts (both include and exclude in the group, ≥2 decisions)
    conflicts = []
    for (item_id, item_type, item_stage), decisions in groups.items():
        if len(decisions) < 2:
            continue
        decision_set = {d["decision"] for d in decisions}
        if len(decision_set) < 2:
            continue  # unanimous

        # Check if already adjudicated
        if only_unresolved:
            filter_col = ConsensusDecision.record_id if item_type == "record" else ConsensusDecision.cluster_id
            existing = await db.execute(
                select(ConsensusDecision).where(
                    ConsensusDecision.project_id == project_id,
                    filter_col == uuid.UUID(item_id),
                    ConsensusDecision.stage == item_stage,
                )
            )
            if existing.scalar_one_or_none() is not None:
                continue

        conflicts.append({
            "item_id": item_id,
            "item_type": item_type,
            "record_id": item_id if item_type == "record" else None,
            "cluster_id": item_id if item_type == "cluster" else None,
            "stage": item_stage,
            "decisions": decisions,
            "conflict_type": "include_vs_exclude",
        })

    return conflicts


# ── Adjudication ──────────────────────────────────────────────────────────────

async def adjudicate(
    db: AsyncSession,
    project_id: uuid.UUID,
    record_id: Optional[uuid.UUID],
    cluster_id: Optional[uuid.UUID],
    stage: str,
    decision: str,
    adjudicator_id: uuid.UUID,
    reason_code: Optional[str] = None,
    notes: Optional[str] = None,
) -> ConsensusDecision:
    """Create or overwrite a consensus decision for a conflicted item."""
    # Delete existing consensus decision if any
    filter_col = ConsensusDecision.record_id if record_id else ConsensusDecision.cluster_id
    item_id = record_id or cluster_id

    existing_row = await db.execute(
        select(ConsensusDecision).where(
            ConsensusDecision.project_id == project_id,
            filter_col == item_id,
            ConsensusDecision.stage == stage,
        )
    )
    existing = existing_row.scalar_one_or_none()
    if existing:
        existing.decision = decision
        existing.adjudicator_id = adjudicator_id
        existing.reason_code = reason_code
        existing.notes = notes
        await db.flush()
        await db.refresh(existing)
        return existing

    consensus = ConsensusDecision(
        project_id=project_id,
        record_id=record_id,
        cluster_id=cluster_id,
        stage=stage,
        decision=decision,
        adjudicator_id=adjudicator_id,
        reason_code=reason_code,
        notes=notes,
    )
    db.add(consensus)
    await db.flush()
    await db.refresh(consensus)
    return consensus


# ── Inter-rater reliability ───────────────────────────────────────────────────

def _cohen_kappa(agreements: int, total: int, p_expected: float) -> float:
    """Cohen's kappa from raw counts.

    kappa = (p_observed - p_expected) / (1 - p_expected)
    """
    if total == 0 or (1 - p_expected) == 0:
        return 1.0
    p_obs = agreements / total
    return (p_obs - p_expected) / (1 - p_expected)


async def compute_reliability(
    db: AsyncSession,
    project_id: uuid.UUID,
    stage: Optional[str] = None,
) -> dict:
    """Return per-pair and overall inter-rater reliability stats.

    For each pair of reviewers that both screened any item at the given stage,
    compute:
      - n_items_both   — number of items both screened
      - n_agree        — number where they made the same decision
      - pct_agreement  — n_agree / n_items_both
      - kappa          — Cohen's kappa
    """
    q = select(
        ScreeningDecision.record_id,
        ScreeningDecision.cluster_id,
        ScreeningDecision.stage,
        ScreeningDecision.decision,
        ScreeningDecision.reviewer_id,
    ).where(
        ScreeningDecision.project_id == project_id,
        ScreeningDecision.reviewer_id.isnot(None),
    )
    if stage:
        q = q.where(ScreeningDecision.stage == stage)

    rows = await db.execute(q)
    all_decisions = rows.fetchall()

    # Group decisions by item+stage → {reviewer_id: decision}
    item_decisions: dict = defaultdict(dict)
    for row in all_decisions:
        item_key = (str(row.record_id or row.cluster_id), row.stage)
        item_decisions[item_key][str(row.reviewer_id)] = row.decision

    # Collect per-reviewer-pair stats
    pair_stats: dict = defaultdict(lambda: {"agree": 0, "total": 0, "include_a": 0, "include_b": 0})
    for item_key, rev_map in item_decisions.items():
        reviewers = sorted(rev_map.keys())
        for i in range(len(reviewers)):
            for j in range(i + 1, len(reviewers)):
                r_a, r_b = reviewers[i], reviewers[j]
                pair_key = (r_a, r_b)
                pair_stats[pair_key]["total"] += 1
                da, db_ = rev_map[r_a], rev_map[r_b]
                if da == db_:
                    pair_stats[pair_key]["agree"] += 1
                if da == "include":
                    pair_stats[pair_key]["include_a"] += 1
                if db_ == "include":
                    pair_stats[pair_key]["include_b"] += 1

    # Fetch reviewer user info
    all_reviewer_ids = set()
    for ra, rb in pair_stats.keys():
        all_reviewer_ids.add(uuid.UUID(ra))
        all_reviewer_ids.add(uuid.UUID(rb))

    reviewer_names: dict[str, str] = {}
    if all_reviewer_ids:
        user_rows = await db.execute(
            select(User.id, User.name, User.email).where(User.id.in_(all_reviewer_ids))
        )
        for uid, name, email in user_rows:
            reviewer_names[str(uid)] = name or email

    pairs = []
    total_agree = total_items = 0
    for (ra, rb), stats in pair_stats.items():
        n = stats["total"]
        a = stats["agree"]
        # Expected agreement by chance (for kappa)
        p_a_include = stats["include_a"] / n if n > 0 else 0.5
        p_b_include = stats["include_b"] / n if n > 0 else 0.5
        p_expected = (p_a_include * p_b_include) + ((1 - p_a_include) * (1 - p_b_include))
        kappa = _cohen_kappa(a, n, p_expected)

        pairs.append({
            "reviewer_a": {"id": ra, "name": reviewer_names.get(ra, ra)},
            "reviewer_b": {"id": rb, "name": reviewer_names.get(rb, rb)},
            "n_items_both": n,
            "n_agree": a,
            "pct_agreement": round(a / n * 100, 1) if n > 0 else None,
            "kappa": round(kappa, 3),
            "kappa_label": _kappa_label(kappa),
        })
        total_agree += a
        total_items += n

    overall_pct = round(total_agree / total_items * 100, 1) if total_items > 0 else None

    return {
        "stage": stage or "all",
        "pairs": pairs,
        "overall_pct_agreement": overall_pct,
        "n_pairs": len(pairs),
    }


def _kappa_label(k: float) -> str:
    if k < 0:
        return "poor"
    if k < 0.20:
        return "slight"
    if k < 0.40:
        return "fair"
    if k < 0.60:
        return "moderate"
    if k < 0.80:
        return "substantial"
    return "almost perfect"


# ── Team screening stats ──────────────────────────────────────────────────────

async def team_screening_stats(
    db: AsyncSession,
    project_id: uuid.UUID,
) -> list[dict]:
    """Per-reviewer screening progress across TA and FT stages."""
    rows = await db.execute(
        select(
            ScreeningDecision.reviewer_id,
            ScreeningDecision.stage,
            ScreeningDecision.decision,
            func.count().label("n"),
        )
        .where(
            ScreeningDecision.project_id == project_id,
            ScreeningDecision.reviewer_id.isnot(None),
        )
        .group_by(ScreeningDecision.reviewer_id, ScreeningDecision.stage, ScreeningDecision.decision)
    )
    all_rows = rows.fetchall()

    # Fetch extraction counts per reviewer
    ext_rows = await db.execute(
        select(ExtractionRecord.reviewer_id, func.count().label("n"))
        .where(
            ExtractionRecord.project_id == project_id,
            ExtractionRecord.reviewer_id.isnot(None),
        )
        .group_by(ExtractionRecord.reviewer_id)
    )
    extraction_counts = {str(r.reviewer_id): r.n for r in ext_rows.fetchall()}

    # Group by reviewer
    per_reviewer: dict = defaultdict(lambda: {
        "ta_include": 0, "ta_exclude": 0,
        "ft_include": 0, "ft_exclude": 0,
        "extractions": 0,
    })
    for row in all_rows:
        rid = str(row.reviewer_id)
        key = f"{row.stage.lower()}_{row.decision}"
        per_reviewer[rid][key] = row.n

    for rid in per_reviewer:
        per_reviewer[rid]["extractions"] = extraction_counts.get(rid, 0)

    # Attach names
    reviewer_ids = [uuid.UUID(r) for r in per_reviewer.keys()]
    user_rows = await db.execute(
        select(User.id, User.name, User.email).where(User.id.in_(reviewer_ids))
    ) if reviewer_ids else None

    names = {}
    if user_rows:
        for uid, name, email in user_rows:
            names[str(uid)] = name or email

    result = []
    for rid, stats in per_reviewer.items():
        ta_total = stats["ta_include"] + stats["ta_exclude"]
        ft_total = stats["ft_include"] + stats["ft_exclude"]
        result.append({
            "reviewer_id": rid,
            "name": names.get(rid, rid),
            "ta_screened": ta_total,
            "ta_included": stats["ta_include"],
            "ta_excluded": stats["ta_exclude"],
            "ft_screened": ft_total,
            "ft_included": stats["ft_include"],
            "ft_excluded": stats["ft_exclude"],
            "extractions": stats["extractions"],
        })

    result.sort(key=lambda r: r["ta_screened"] + r["ft_screened"], reverse=True)
    return result