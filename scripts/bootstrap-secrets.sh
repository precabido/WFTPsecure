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

# Size the storage quota to the host rather than hard-coding 8 GiB. A fixed cap
# that exceeds free space is worse than no cap: it invites the service to fill a
# disk it shares with other people's data. Default to a quarter of current free
# space, capped at 8 GiB and floored at 256 MiB.
FREE_MB="$(df -Pm "${RUNTIME_DIR}" | awk 'NR==2 {print $4}')"
SUGGESTED_MB=$(( FREE_MB / 4 ))
[ "${SUGGESTED_MB}" -gt 8192 ] && SUGGESTED_MB=8192
[ "${SUGGESTED_MB}" -lt 256 ] && SUGGESTED_MB=256
STORAGE_CAP_BYTES="${STORAGE_CAP_BYTES:-$(( SUGGESTED_MB * 1024 * 1024 ))}"
STORAGE_PRESSURE_PERCENT="${STORAGE_PRESSURE_PERCENT:-80}"

# Absolute reserve that must remain free. On a volume shared with other
# services this is the bound that actually tracks danger: a percentage rule
# would refuse uploads at 86% of a 387 GB disk, where 52 GB are still free and
# nothing is at risk. Default 4 GiB, or half the free space on a small disk.
DEFAULT_MIN_FREE_MB=4096
[ "$(( FREE_MB / 2 ))" -lt "${DEFAULT_MIN_FREE_MB}" ] && DEFAULT_MIN_FREE_MB=$(( FREE_MB / 2 ))
STORAGE_MIN_FREE_BYTES="${STORAGE_MIN_FREE_BYTES:-$(( DEFAULT_MIN_FREE_MB * 1024 * 1024 ))}"

echo "host has ${FREE_MB} MB free"
echo "  STORAGE_CAP_BYTES        = ${SUGGESTED_MB} MB (this service's own quota)"
echo "  STORAGE_MIN_FREE_BYTES   = ${DEFAULT_MIN_FREE_MB} MB (reserve kept free on disk)"
echo "  STORAGE_PRESSURE_PERCENT = ${STORAGE_PRESSURE_PERCENT}%"
if [ "${FREE_MB}" -lt "$(( DEFAULT_MIN_FREE_MB * 2 ))" ]; then
  echo "  NOTE: free space is close to the reserve; uploads will be refused early."
fi

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
STORAGE_CAP_BYTES=${STORAGE_CAP_BYTES}
STORAGE_PRESSURE_PERCENT=${STORAGE_PRESSURE_PERCENT}
STORAGE_MIN_FREE_BYTES=${STORAGE_MIN_FREE_BYTES}
EOF

chmod 600 "${ENV_FILE}"
echo "wrote ${ENV_FILE} (mode 600, $(wc -l < "${ENV_FILE}") lines)"
echo "contents are intentionally not printed."
