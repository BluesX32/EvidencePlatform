#!/bin/bash
# Restore the EvidencePlatform database from a backup SQL file.
# Usage: ./restore.sh <backup_file.sql>
#
# WARNING: This will DROP and recreate the evidenceplatform database.
# All current data will be lost. Make a fresh backup first if needed.

set -e

BACKUP_FILE="$1"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup_file.sql>"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: file not found: $BACKUP_FILE"
  exit 1
fi

echo "[restore] WARNING: This will overwrite the current database."
read -r -p "Are you sure? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "[restore] Aborted."
  exit 0
fi

echo "[restore] Dropping and recreating database..."
docker compose exec -T db psql -U evidence -d postgres \
  -c "DROP DATABASE IF EXISTS evidenceplatform;" \
  -c "CREATE DATABASE evidenceplatform OWNER evidence;"

echo "[restore] Loading backup from ${BACKUP_FILE} ..."
docker compose exec -T db psql \
  -U evidence \
  -d evidenceplatform \
  --no-password \
  < "$BACKUP_FILE"

echo "[restore] Done. Database restored from ${BACKUP_FILE}"
