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
