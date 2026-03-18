#!/bin/bash
# Backup the EvidencePlatform database to a timestamped SQL file.
# Usage: ./backup.sh [output_dir]
#
# Default output: ./backups/

set -e

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="evidenceplatform_${TIMESTAMP}.sql"
OUTFILE="${BACKUP_DIR}/${FILENAME}"

mkdir -p "$BACKUP_DIR"

echo "[backup] Dumping database to ${OUTFILE} ..."
docker compose exec -T db pg_dump \
  -U evidence \
  -d evidenceplatform \
  --no-password \
  > "$OUTFILE"

echo "[backup] Done. File size: $(du -sh "$OUTFILE" | cut -f1)"
echo "[backup] Restore with: ./restore.sh ${OUTFILE}"
