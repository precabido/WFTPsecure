#!/usr/bin/env bash
#
# Generate the runtime secrets file (§30).
#
# Secrets come from the OS CSPRNG, are written once with mode 600, and are never
# printed. Re-running is refused if the file exists: regenerating the database
# password on a live deployment would lock the API out of its own data.

set -euo pipefail

RUNTIME_DIR="/srv/cinderlink"
ENV_FILE="${RUNTIME_DIR}/config/preview.env"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:9999}"

if [ -f "${ENV_FILE}" ]; then
  echo "refusing to overwrite existing ${ENV_FILE}" >&2
  echo "delete it deliberately if you intend to rotate every secret at once." >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"/{config,data/postgres,data/redis,data/object-storage,logs,backups,releases,current}
chmod 700 "${RUNTIME_DIR}/config" "${RUNTIME_DIR}/data/object-storage"

PG_PASSWORD="$(openssl rand -base64 32 | tr -d '\n=+/' | head -c 40)"
RATE_LIMIT_SECRET="$(openssl rand -hex 32)"

umask 077
cat > "${ENV_FILE}" <<EOF
# Generated $(date -u +%FT%TZ) by scripts/bootstrap-secrets.sh
# Mode 600. Never commit, never print, never reuse across projects.

POSTGRES_PASSWORD=${PG_PASSWORD}
DATABASE_URL=postgres://cinderlink:${PG_PASSWORD}@postgres:5432/cinderlink
REDIS_URL=redis://redis:6379

RATE_LIMIT_SECRET=${RATE_LIMIT_SECRET}
RATE_LIMIT_ROTATION_SECONDS=86400

APP_MODE=preview
PREVIEW_MODE=true
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
PUBLIC_PREVIEW_WARNING=true
ALLOW_INSECURE_PREVIEW=true

MAX_FILE_MB=50
MAX_CAPSULE_MB=100
MAX_FILES_PER_CAPSULE=10
MAX_TTL_HOURS=24
STORAGE_CAP_BYTES=8589934592
EOF

chmod 600 "${ENV_FILE}"
echo "wrote ${ENV_FILE} (mode 600, $(wc -l < "${ENV_FILE}") lines)"
echo "contents are intentionally not printed."
