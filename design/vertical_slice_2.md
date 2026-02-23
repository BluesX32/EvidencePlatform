# Vertical Slice 2: Multi-Source Import and Overlap Analysis

## Goal

A researcher can tag each RIS import with a named bibliographic source (e.g., "PubMed",
"Scopus"), and then see how many canonical records are shared across databases —
deterministic, no fuzzy matching, no duplicate rows in the records table.

---

## User journey

1. Open project → see source list (empty on first visit)
2. Add source: type "PubMed" → click Add
3. Import RIS → select "PubMed" from dropdown → upload file
4. Add source "Scopus" → import another RIS with source "Scopus"
5. Navigate to Overlap → see:
   - PubMed: 1 200 records (1 150 with DOI)
   - Scopus:  980 records (920 with DOI)
   - PubMed ∩ Scopus: 340 shared records

---

## Scope

### In this slice
- `sources` table and CRUD (create, list) scoped per project
- `source_id` on `import_jobs`
- `records` rebuilt: canonical table with all bibliographic fields + `normalized_doi`
- `record_sources` rebuilt: join table `(record_id, source_id)` — no duplicate records
- Import pipeline: upsert into `records` on `normalized_doi`, then insert join row
- `GET /projects/{id}/overlap` → per-source totals + pairwise shared-record counts
- Frontend: inline source management, source dropdown in ImportPage, OverlapPage
- Records list: one row per canonical record; `sources` field aggregates source names

### Out of scope
- Source edit / delete
- Fuzzy / title-based dedup (Slice 3, uses `dedup_pairs` stub)
- Records without a DOI are not deduplicated (no reliable merge key)
- Multi-user roles, protocols, screening

---

## Data model — migration 002

### New table: `sources`

```sql
CREATE TABLE sources (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        VARCHAR(200) NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_source_name UNIQUE (project_id, name)
);
CREATE INDEX ix_sources_project_id ON sources(project_id);
```

### `import_jobs` — add column

```sql
ALTER TABLE import_jobs
    ADD COLUMN source_id UUID REFERENCES sources(id) ON DELETE SET NULL;
```

### `records` — rebuild (incompatible schema change)

The 001 stub (`primary_source_id`, `metadata JSONB`) is dropped and recreated with all
bibliographic columns and a canonical DOI uniqueness constraint.

```
id              UUID PK
project_id      UUID FK projects(id) ON DELETE CASCADE
normalized_doi  TEXT                 -- lower(trim(doi)); NULL when no DOI
title           TEXT
abstract        TEXT
authors         TEXT[]
year            INTEGER
journal         TEXT
volume          TEXT
issue           TEXT
pages           TEXT
doi             TEXT                 -- original un-normalized DOI
issn            TEXT
keywords        TEXT[]
source_format   TEXT                 -- from first import
created_at      TIMESTAMPTZ

UNIQUE (project_id, normalized_doi) WHERE normalized_doi IS NOT NULL
```

Records without a DOI are never merged — each no-DOI row is a distinct canonical record.

### `record_sources` — rebuild as join table

The 001 raw-data store is replaced by a true membership join table.

```
id            UUID PK
record_id     UUID FK records(id)    ON DELETE CASCADE
source_id     UUID FK sources(id)    ON DELETE CASCADE
import_job_id UUID FK import_jobs(id)
raw_data      JSONB NOT NULL         -- raw parsed fields from this source's file
created_at    TIMESTAMPTZ

UNIQUE (record_id, source_id)        -- one membership per (record, source) pair
```

`project_id` is not stored here; it is accessible via `records.project_id`.

### Migration strategy

Because `records` and `record_sources` are completely reshaped and there is no production
data, migration 002 drops and recreates them:

```
Drop (FK dependency order):
  extracted_data → screening_decisions → dedup_pairs → records
  record_sources (safe once records is gone; import_jobs FK is SET NULL)

Recreate:
  sources
  records         (new schema)
  record_sources  (join table)
  dedup_pairs     (stub updated: source_a_id/source_b_id → record_sources.id)
  screening_decisions  (stub unchanged)
  extracted_data       (stub unchanged)
```

---

## Backend — step by step

### Step 1: Alembic migration 002

`backend/migrations/versions/002_multi_source.py`

Apply all DDL above. Downgrade recreates the 001 stubs and removes 002 additions.

### Step 2: SQLAlchemy models

**New** `backend/app/models/source.py`:
```python
class Source(Base):
    __tablename__ = "sources"
    id         = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    name       = mapped_column(String(200), nullable=False)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
```

**Rewrite** `backend/app/models/record_source.py` — keep `id`, `import_job_id`,
`raw_data`, `created_at`; add `record_id` and `source_id`; remove all bib columns.

**Move** `Record` out of `future.py` into its own `backend/app/models/record.py` with
all bib columns and `normalized_doi`. Update `future.py` accordingly.
`DeduPair.source_a_id/source_b_id` remain FKs to `record_sources.id`.

Update `backend/app/models/__init__.py` to export `Source` and `Record`.

### Step 3: Source repository

`backend/app/repositories/source_repo.py`

- `create(db, project_id, name) → Source` — propagate `IntegrityError` on duplicate name
- `list_by_project(db, project_id) → list[Source]`
- `get_by_id(db, project_id, source_id) → Source | None`

### Step 4: Sources router

`backend/app/routers/sources.py`

```
POST /projects/{project_id}/sources    → 201  {id, name, created_at}
GET  /projects/{project_id}/sources    → 200  [{id, name, created_at}]
```

Auth: `current_user` required; 403 if not project owner; 409 on duplicate name.
Register in `main.py`.

### Step 5: Modify imports router

`POST /projects/{project_id}/imports` gains a required form field:

```
source_id: UUID
```

Before creating the job:
1. `SourceRepo.get_by_id(project_id, source_id)` → 404 if missing or wrong project
2. Pass `source_id` to `ImportRepo.create()`

`ImportJobResponse` gains `source_id: UUID | None`.

### Step 6: Modify import service

`process_import(job_id, project_id, source_id, file_bytes)`

For each parsed record dict, compute:

```python
normalized_doi = doi.lower().strip() if doi else None
```

**Phase A — upsert canonical record:**
```sql
INSERT INTO records (project_id, normalized_doi, title, abstract, authors,
                     year, journal, volume, issue, pages, doi, issn,
                     keywords, source_format)
VALUES (...)
ON CONFLICT (project_id, normalized_doi)
WHERE normalized_doi IS NOT NULL
DO NOTHING
RETURNING id
```
If `RETURNING` is empty (conflict fired), SELECT the existing `id`:
```sql
SELECT id FROM records
WHERE project_id = :project_id AND normalized_doi = :normalized_doi
```
Records with `normalized_doi IS NULL` always INSERT (no conflict possible).

**Phase B — insert join row:**
```sql
INSERT INTO record_sources (record_id, source_id, import_job_id, raw_data)
VALUES (...)
ON CONFLICT (record_id, source_id) DO NOTHING
```

`import_jobs.record_count` = number of `record_sources` rows actually inserted
(new source memberships — the count meaningful to the researcher).

### Step 7: Overlap repository

`backend/app/repositories/overlap_repo.py`

**Per-source totals:**
```sql
SELECT s.id, s.name,
       COUNT(rs.record_id)     AS total,
       COUNT(r.normalized_doi) AS with_doi
FROM sources s
LEFT JOIN record_sources rs ON rs.source_id = s.id
LEFT JOIN records r         ON r.id = rs.record_id
WHERE s.project_id = :project_id
GROUP BY s.id, s.name
ORDER BY s.name;
```

**Pairwise overlap — shared canonical records:**
```sql
SELECT rs_a.source_id AS source_a_id, s_a.name AS source_a_name,
       rs_b.source_id AS source_b_id, s_b.name AS source_b_name,
       COUNT(*)        AS shared_records
FROM record_sources rs_a
JOIN record_sources rs_b
    ON  rs_a.record_id = rs_b.record_id   -- same canonical record
    AND rs_a.source_id < rs_b.source_id   -- avoid symmetric duplicates
JOIN sources s_a ON s_a.id = rs_a.source_id
JOIN sources s_b ON s_b.id = rs_b.source_id
JOIN records r   ON r.id   = rs_a.record_id
WHERE r.project_id = :project_id
GROUP BY rs_a.source_id, s_a.name,
         rs_b.source_id, s_b.name
ORDER BY shared_records DESC;
```

No DOI string comparison at query time — matching happened at insert.

### Step 8: Overlap endpoint

`GET /projects/{project_id}/overlap`

Response:
```json
{
  "sources": [
    {"id": "...", "name": "PubMed", "total": 1200, "with_doi": 1150},
    {"id": "...", "name": "Scopus", "total":  980, "with_doi":  920}
  ],
  "pairs": [
    {"source_a_id": "...", "source_a_name": "PubMed",
     "source_b_id": "...", "source_b_name": "Scopus",
     "shared_records": 340}
  ]
}
```

Returns `{"sources": [], "pairs": []}` when no sources exist yet.

### Step 9: Update records list

`RecordRepo.list_paginated` now queries `records` and aggregates source names:

```sql
SELECT r.id, r.title, r.authors, r.year, r.journal, r.doi,
       ARRAY_AGG(s.name ORDER BY s.name)
           FILTER (WHERE s.name IS NOT NULL) AS sources
FROM records r
LEFT JOIN record_sources rs ON rs.record_id = r.id
LEFT JOIN sources s         ON s.id = rs.source_id
WHERE r.project_id = :project_id
  [AND (r.title ILIKE :q OR array_to_string(r.authors,' ') ILIKE :q)]
  [AND rs.source_id = :source_id]   -- optional filter param
GROUP BY r.id, r.title, r.authors, r.year, r.journal, r.doi
ORDER BY r.year DESC NULLS LAST;
```

`RecordItem` type changes:
- Remove: `source_format`, `import_job_id`, `source_id`
- Add: `sources: list[str]` (e.g. `["PubMed", "Scopus"]`)

---

## Frontend — step by step

### Step 10: API client updates

`src/api/client.ts` additions:

```typescript
export interface Source { id: string; name: string; created_at: string; }

export interface OverlapSource {
  id: string; name: string; total: number; with_doi: number;
}
export interface OverlapPair {
  source_a_id: string; source_a_name: string;
  source_b_id: string; source_b_name: string;
  shared_records: number;
}
export interface OverlapSummary { sources: OverlapSource[]; pairs: OverlapPair[]; }

export const sourcesApi = {
  list:   (projectId: string) =>
    api.get<Source[]>(`/projects/${projectId}/sources`),
  create: (projectId: string, name: string) =>
    api.post<Source>(`/projects/${projectId}/sources`, { name }),
};
```

`RecordItem` gains `sources: string[]`; remove `source_id`, `import_job_id`, `source_format`.

`importsApi.start` gains `sourceId: string` form field.

`recordsApi` gains `overlap(projectId)` → `GET /projects/{projectId}/overlap`.

### Step 11: ProjectPage — inline source management

Below the stats block, "Sources" section:

- List existing sources as name chips
- Inline form: text input + "Add" button; on submit call `sourcesApi.create`,
  invalidate `["sources", id]`; on 409 show "Source already exists"
- count < 2: muted hint "Add sources from multiple databases to enable overlap"
- count ≥ 2: "View overlap →" link to `/projects/:id/overlap`

### Step 12: ImportPage — source dropdown

Above the upload zone:

```
Source *
[ PubMed ▾ ]
```

- Fetch sources via `sourcesApi.list`
- Empty list: "No sources yet — add one on the project page"; Import button disabled
- `sourceId` required; passed as form field to `importsApi.start`

### Step 13: OverlapPage

New file: `src/pages/OverlapPage.tsx`
Route: `/projects/:id/overlap`

```
← Project                        [View records]

Source overview
┌──────────────┬─────────┬────────────┐
│ Source       │ Records │ With DOI   │
├──────────────┼─────────┼────────────┤
│ PubMed       │ 1 200   │ 1 150      │
│ Scopus       │   980   │   920      │
└──────────────┴─────────┴────────────┘

Pairwise overlap
┌──────────────┬──────────────┬────────────────┐
│ Source A     │ Source B     │ Shared records │
├──────────────┼──────────────┼────────────────┤
│ PubMed       │ Scopus       │ 340            │
└──────────────┴──────────────┴────────────────┘

Note: Records without a DOI are excluded from overlap counts.
```

Empty state (< 2 sources): "Import from at least 2 sources to see overlap."

Add route to `App.tsx`:
```tsx
<Route path="/projects/:id/overlap"
       element={<RequireAuth><OverlapPage /></RequireAuth>} />
```

---

## Architecture notes

**Dedup at write, not read.**
Once a canonical record exists for `(project_id, normalized_doi)`, every subsequent
import of the same DOI — from any source — resolves to that row. The records list
contains no duplicates by construction; no `DISTINCT ON` or post-query filtering needed.

**`raw_data` lives in the join table.**
Each `(record, source)` membership row stores the raw parsed representation from that
source's file. If PubMed and Scopus describe the same article differently, both
representations are preserved without creating duplicate canonical records.

**Overlap requires no DOI matching at query time.**
The pairwise query is a self-join on `record_id`. Correctness is guaranteed by the
insert-time dedup, not by string comparison.

**Records without DOI are not deduplicated.**
No-DOI records each get their own canonical row. Title-based fuzzy merging (Slice 3)
will populate `dedup_pairs` to surface likely duplicates for human review.

**Idempotency:**
- Same DOI, same source, re-imported → 0 new rows in both `records` and `record_sources`
- Same DOI, new source → `records` unchanged; 1 new `record_sources` join row added
- `import_jobs.record_count` = new source memberships added in this import

---

## Done criteria

- [ ] `POST /projects/{id}/sources` creates a source; duplicate name → 409
- [ ] Import requires `source_id`; missing or wrong-project source → 404
- [ ] Same DOI from two sources → 1 `records` row, 2 `record_sources` rows
- [ ] Same DOI, same source, re-imported → 0 new rows (fully idempotent)
- [ ] Records list shows each canonical record once; `sources` lists all source names
- [ ] Overlap pairs count shared canonical records, not DOI strings
- [ ] OverlapPage renders correctly for 0, 1, and 2+ sources
- [ ] All Slice 1 tests still pass

---

## Implementation order

```
1.  Migration 002 — drop/recreate records + record_sources; create sources; alter import_jobs
2.  Source model; rewrite Record and RecordSource ORM models
3.  SourceRepo + router
4.  Import service — upsert records; insert record_sources join row
5.  OverlapRepo + endpoint
6.  RecordRepo.list_paginated — query records, aggregate sources
7.  Frontend: API client
8.  Frontend: ProjectPage source section
9.  Frontend: ImportPage source dropdown
10. Frontend: OverlapPage
11. Tests
```
