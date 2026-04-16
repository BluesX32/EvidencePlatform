# Developer guide

## Quick start

```bash
make up       # build images and start all three services
make logs     # tail backend logs (Ctrl-C to stop)
```

Open the frontend at **http://localhost:5173** and the API docs at **http://localhost:8000/docs**.

---

## Makefile targets

| Target | What it does |
|--------|--------------|
| `make up` | `docker compose up -d --build` — start/rebuild in background |
| `make down` | `docker compose down` — stop containers (data volume preserved) |
| `make reset` | `docker compose down -v && docker compose up -d --build` — wipe all data and start fresh |
| `make migrate` | Run `alembic upgrade head` inside the running backend container |
| `make logs` | Tail backend container logs (`Ctrl-C` to stop) |

---

## Automatic migrations

The backend container runs [backend/entrypoint.sh](../backend/entrypoint.sh) on startup.
It:

1. Polls `pg_isready` until Postgres accepts connections (belt-and-suspenders on top of the
   compose `healthcheck`).
2. Runs `alembic -c alembic.ini upgrade head` — idempotent, safe every restart.
3. Exec's into `uvicorn`.

This means **you never need to run migrations manually** after `make up` or `make reset`.
Running `make migrate` is only needed if you add a new migration while the stack is already
running.

---

## Postgres credentials

| Setting | Value |
|---------|-------|
| Host (from host machine) | `localhost` |
| Port | `5433` (mapped from container port 5432) |
| `POSTGRES_USER` / `DB_USER` | `evidence` |
| `POSTGRES_PASSWORD` | `evidence` |
| `POSTGRES_DB` / `DB_NAME` | `evidenceplatform` |

### Connect with psql

```bash
psql -h localhost -p 5433 -U evidence -d evidenceplatform
```

Password: `evidence`

### Useful inspection queries

```sql
-- List all tables
\dt

-- Check migration history
SELECT version_num, is_current FROM alembic_version;

-- Count records per project
SELECT p.name, COUNT(r.id) AS records
FROM projects p
LEFT JOIN records r ON r.project_id = p.id
GROUP BY p.name
ORDER BY p.name;

-- Show source overlap for a project (replace the UUID)
SELECT s.name, COUNT(rs.record_id) AS total
FROM sources s
LEFT JOIN record_sources rs ON rs.source_id = s.id
WHERE s.project_id = '<your-project-uuid>'
GROUP BY s.name;
```

---

## Local development (without Docker)

The `.env` file at the repo root is read by both the backend (`pydantic-settings`) and
the Alembic `env.py`. It must exist before running the backend outside Docker:

```
DATABASE_URL=postgresql+asyncpg://evidence:evidence@localhost:5433/evidenceplatform
SECRET_KEY=local-dev-secret-key-change-in-production
ACCESS_TOKEN_EXPIRE_HOURS=24
BACKEND_CORS_ORIGINS=http://localhost:5173
```

Run the backend:

```bash
cd backend
source .venv/bin/activate
alembic -c alembic.ini upgrade head   # run migrations once
uvicorn app.main:app --reload         # start dev server
```

Run the frontend:

```bash
cd frontend
npm install
npm run dev
```

Run tests:

```bash
cd backend
.venv/bin/python -m pytest tests/ -v
```

> Integration tests (`test_overlap.py`) require the local Postgres to be running on port 5433.
> They create data under unique project UUIDs and leave no observable side effects.

---

## Running frontend tests

```bash
cd frontend
npx vitest run          # run all Vitest unit tests
npx vitest run --reporter=verbose
```

Frontend tests cover Euler layout math (`eulerLayout.test.ts`) and are in `frontend/src/` alongside the source files they test.

---

## Database migrations

Migrations live in `backend/migrations/versions/`. Current head is migration `030`.

| Migration | Description |
|-----------|-------------|
| 001 | Initial schema stub (legacy, drops old tables) |
| 002–004 | Core tables: projects, sources, records, dedup |
| 005 | Manual overlap: `overlap_clusters`, `overlap_cluster_members` |
| 006 | Strategy run history: `overlap_strategy_runs` |
| 007–008 | (Dropped — old corpus tables) |
| 009 | Screening tables: `screening_decisions`, `extraction_records`, `screening_claims` |
| 010 | Record indexes for screening performance |
| 011 | `criteria` JSONB on `projects` |
| 012 | `record_annotations` table (anchored annotations) |
| 013 | `project_labels` + `record_labels` tables |
| 014 | Ontology tables (`ontology_nodes`) |
| 015 | Thematic analysis: `code_extractions`, `thematic_history` |
| 016 | Full-text PDFs: `fulltext_pdfs` table |
| 017 | LLM screening: `llm_screening_runs` + `llm_screening_results` tables |
| 018 | Team collaboration: `project_members`, `project_invitations`, `consensus_decisions` tables |
| 019 | PDF drawing: `drawing_data` JSONB on `fulltext_pdfs` (per-page freehand strokes) |
| 020 | PDF annotation anchoring: `page_num` + `highlight_rects` JSONB on `record_annotations` |
| 021 | Screening queues: `screening_queues` table (seeded, position-tracked) |
| 022 | Extraction template: `extraction_template` JSONB on `projects` |
| 023 | Record concepts: `record_concepts` table (record/cluster ↔ ontology node tagging) |
| 024 | Ontology edges: `ontology_edges` table (directed relationships between ontology nodes) |
| 025 | LLM enhancements: mode, source filter, extraction, prompt config, comparison columns on LLM tables |
| 026 | User API keys: `api_keys` JSONB on `users` |
| 027 | Agent pipeline: `agent_mode`, `agent_pipeline`, `agent_outputs` on `llm_screening_runs` |
| 028 | Citation sourcing: `citation_searches` + `citation_candidates` tables (backward/forward snowballing) |
| 029 | Citation search enhancements: `scope`, `source_record_ids`, `source_record_count` on `citation_searches` |
| 030 | Citation candidate dedup fix: unique indexes on `(search_id, direction, doi/pmid/s2_paper_id)` — allows same paper as both backward and forward candidate |

### No-migration changes (logic/service layer)

The following changes required no schema migration but alter platform behaviour significantly:

| Area | Change |
|------|--------|
| **Manual citation import** | `POST /projects/{id}/citations/searches/manual` — upload RIS/MEDLINE file, tag with direction (backward/forward) and optional source paper; creates a completed `CitationSearch` (scope=`manual`) synchronously |
| **Corpus deletion → citation update** | When a corpus is deleted, `citation_candidates.in_project` is reset to `FALSE` and `project_record_id` to `NULL` for any candidates whose matching record was exclusively owned by the deleted corpus |
| **Citation resolution hardening** | Six bugs fixed in `citation_service.py`: (1) `dx.doi.org` prefix stripping + URL-encoding of DOI path; (2) PMID regex extraction for annotated formats (`"12345 [pubmed]"`); (3) title-search year tolerance widened to ±2 yr with ±5 yr fallback; (4) pagination now driven by S2 `next` cursor rather than page-size check; (5) 429 retry schedule 30 s → 60 s → 120 s; (6) per-record exception isolation so one failing record does not abort the entire loop |
