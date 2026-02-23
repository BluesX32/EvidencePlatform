#!/bin/sh
# Backend container entrypoint.
#
# 1. Waits for Postgres to accept connections (belt-and-suspenders on top of
#    the compose healthcheck — useful when the container is restarted without
#    recreating the db service).
# 2. Runs `alembic upgrade head` — idempotent, safe on every start.
# 3. Exec's into uvicorn so it receives signals correctly.

set -e

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-evidence}"
DB_NAME="${DB_NAME:-evidenceplatform}"

echo "[entrypoint] Waiting for Postgres at ${DB_HOST}:${DB_PORT}…"
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -q; do
  sleep 1
done
echo "[entrypoint] Postgres is ready."

echo "[entrypoint] Running migrations…"
alembic -c alembic.ini upgrade head
echo "[entrypoint] Migrations complete."

echo "[entrypoint] Starting API server…"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
