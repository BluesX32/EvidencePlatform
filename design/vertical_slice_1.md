# Vertical Slice 1 — Project Creation and Literature Import

> The first complete, useful thing a researcher can do with EvidencePlatform.
> This slice establishes every architectural pattern the rest of the system builds on.

---

## Purpose

A vertical slice is the thinnest possible path through all layers of the system that produces something genuinely useful. It is not a demo, not a prototype, and not a scaffold — it is production-quality code that will remain in the codebase unchanged.

**The test for this slice:**
A researcher can register, create a project, upload a RIS file exported from PubMed, and see a paginated table of their imported records. The raw source data is preserved without mutation. The import is logged with full provenance.

If that works: Slice 1 is done.

---

## User Journey

```
1. Researcher navigates to the application
2. Registers with email + password + name
3. Logs in, receives a JWT access token
4. Creates a project (name + optional description)
5. Opens the project
6. Uploads a RIS file (drag-and-drop or file picker)
7. Sees an import progress indicator
8. Import completes: sees a paginated table of records
   — title, authors, year, journal, DOI, source format
9. Can search/filter the records table by title or author
```

That is the complete user story for this slice. Nothing more.

---

## Scope

### In This Slice

- User registration and login (email + password, JWT)
- Project creation and project list
- RIS file upload and parsing
- Async import job with status tracking (polling)
- `record_sources` table population — raw imported records, never mutated
- Records table view: paginated, sortable by title/year, searchable by title/author
- Field normalization on import: Unicode normalization, whitespace, basic title cleaning
- Import history: list of past import jobs for a project with record counts and status

### Explicitly Out of This Slice

| Excluded | Why |
|----------|-----|
| BibTeX and PubMed XML parsers | RIS validates the pipeline; other formats follow the same pattern |
| Deduplication | Requires canonical `records` table logic; comes in Slice 2 |
| Protocol creation | Not meaningful until screening begins |
| Project roles and multi-user | Single owner only; roles needed in Phase 2 for two-reviewer screening |
| Refresh tokens / token rotation | Not needed until multi-day session management matters |
| Full record detail view | Records table shows metadata; full view is a later slice |
| Record deletion | Immutability is a principle; source records are never deleted |
| Any LLM feature | Out of scope for all MVP slices |

---

## Data Flow

```
[Browser]
    │  POST multipart/form-data (.ris file)
    ▼
[FastAPI: POST /projects/{id}/imports]
    │  Validate auth + project ownership
    │  Create import_job row (status: pending)
    │  Dispatch background task
    │  Return { import_job_id } — HTTP 202 Accepted
    ▼
[Background Task: ImportService.process()]
    │  Update job status → processing
    │  Read file bytes → RISParser → list of field dicts
    │  Normalize each record (unicode, whitespace)
    │  Bulk insert into record_sources
    │    (skip rows where DOI already exists in project)
    │  Update job: status=completed, record_count=N
    ▼
[Browser polls: GET /projects/{id}/imports/{job_id}]
    │  Stop polling when status = completed | failed
    ▼
[Browser: GET /projects/{id}/records?page=1&q=...]
    │  Paginated query on record_sources by project_id
    ▼
[Records Table rendered in React]
```

---

## Database Schema

This slice creates **all tables** for the full system in a single baseline migration. The schema
must encode the full workflow now — changing foreign key relationships later is expensive.
Tables used in this slice are marked **active**. Others are created but have no API surface yet.

### Active in This Slice

**`users`**
```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
email         TEXT NOT NULL UNIQUE
password_hash TEXT NOT NULL
name          TEXT NOT NULL
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
```

**`projects`**
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
name        TEXT NOT NULL
description TEXT
created_by  UUID NOT NULL REFERENCES users(id)
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

**`import_jobs`**
```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid()
project_id   UUID NOT NULL REFERENCES projects(id)
created_by   UUID NOT NULL REFERENCES users(id)
filename     TEXT NOT NULL
file_format  TEXT NOT NULL      -- 'ris' | 'bibtex' | 'pubmed_xml'
status       TEXT NOT NULL      -- 'pending' | 'processing' | 'completed' | 'failed'
record_count INT
error_msg    TEXT
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
completed_at TIMESTAMPTZ
```

**`record_sources`**
```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
project_id    UUID NOT NULL REFERENCES projects(id)
import_job_id UUID NOT NULL REFERENCES import_jobs(id)
title         TEXT
abstract      TEXT
authors       TEXT[]             -- normalized: ["Last, First", ...]
year          INT
journal       TEXT
volume        TEXT
issue         TEXT
pages         TEXT
doi           TEXT
issn          TEXT
keywords      TEXT[]
source_format TEXT NOT NULL      -- 'ris' | 'bibtex' | 'pubmed_xml'
raw_data      JSONB NOT NULL     -- original parsed fields, verbatim, never mutated
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()

CONSTRAINT unique_doi_per_project UNIQUE (project_id, doi) -- partial, WHERE doi IS NOT NULL
```

**Indexes:**
- `record_sources(project_id)`
- `record_sources(project_id, year DESC)`
- GIN on `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(array_to_string(authors,' '),''))` for full-text search

### Created Now, Active in Later Slices

```sql
-- Slice 2
records           -- canonical deduplicated records derived from record_sources
dedup_pairs       -- deduplication decisions (each logged with rationale)

-- Phase 2
project_members   -- reviewer roles (Admin, Reviewer, Observer)
protocols         -- PICO criteria, immutable versioned JSONB snapshots
screening_decisions -- per-reviewer per-record (never a status field on the record)

-- Phase 3
extraction_forms  -- form definition version-locked to protocol
extracted_data    -- append-only; history is queryable
```

---

## API Contract

All protected routes require `Authorization: Bearer <token>`.

### Auth

**`POST /auth/register`**
```
Body:     { email, password, name }
Response: { user_id, access_token }
Errors:   409 email already registered | 422 validation
```

**`POST /auth/login`**
```
Body:     { email, password }
Response: { access_token }
Errors:   401 invalid credentials
```

### Projects

**`POST /projects`**
```
Body:     { name, description? }
Response: { id, name, description, created_by, created_at }
```

**`GET /projects`**
```
Response: [{ id, name, description, created_at, record_count }]
          Only projects owned by the authenticated user.
```

**`GET /projects/{id}`**
```
Response: { id, name, description, created_by, created_at, record_count, import_count }
Errors:   403 | 404
```

### Imports

**`POST /projects/{id}/imports`** *(multipart/form-data, field name: `file`)*
```
Response: { import_job_id, status: "pending" }   HTTP 202
Errors:   400 unsupported format | 403 not owner | 413 too large (>50 MB)
```

**`GET /projects/{id}/imports/{job_id}`**
```
Response: { id, filename, status, record_count, error_msg, created_at, completed_at }
```

**`GET /projects/{id}/imports`**
```
Response: [{ id, filename, status, record_count, created_at, completed_at }]
          Ordered by created_at DESC.
```

### Records

**`GET /projects/{id}/records`**
```
Query:    page (default 1) | per_page (default 50, max 200)
          q (full-text search on title + authors)
          sort: title_asc | title_desc | year_asc | year_desc  (default: year_desc)

Response: {
            records: [{ id, title, authors, year, journal,
                        volume, issue, pages, doi,
                        source_format, import_job_id, created_at }],
            total, page, per_page, total_pages
          }
```

---

## Frontend Routes and Components

### Routes

| Path | Page | Purpose |
|------|------|---------|
| `/register` | `RegisterPage` | Registration form |
| `/login` | `LoginPage` | Login form |
| `/projects` | `ProjectsPage` | Dashboard — project list |
| `/projects/new` | `NewProjectPage` | Create project form |
| `/projects/:id` | `ProjectPage` | Overview + import history |
| `/projects/:id/import` | `ImportPage` | File upload + progress |
| `/projects/:id/records` | `RecordsPage` | Paginated records table |

### Key Components

**`FileUploadZone`**
Drag-and-drop zone accepting `.ris` files. Client-side extension validation before upload.
Displays filename and file size on selection. On submit, POSTs to the imports endpoint.

**`ImportProgress`**
Polls `GET /projects/{id}/imports/{job_id}` every 1 s. Shows spinner while pending/processing.
On `completed`: shows record count and link to records. On `failed`: shows `error_msg`.
Stops polling on either terminal state.

**`RecordsTable`**
Columns: Title (truncated at 80 chars), Authors (first author + "et al." if >2), Year, Journal, DOI.
Column headers for Title and Year are clickable sort toggles.
Search input debounced 300 ms — updates URL query param → React Query refetch.
Pagination controls below table.

**`ProjectCard`**
Project name, description excerpt, record count, date of last import. Links to `/projects/:id`.

### State

React Query (TanStack Query v5) for all server state. No global store in this slice.
URL search params drive sort, page, and search query — enables shareable filtered views.
JWT stored in `localStorage` under `ep_access_token`. API client attaches it as Bearer token.
On 401 response: clear token, redirect to `/login`.

---

## Architecture Patterns This Slice Establishes

Every pattern introduced here is the template for all future slices.

**1. Layered backend**
```
Router   — HTTP concerns: request parsing, auth injection, response shaping
Service  — business logic, orchestration, no SQL
Repo     — database queries only, no business logic
```
No SQL in services. No business logic in routers. This is the rule for the entire codebase.

**2. Background job + polling**
Long operations dispatch a `BackgroundTask`, return 202 immediately.
The `import_jobs` table is the source of truth for status.
Frontend polls until terminal state. This pattern reuses for dedup pipeline, export generation.

**3. Immutable source records**
`record_sources` has no UPDATE path anywhere in the codebase.
Every transformation (normalization happens at insert time, once) produces new rows elsewhere.

**4. JWT middleware as a single dependency**
`get_current_user: Annotated[User, Depends(...)]` is injected into every protected route.
No ad-hoc token checks anywhere else. Auth enforcement is one function.

**5. Idempotent imports**
The `UNIQUE (project_id, doi) WHERE doi IS NOT NULL` constraint handles re-import at the database level.
No application-level pre-check needed — insert and handle the constraint violation.

**6. Standard pagination contract**
`{ records, total, page, per_page, total_pages }` — every paginated endpoint uses this shape.
Frontend pagination components are built once against this contract.

---

## Project Structure

```
EvidencePlatform/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py          # Settings from environment variables
│   │   ├── database.py        # Async SQLAlchemy engine + session factory
│   │   ├── dependencies.py    # get_current_user, get_db
│   │   ├── models/            # SQLAlchemy ORM models
│   │   ├── routers/           # auth.py, projects.py, imports.py, records.py
│   │   ├── services/          # auth_service.py, import_service.py, record_service.py
│   │   ├── repositories/      # user_repo.py, project_repo.py, import_repo.py, record_repo.py
│   │   └── parsers/
│   │       └── ris.py         # RIS format parser
│   ├── migrations/
│   │   └── versions/
│   │       └── 001_initial_schema.py
│   ├── tests/
│   │   ├── fixtures/sample.ris
│   │   ├── test_ris_parser.py
│   │   └── test_import_service.py
│   ├── pyproject.toml
│   └── alembic.ini
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/client.ts      # Axios instance with auth interceptor
│   │   ├── components/
│   │   │   ├── FileUploadZone.tsx
│   │   │   ├── ImportProgress.tsx
│   │   │   ├── RecordsTable.tsx
│   │   │   └── ProjectCard.tsx
│   │   └── pages/
│   │       ├── RegisterPage.tsx
│   │       ├── LoginPage.tsx
│   │       ├── ProjectsPage.tsx
│   │       ├── NewProjectPage.tsx
│   │       ├── ProjectPage.tsx
│   │       ├── ImportPage.tsx
│   │       └── RecordsPage.tsx
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── docker-compose.yml
└── .env.example
```

---

## Done Criteria

This slice is complete when all of the following pass:

1. A new user registers, receives a token, and can access protected routes with it.
2. A logged-in user creates a project and sees it in their project list.
3. Uploading a `.ris` file triggers a job that transitions `pending → processing → completed`.
4. After import, querying `record_sources` returns correct field mapping: title, authors (array), year, journal, DOI; `raw_data` contains original fields verbatim.
5. Re-uploading the same file does not create duplicate records for entries with DOIs.
6. The records table renders with working pagination, sort toggle, and search.
7. A corrupt or wrong-format file upload results in `status=failed` and a visible error message in the UI.
8. Unit tests pass: RIS parser against a 10-record fixture, normalization edge cases (Unicode, missing DOI, empty authors), idempotent insert logic.

---

## What This Slice Unlocks

| Next Slice | Depends On |
|------------|-----------|
| Slice 2 — Deduplication | `record_sources` populated by Slice 1 |
| Phase 2 — Screening | Project + user model from Slice 1 auth |
| All subsequent API work | JWT pattern, layered architecture, pagination contract |

Nothing in the system can be built before this slice is complete. Everything after is incremental.

---

## Open Questions (Answered)

| Question | Decision |
|----------|----------|
| Password policy | 8-char minimum, no complexity rules |
| File size limit | 50 MB (sufficient for ~50,000-record RIS export) |
| Token expiry | 24 hours (researchers work in long sessions) |
| Authors field in RIS | `AU` tags → `TEXT[]`, stored as `["Last, First", ...]` |
| Sync vs async import | Async background task; sync only if file <100 records (not yet implemented) |