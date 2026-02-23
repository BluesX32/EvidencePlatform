# Vertical Slice 3 — Flexible Dedup / Identity Matching

**Status**: Implemented
**Date**: 2026-02-23
**Depends on**: Vertical Slice 2 (multi-source import, overlap, DOI-based dedup)

---

## Motivation

Vertical Slice 2 hardcodes deduplication to DOI (`normalized_doi`). This is insufficient for
systematic review workflows:

- Many records lack DOIs (grey literature, preprints, conference abstracts)
- PubMed and Scopus sometimes format the same DOI differently
- Different databases have different coverage of DOI metadata

EndNote, Covidence, and Rayyan all support configurable matching rules (title+author+year,
title+year, etc.). This slice adds a flexible, re-runnable, auditable dedup system.

---

## Key Design Decisions

### D1: Strategy-agnostic `match_key` on `records`

Replaces the DOI-specific partial unique index with a general one:

| Strategy | match_key format |
|----------|-----------------|
| DOI (any doi_first_* preset) | `doi:{normalized_doi}` |
| Title + Author + Year | `tay:{norm_title}\|{norm_author}\|{year}` |
| Title + Year | `ty:{norm_title}\|{year}` |
| Title + Author | `ta:{norm_title}\|{norm_author}` |
| No matchable fields | `NULL` → isolated row, never merged |

The old `normalized_doi` column is **kept** for audit purposes. `match_key` is the active cluster key.

### D2: Precomputed norm fields on `record_sources`

At import time, compute and store:
- `norm_title TEXT` — normalized title (lowercased, punctuation stripped, stop words removed)
- `norm_first_author TEXT` — normalized last name of first author
- `match_year INT` — publication year
- `match_doi TEXT` — normalized DOI (`doi.lower().strip()`)

These never mutate after insert. Any future re-dedup job reads them without re-parsing `raw_data`.

### D3: Dedup decoupled from import

Import stores raw records and runs an immediate lightweight dedup (using the active strategy's
preset) so the records list is immediately usable. A separate dedup job re-clusters all records
with any strategy on demand.

### D4: Cluster re-assignment via UPDATE, not delete+recreate

A dedup job re-points `record_sources.record_id` to the correct canonical record. Canonical
`records` rows with 0 members after re-assignment are deleted. New canonical rows are created
for newly-formed clusters. Re-running the same strategy is idempotent.

### D5: Overlap query is unchanged

The pairwise overlap self-join on `record_sources.record_id` already reflects whatever clustering
is active. No query changes needed; overlap updates automatically when a dedup job completes.

---

## Schema Changes (Migration 003)

### `records` — new columns

```sql
ALTER TABLE records
  ADD COLUMN match_key   TEXT,        -- computed cluster key (NULL = no dedup)
  ADD COLUMN match_basis VARCHAR(50); -- 'doi' | 'title_author_year' | 'title_year' | 'title_author' | 'none'

DROP INDEX uq_records_project_normalized_doi;
CREATE UNIQUE INDEX uq_records_project_match_key
  ON records (project_id, match_key) WHERE match_key IS NOT NULL;
```

### `record_sources` — new columns

```sql
ALTER TABLE record_sources
  ADD COLUMN norm_title        TEXT,
  ADD COLUMN norm_first_author TEXT,
  ADD COLUMN match_year        INTEGER,
  ADD COLUMN match_doi         TEXT;

CREATE INDEX ix_rs_match_doi ON record_sources (match_doi) WHERE match_doi IS NOT NULL;
```

### New table: `match_strategies`

```sql
CREATE TABLE match_strategies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  preset      VARCHAR(50)  NOT NULL,
  -- presets: doi_first_strict | doi_first_medium | strict | medium | loose
  config      JSONB        NOT NULL DEFAULT '{}',
  is_active   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
```

A default `doi_first_strict` strategy (`is_active = TRUE`) is seeded for every existing project
at migration time.

### New table: `dedup_jobs`

```sql
CREATE TABLE dedup_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  strategy_id      UUID NOT NULL REFERENCES match_strategies(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending | running | completed | failed
  records_before   INT,
  records_after    INT,
  merges           INT,
  clusters_created INT,
  clusters_deleted INT,
  error_msg        TEXT,
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
```

### New table: `match_log` (audit trail)

```sql
CREATE TABLE match_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_job_id   UUID NOT NULL REFERENCES dedup_jobs(id) ON DELETE CASCADE,
  record_src_id  UUID NOT NULL REFERENCES record_sources(id),
  old_record_id  UUID REFERENCES records(id) ON DELETE SET NULL,
  new_record_id  UUID NOT NULL REFERENCES records(id),
  match_key      TEXT,
  match_basis    VARCHAR(50),
  action         VARCHAR(20) NOT NULL, -- unchanged | merged | split | created
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Critical**: `old_record_id` uses `ON DELETE SET NULL` (not the default `NO ACTION`) so that
deleting newly-orphaned canonical records does not violate this FK constraint.

---

## Normalization Rules

Implemented in `app/utils/match_keys.py`.

### Title normalization

1. Unicode NFC
2. Lowercase
3. Strip punctuation (`re.sub(r"[^\w\s]", " ", text)`)
4. Remove English stop words (hardcoded compact set: `a, an, the, of, in, on, at, for, by, and, or, with, to, from, is, are, was, were`)
5. Collapse whitespace, strip
6. Truncate to 200 characters
7. Return `None` if empty after processing

**Example**:
Input: `"Effectiveness of mindfulness-based stress reduction on depression: a systematic review"`
Output: `"effectiveness mindfulness based stress reduction depression systematic review"`

### First-author normalization

1. Take first element of authors list
2. Extract last name: everything before first comma, or last whitespace-delimited token if no comma
3. Lowercase, strip non-alpha characters (preserves compound surnames: `"van den Berg"`)

**Examples**: `"Smith, John A"` → `"smith"`, `"van den Berg, C"` → `"van den berg"`

### Match key computation

```python
def compute_match_key(norm_title, norm_first_author, year, doi, preset) -> tuple[str|None, str]:
    doi_key = f"doi:{doi}" if doi else None

    if preset in ("doi_first_strict", "doi_first_medium"):
        if doi_key:
            return doi_key, "doi"
        if preset == "doi_first_strict":
            if norm_title and norm_first_author and year:
                return f"tay:{norm_title}|{norm_first_author}|{year}", "title_author_year"
        else:  # doi_first_medium
            if norm_title and year:
                return f"ty:{norm_title}|{year}", "title_year"
        return None, "none"

    if preset == "strict":
        if norm_title and norm_first_author and year:
            return f"tay:{norm_title}|{norm_first_author}|{year}", "title_author_year"
        return None, "none"

    if preset == "medium":
        if norm_title and year:
            return f"ty:{norm_title}|{year}", "title_year"
        return None, "none"

    if preset == "loose":
        if norm_title and norm_first_author:
            return f"ta:{norm_title}|{norm_first_author}", "title_author"
        return None, "none"

    return None, "none"
```

---

## Advisory Lock (Concurrency Safety)

**`app/services/locks.py`**

Import and dedup jobs both write to `records` and `record_sources`. Running two jobs concurrently
for the same project would cause race conditions on cluster key lookups. A PostgreSQL session-level
advisory lock serializes these operations.

### Lock key derivation

```python
def derive_project_lock_key(project_id: uuid.UUID) -> int:
    return project_id.int & 0x7FFFFFFFFFFFFFFF
```

Both services use the same derivation, so they share the same lock namespace.

### Session-level lock management

Advisory locks are **session-level** — they survive `COMMIT` within the critical section.
The lock must be held on a **dedicated `AsyncConnection`** that is never returned to the pool
while the lock is held:

```python
async with engine.connect() as lock_conn:
    acquired = await try_acquire_project_lock(lock_conn, project_id)
    if not acquired:
        raise HTTPException(status_code=409, ...)
    try:
        # business logic uses a separate SessionLocal()
        async with SessionLocal() as db:
            ...
    finally:
        await release_project_lock(lock_conn, project_id)
```

### Where applied

| Service | Locked section |
|---------|---------------|
| `ImportService.process_import()` | Around `RecordRepo.upsert_and_link()` (file parsing is outside the lock) |
| `DedupService.run_dedup()` | Entire clustering + re-assignment loop |

### 409 conflict response

```json
{
  "error": "project_locked",
  "message": "Another job is already running for this project. Try again when it completes."
}
```

---

## Dedup Job Algorithm

**`app/services/dedup_service.py` → `_run_clustering()`**

```
1. Mark dedup_job status = 'running'
2. Load strategy preset
3. Count records_before = SELECT COUNT(*) FROM records WHERE project_id = ...
4. Fetch all record_sources for project (with norm fields)
5. For each record_source, compute (match_key, match_basis) from precomputed fields
6. Group record_sources by match_key:
     - match_key = None  → isolated, never merged
     - match_key = X     → all sources with key X form one cluster
7. For each cluster:
     a. SELECT id FROM records WHERE project_id=... AND match_key=X
     b. If none: INSERT new canonical record (best-source bib fields)
     c. UPDATE record_sources SET record_id = cluster.id WHERE id IN (cluster member ids)
8. Write match_log for every record_source (BEFORE orphan deletion)
9. DELETE FROM records WHERE id NOT IN (SELECT DISTINCT record_id FROM record_sources)
10. Count records_after, update dedup_job stats, mark completed
11. Set strategy is_active = TRUE; deactivate all others for this project
```

**Idempotency**: Step 7a checks for an existing cluster before creating a new one. Re-running
the same strategy on already-clustered data yields identical results (all actions = `unchanged`).

**Best-source selection** for canonical bib fields:
1. Source record with a DOI (most citable)
2. Source record with the most non-null bib fields
3. Earliest import (most established)

---

## Import Pipeline Changes

`RecordRepo.upsert_and_link()` now:

1. Computes `norm_title`, `norm_first_author`, `match_year`, `match_doi` for each parsed record
2. Calls `compute_match_key()` with the project's active strategy preset
3. Stores norm fields in `record_sources` at insert time
4. Upserts `records` using `ON CONFLICT (project_id, match_key) WHERE match_key IS NOT NULL`

Records with `match_key = NULL` (missing required fields) are inserted individually — each
gets its own isolated canonical row.

---

## API Endpoints

### Match Strategies

```
GET  /projects/{id}/strategies
     → list[MatchStrategy]

POST /projects/{id}/strategies
     Body: { name: str, preset: str }
     → 201 MatchStrategy
     → 422 if preset not in valid set
     → 409 on duplicate name

GET  /projects/{id}/strategies/active
     → MatchStrategy | null
```

### Dedup Jobs

```
POST /projects/{id}/dedup-jobs
     Body: { strategy_id: UUID }
     → 202 { dedup_job_id: UUID, status: "pending" }
     → 409 if import or dedup job already running

GET  /projects/{id}/dedup-jobs
     → list[DedupJob]

GET  /projects/{id}/dedup-jobs/{job_id}
     → DedupJob (with nested strategy: { id, name, preset })
```

### Records (updated)

- `GET /projects/{id}/records` response: `RecordItem` now includes `match_basis: string | null`

### Overlap (updated)

- `GET /projects/{id}/overlap` response: `OverlapSummary` now includes `strategy_name: string | null`

---

## Frontend Changes

### ProjectPage

- **Dedup section** below the Sources section:
  - Active strategy chip ("Active: DOI + Strict fallback")
  - 5 preset radio buttons with plain-English descriptions
  - "Save and activate" to create a new strategy with the selected preset
  - "Run deduplication" button → POST `/dedup-jobs`
  - Last run summary: "1,200 records → 980 canonical (220 merged)"
  - Auto-polls while a job is pending/running

### RecordsTable

- **Dedup column** with a colored `MatchBasisBadge` per record:
  - `doi` → blue badge
  - `title_author_year` / `title_year` / `title_author` → green badge
  - `none` → gray badge ("No match")

### OverlapPage

- Header: "Overlap computed with: {strategy_name}"
- Yellow warning banner when the active strategy differs from the strategy used in the last
  completed dedup run ("Strategy changed since last dedup run. Re-run deduplication on the
  Project page to update overlap.")

---

## Test Coverage

| File | Tests | Description |
|------|-------|-------------|
| `tests/test_match_keys.py` | 28 | Unit tests for `normalize_title`, `normalize_first_author`, `compute_match_key` across all 5 presets |
| `tests/test_dedup_service.py` | 6 | Integration tests: merge same DOI, idempotency, strategy switch updates clusters, null-key isolation, match_log written, job status |
| `tests/test_overlap.py` | updated | Split `test_no_doi_records_not_deduplicated` into two tests reflecting new behavior |

All 64 tests pass.

---

## Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Selecting a new preset and running dedup re-assigns clusters and updates overlap immediately | ✓ |
| 2 | Re-running the same strategy is idempotent (0 changes on second run) | ✓ |
| 3 | Same DOI from 2 sources → 1 canonical record under all doi_first_* presets | ✓ |
| 4 | No-DOI records with matching title+author+year → merged under strict/doi_first_strict | ✓ |
| 5 | No-DOI records with missing title/year → not merged (match_key=NULL, isolated row) | ✓ |
| 6 | match_log records before/after cluster for every changed record_source | ✓ |
| 7 | Switching strict → medium merges records with same title+year but different authors | ✓ |
| 8 | All raw source data (record_sources.raw_data) is unchanged by dedup job | ✓ |
| 9 | Overlap query automatically reflects new clustering without changes | ✓ |
| 10 | Dedup job completes in < 30s for 10k records | (not load tested) |

---

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/versions/003_flexible_dedup.py` | New migration |
| `backend/app/utils/__init__.py` | New (package marker) |
| `backend/app/utils/match_keys.py` | New — normalization + key computation |
| `backend/app/models/match_strategy.py` | New |
| `backend/app/models/dedup_job.py` | New |
| `backend/app/models/match_log.py` | New |
| `backend/app/models/record.py` | Added match_key, match_basis columns |
| `backend/app/models/record_source.py` | Added norm fields columns |
| `backend/app/models/__init__.py` | Export new models |
| `backend/app/repositories/strategy_repo.py` | New |
| `backend/app/repositories/dedup_repo.py` | New |
| `backend/app/repositories/import_repo.py` | Added get_running() |
| `backend/app/repositories/record_repo.py` | Strategy-aware upsert with norm fields |
| `backend/app/repositories/overlap_repo.py` | Added active_strategy_name() |
| `backend/app/services/locks.py` | New — advisory lock helpers |
| `backend/app/services/dedup_service.py` | New — full clustering algorithm |
| `backend/app/services/import_service.py` | Advisory lock + strategy-aware preset |
| `backend/app/routers/strategies.py` | New — POST/GET strategies |
| `backend/app/routers/dedup_jobs.py` | New — POST/GET dedup jobs |
| `backend/app/routers/records.py` | match_basis in RecordItem, strategy_name in OverlapSummary |
| `backend/app/main.py` | Register new routers |
| `frontend/src/api/client.ts` | New types + API methods |
| `frontend/src/pages/ProjectPage.tsx` | Dedup section |
| `frontend/src/components/RecordsTable.tsx` | MatchBasisBadge + Dedup column |
| `frontend/src/pages/OverlapPage.tsx` | Strategy label + stale warning |
| `backend/tests/test_match_keys.py` | New — 28 unit tests |
| `backend/tests/test_dedup_service.py` | New — 6 integration tests |
| `backend/tests/test_overlap.py` | Updated for new dedup behavior |

---

## Known Limitations and Future Work

- **No manual override UI**: The dedup engine is fully algorithmic. A future slice could add
  a UI to manually merge/split pairs that the algorithm gets wrong.
- **No similarity matching**: All matching is exact on normalized strings. A future preset could
  use token Jaccard similarity or edit distance for fuzzy title matching.
- **`match_log` not exposed in UI**: The audit trail exists in the database but is not yet
  surfaced in the frontend.
- **No progress reporting**: Long-running dedup jobs (100k+ records) report status as
  `running` with no percentage. A future slice could add a `progress` column.
- **Load testing**: Criterion 10 (< 30s for 10k records) was not measured. The algorithm
  operates in memory after a single full-table fetch, so performance should be acceptable,
  but this should be verified before production use.
