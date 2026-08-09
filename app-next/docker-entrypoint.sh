#!/bin/sh
# First-boot setup for the SQLite deployment.
#
# The image ships an empty, schema-migrated template database. On first boot we
# copy it onto the persistent volume; on every boot we run the seed, which is an
# idempotent upsert, so changing ADMIN_PASSWORD is just a secret change plus a
# restart.
set -e

DB_PATH="${SQLITE_PATH:-/data/prod.db}"
DB_DIR="$(dirname "$DB_PATH")"

if [ ! -d "$DB_DIR" ]; then
  echo "entrypoint: $DB_DIR does not exist — is the volume mounted?" >&2
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "entrypoint: no database at $DB_PATH, installing template"
  cp /app/prisma/template.db "$DB_PATH"
fi

# Seeding is best-effort: a failure here should not stop the site from serving
# content, which is the majority of what it does.
if [ "${SKIP_SEED:-0}" != "1" ]; then
  echo "entrypoint: seeding admin account and settings"
  node /app/prisma/seed.mjs || echo "entrypoint: seed failed, continuing" >&2
fi

exec "$@"
