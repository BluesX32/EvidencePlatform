# Hardening Sprint 1 (HS1) — Design Document

**Status:** Complete
**Scope:** Stability and polish for Slices 1–3. No new user-facing feature surfaces.
**Preceded by:** Vertical Slice 3 (multi-strategy dedup, match audit log)

---

## Motivation

Code-review and exploratory testing of Slices 1–3 revealed five categories of
correctness, UX, and stability gaps that would cause problems in a real systematic review
workflow. None of the gaps are new feature requests — they are bugs and UX dead-ends in
code that was already claimed to be working:

| # | Area | Symptom |
|---|------|---------|
| B1 | Project counters | `record_count` always 0 (AttributeError in query) |
| B2 | Project counters | `import_count` counts all jobs, not just completed ones |
| B3 | Strategy activation | No way to activate a strategy; dedup always ran with old strategy |
| B4/B5 | Source navigation | Source chips were inert `<span>` elements; URL param ignored |
| B6 | Rich metadata | `abstract`, `keywords`, `issn` stored in DB but never returned by API |

---

## Epics

### E1 — Fix Project Page Counters

**Root cause:** `project_repo.count_records()` queried `RecordSource.project_id` but
`RecordSource` has no `project_id` column (removed in Migration 002 when the table became
a pure join table). This raised `AttributeError` at runtime → 500 → frontend default 0.

Additionally, `import_count` used `len(all_jobs)` which counted every job regardless
of status.

**Fixes:**
- `project_repo.py:count_records()`: now queries `records` table directly
  (`SELECT COUNT(*) FROM records WHERE project_id = ?`), returning canonical record count.
- `import_repo.py`: new `count_completed(db, project_id) -> int` counts only
  `status='completed'` import jobs.
- `routers/projects.py`: `ProjectDetail` now includes `failed_import_count` as a
  supplementary field; uses `count_completed` for `import_count`.
- Frontend `ProjectPage.tsx`: shows corrected counters with semantic tooltips.

**Acceptance criteria (verified):**
1. `record_count` = canonical records in `records` table (not `record_sources` rows).
2. `import_count` = jobs with `status='completed'` only.
3. `failed_import_count` displayed in red when > 0.

---

### E2 — Source-Click Navigation

**Root cause:** Source chips in `ProjectPage` were `<span>` elements. `RecordsPage`
never read `source_id` from URL params even though the backend already supported it.

**Fixes:**
- `ProjectPage.tsx`: source chips changed to `<Link to="…?source_id=…">`.
- `RecordsPage.tsx`: reads `source_id` from URL search params; passes it to
  `recordsApi.list`; fetches source name for badge display.
- Filter badge: shows "Filtered by: **{sourceName}** ✕" when active; ✕ removes
  the filter and resets to page 1.
- `OverlapPage.tsx`: source rows in per-source totals table are now clickable links
  to the filtered records view.

**Acceptance criteria (verified):**
1. Clicking a source chip navigates to RecordsPage with source filter active.
2. Filter badge shows source name; ✕ clears it.
3. All three source navigation entry points work: ProjectPage chips, OverlapPage rows,
   and direct URL.
4. Pagination and search both respect the active source filter.

---

### E3 — Import Robustness & 100 MB Support

**Root cause:** Three independent issues:
1. Hard 50 MB limit blocked large exports (Embase/OVID exports routinely exceed 50 MB).
2. `.txt` extension not accepted even though many vendors export RIS as `.txt`.
3. Advisory lock failure produced no actionable message; unhandled exceptions in the
   background task could in theory leave jobs stuck in "processing".

**Fixes:**
- `routers/imports.py`: `_MAX_FILE_SIZE` raised to 100 MB; `.txt` added to
  `_SUPPORTED_FORMATS`; error message updated.
- `services/import_service.py`: top-level `process_import` wrapped in
  `try/except BaseException` as a last-resort safety net; inner `_run_import` function
  extracted; lock failure message made actionable ("Please wait and retry"); empty file
  → `set_failed` with "No valid records found" message.
- `ImportPage.tsx`: client-side validation updated to 100 MB and `.ris/.txt`; file
  input `accept` attribute updated; UI copy updated.

**Known limitation:** The entire file is read into memory before processing. At 100 MB,
peak memory is ~200 MB (bytes + decoded string). Acceptable for research-scale use;
streaming can be deferred to a future sprint.

**Acceptance criteria (verified):**
1. `_MAX_FILE_SIZE` constant is 100 MB.
2. `.txt` and `.ris` are both in `_SUPPORTED_FORMATS`.
3. Lock failure message contains "Please wait and retry".
4. `process_import` catches `BaseException`.
5. Valid RIS content in `.txt` bytes parses correctly.

---

### E4 — Rich Metadata Display

**Root cause:** `abstract`, `keywords`, `issn` columns populated at import time but
omitted from the `list_paginated` SELECT and the `RecordItem` API response. No per-record
detail view or column picker existed.

**Fixes:**
- `record_repo.py:list_paginated`: added `Record.abstract`, `Record.keywords`,
  `Record.issn` to SELECT and GROUP BY.
- `routers/records.py:RecordItem`: added `abstract: Optional[str]`,
  `keywords: Optional[List[str]]`, `issn: Optional[str]` fields and `from_orm` mapping.
- `api/client.ts:RecordItem`: updated TypeScript interface with the three new fields.
- `RecordsTable.tsx`: full rewrite —
  - Exported `ColumnVisibility` interface and `DEFAULT_COLUMNS`.
  - `ExpandedRow` component: full abstract (scrollable, max-height), full authors list
    when >1 author, keywords, ISSN, match basis.
  - Row click toggles expansion via `expandedId` state.
  - DOI cell uses `stopPropagation` to avoid toggling row on link click.
  - Column picker button + inline checkbox panel for optional columns.
- `RecordsPage.tsx`: manages `columns` state initialized from `localStorage`
  (keyed by `{projectId}-columns`); passes `columns` and `onColumnsChange` to
  `RecordsTable`; preferences persist across page reloads.

**Schema changes:** None. All three columns already existed in Migration 001.

**Acceptance criteria (verified):**
1. `GET /projects/{id}/records` response includes `abstract`, `keywords`, `issn`.
2. Clicking a record row shows full abstract and full author list.
3. Column picker toggles optional columns; preferences persist on reload.

---

### E5 — Dedup Strategy Builder End-to-End

**Root cause:** `POST /projects/{id}/strategies` created strategies with `is_active=False`
and there was no endpoint to activate one. The only activation path was completing a dedup
job — which requires an active strategy. This circular dependency meant the UI's "Save and
run" flow always ran dedup with the *old* strategy.

**Fixes:**
- `routers/strategies.py`: added `activate: bool = False` field to `StrategyCreate`
  model; calls `StrategyRepo.set_active()` immediately after creation when `activate=True`.
- `routers/strategies.py`: new `PATCH /{strategy_id}/activate` endpoint — sets one
  strategy active and deactivates all others for the project.
- `api/client.ts`: `strategiesApi.create` now accepts `activate` boolean param;
  `strategiesApi.activate(projectId, strategyId)` added.
- `ProjectPage.tsx`: `createStrategy` mutation passes `activate=true`; "Save & activate"
  button label; after create, both `["strategies", id]` and `["strategies-active", id]`
  query caches invalidated; after dedup run, `["project", id]` cache invalidated.

**Acceptance criteria (verified):**
1. `POST /strategies` with `activate=true` → strategy is immediately active.
2. `PATCH /strategies/{id}/activate` deactivates all other strategies.
3. Frontend "Save & activate" uses `activate=true`.
4. Query cache invalidation ensures UI reflects new active strategy without reload.

---

## Test Coverage

24 new tests added across three files:

| File | Tests | Coverage area |
|------|-------|---------------|
| `test_project_counters.py` | 6 | E1: `count_records`, `count_completed`, `failed_import_count` |
| `test_strategies.py` | 7 | E5: `create`, `set_active`, `get_active`, idempotency |
| `test_import_robustness.py` | 11 | E3: file-size constant, format map, parser behavior, service source inspection |

All 64 pre-existing tests continue to pass (88 total, 100% pass rate).

---

## File Change Summary

### Backend

| File | Change |
|------|--------|
| `app/repositories/project_repo.py` | Fixed `count_records()` to query `records` not `record_sources` |
| `app/repositories/import_repo.py` | Added `count_completed()` |
| `app/routers/projects.py` | Added `failed_import_count` to `ProjectDetail`; use `count_completed` |
| `app/repositories/record_repo.py` | Added `abstract`, `issn`, `keywords` to `list_paginated` SELECT/GROUP BY |
| `app/routers/records.py` | Added three fields to `RecordItem` Pydantic model |
| `app/routers/strategies.py` | Added `activate` flag to create; added PATCH activate endpoint |
| `app/routers/imports.py` | 100 MB limit; `.txt` support |
| `app/services/import_service.py` | `BaseException` guard; actionable lock error; extracted `_run_import` |

### Frontend

| File | Change |
|------|--------|
| `src/api/client.ts` | `ProjectDetail.failed_import_count`; `RecordItem` three new fields; `strategiesApi.activate`; `strategiesApi.create` activate param |
| `src/pages/ProjectPage.tsx` | Counter tooltips; source chips → links; strategy activate flow; dedup cache invalidation |
| `src/pages/RecordsPage.tsx` | Source filter from URL; filter badge with dismiss; column state + localStorage |
| `src/pages/OverlapPage.tsx` | Source rows → links to filtered records |
| `src/pages/ImportPage.tsx` | 100 MB; `.ris`/`.txt` accept; UI copy |
| `src/components/RecordsTable.tsx` | Expandable rows; column picker; ColumnVisibility export |

### Tests

| File | Added |
|------|-------|
| `tests/test_project_counters.py` | 6 new tests |
| `tests/test_strategies.py` | 7 new tests |
| `tests/test_import_robustness.py` | 11 new tests |

---

## Schema Changes

None. All columns used in this sprint (`abstract`, `keywords`, `issn`) already existed
in the `records` table from Migration 001. No new migrations required.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `.txt` files that are not RIS are silently accepted | rispy raises `ParseError` → caught as `ValueError` → job marked failed with "Cannot parse file as RIS" |
| Memory spike at 100 MB | ~200 MB peak (bytes + string). Documented as known limitation; acceptable at research scale |
| Strategy activation race condition | Both UPDATEs in one DB transaction; PostgreSQL row-level locking prevents interleaving |
| `source_id` filter URL param not validated against project | Backend `list_paginated` does source-scoped subquery; invalid UUID returns 0 records, not an error |
| `localStorage` column preferences conflict between projects | Key is `{projectId}-columns`; preferences are project-specific |

---

## Definition of Done

- [x] **E1**: `record_count` = canonical records; `import_count` = completed jobs only. Integration-tested.
- [x] **E1**: `failed_import_count` shown in UI when > 0.
- [x] **E2**: Source chips navigate to filtered records. Filter badge dismissible. Three entry points work.
- [x] **E3**: 100 MB limit; `.txt` accepted; BaseException guard; actionable lock message.
- [x] **E4**: `abstract`/`keywords`/`issn` in API response. Expandable row UI. Column picker persists.
- [x] **E5**: `activate=true` on create works. PATCH activate endpoint works. Frontend "Save & activate" correct.
- [x] **Tests**: 24 new tests; 88 total; 100% pass rate.
- [x] **No regressions**: All 64 pre-existing tests still pass.
