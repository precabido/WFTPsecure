#!/usr/bin/env bash
#
# Deploy the isolated preview (§31).
#
# Safety properties this script is built around:
#   - It refuses to run outside the expected working directory, and refuses to
#     use any docker project name but its own, so it can never act on another
#     project's containers.
#   - Quality gates (typecheck, unit tests, crypto tests) run BEFORE anything is
#     built or restarted. A failing gate leaves the running preview untouched.
#   - The previous release is recorded first; if the new one fails its health
#     check, the script rolls back automatically rather than leaving port 9999
#     serving a broken build.
#
# It never runs `docker system prune`, `volume prune`, `network prune`, or
# `down -v`. Those would reach outside this project or destroy live data.

set -euo pipefail

PROJECT_NAME="cinderlink_preview_9999"
EXPECTED_DIR="/root/codex-isolated/cinderlink-preview-9999"
RUNTIME_DIR="/srv/cinderlink"
COMPOSE_FILE="infra/docker/docker-compose.yml"
HEALTH_URL="http://127.0.0.1:9999/healthz"
RELEASES_DIR="${RUNTIME_DIR}/releases"

log()  { printf '\033[36m[deploy]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[deploy]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[deploy] FATAL:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. Validate location -----------------------------------------------------
CURRENT_DIR="$(pwd)"
if [ "${ALLOW_ANY_DIR:-false}" != "true" ] && [ "${CURRENT_DIR}" != "${EXPECTED_DIR}" ]; then
  die "must run from ${EXPECTED_DIR} (currently ${CURRENT_DIR}). Set ALLOW_ANY_DIR=true only for a deliberate relocation."
fi
[ -f "${COMPOSE_FILE}" ] || die "compose file not found: ${COMPOSE_FILE}"

# --- 2. Validate the docker project name -------------------------------------
# Guards against a stray COMPOSE_PROJECT_NAME in the environment pointing this
# deploy at somebody else's stack.
if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "${COMPOSE_PROJECT_NAME}" != "${PROJECT_NAME}" ]; then
  die "COMPOSE_PROJECT_NAME is '${COMPOSE_PROJECT_NAME}', expected '${PROJECT_NAME}'"
fi
export COMPOSE_PROJECT_NAME="${PROJECT_NAME}"
DC=(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}")

# --- 3. Config must exist and be private -------------------------------------
ENV_FILE="${RUNTIME_DIR}/config/preview.env"
[ -f "${ENV_FILE}" ] || die "missing ${ENV_FILE} — run scripts/bootstrap-secrets.sh first"
PERMS="$(stat -c '%a' "${ENV_FILE}")"
[ "${PERMS}" = "600" ] || die "${ENV_FILE} has mode ${PERMS}; expected 600"

# --- 3b. Host disk headroom --------------------------------------------------
# A first build pulls base images and installs dependencies for three services;
# 6 GiB is a conservative floor. Refusing here matters more than it looks: on a
# shared host, filling the disk mid-build breaks every OTHER service on the box,
# not just this deployment. Override only if you know what is on the volume.
REQUIRED_FREE_MB="${REQUIRED_FREE_MB:-6144}"
FREE_MB="$(df -Pm / | awk 'NR==2 {print $4}')"
USED_PCT="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
log "host disk: ${FREE_MB} MB free, ${USED_PCT}% used"
if [ "${FREE_MB}" -lt "${REQUIRED_FREE_MB}" ]; then
  die "only ${FREE_MB} MB free on / (need ${REQUIRED_FREE_MB} MB). Free space first; \
building here risks filling the disk and taking down other services on this host. \
Set REQUIRED_FREE_MB to override deliberately."
fi

# Separate concern from "can we build": once running, the API refuses uploads
# above STORAGE_PRESSURE_PERCENT of REAL disk use. If the host is already past
# that line, the deploy would succeed, /healthz would return ok, and every
# attempt to create a capsule would return 507 — a service that is up and
# useless. Fail here with the actual numbers rather than let that be discovered
# from the UI.
PRESSURE_PCT="$(grep -E '^STORAGE_PRESSURE_PERCENT=' "${ENV_FILE}" | cut -d= -f2 | tr -d '\r' || true)"
PRESSURE_PCT="${PRESSURE_PCT:-80}"
MIN_FREE_BYTES="$(grep -E '^STORAGE_MIN_FREE_BYTES=' "${ENV_FILE}" | cut -d= -f2 | tr -d '\r' || true)"
MIN_FREE_MB=$(( ${MIN_FREE_BYTES:-0} / 1024 / 1024 ))
if [ "${USED_PCT}" -ge "${PRESSURE_PCT}" ]; then
  TARGET_MB=$(( (100 - PRESSURE_PCT) * $(df -Pm / | awk 'NR==2 {print $2}') / 100 ))
  die "disk is ${USED_PCT}% used, at or above the ${PRESSURE_PCT}% upload threshold. \
The stack would start and then refuse every upload with 507. \
Either free space until ${TARGET_MB} MB are available, or - on a large volume \
shared with other services, where a percentage is the wrong metric - raise \
STORAGE_PRESSURE_PERCENT in ${ENV_FILE} and rely on STORAGE_MIN_FREE_BYTES \
(currently ${MIN_FREE_MB} MB) to keep a real reserve."
fi
if [ "${MIN_FREE_MB}" -gt 0 ] && [ "${FREE_MB}" -le "${MIN_FREE_MB}" ]; then
  die "only ${FREE_MB} MB free, at or below the ${MIN_FREE_MB} MB reserve. \
Uploads would be refused immediately. Free space first."
fi

BUILD_ID="$(date -u +%Y%m%d-%H%M%S)"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "build ${BUILD_ID} commit ${COMMIT_SHA}"

# --- 4. Record the current release so rollback has a target -------------------
mkdir -p "${RELEASES_DIR}"
PREVIOUS="$(cat "${RUNTIME_DIR}/current/BUILD_ID" 2>/dev/null || echo none)"
log "previous release: ${PREVIOUS}"

# --- 5. Quality gates (before touching anything running) ----------------------
log "checking working tree"
git diff --check || die "working tree has whitespace errors"
git status --short

log "typecheck"
pnpm typecheck || die "typecheck failed"

log "unit tests (crypto, contracts)"
pnpm test || die "unit tests failed"

if [ "${SKIP_INTEGRATION:-false}" != "true" ]; then
  log "integration tests (claim race, API, worker)"
  pnpm test:integration || die "integration tests failed"
fi

# --- 6. Build images ----------------------------------------------------------
log "building images"
BUILD_ID="${BUILD_ID}" COMMIT_SHA="${COMMIT_SHA}" \
  "${DC[@]}" build --build-arg "BUILD_ID=${BUILD_ID}" --build-arg "COMMIT_SHA=${COMMIT_SHA}" \
  || die "image build failed"

# --- 7. Start (migrations run in the API container on boot) -------------------
log "starting services"
"${DC[@]}" up -d --remove-orphans || die "compose up failed"

# --- 8. Wait for health -------------------------------------------------------
log "waiting for health at ${HEALTH_URL}"
HEALTHY=false
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done

if [ "${HEALTHY}" != "true" ]; then
  printf '\033[31m[deploy] health check FAILED — rolling back\033[0m\n' >&2
  "${DC[@]}" logs --tail=80 gateway web api || true
  if [ "${PREVIOUS}" != "none" ]; then
    bash "$(dirname "$0")/rollback-preview.sh" || true
  else
    log "no previous release to roll back to; leaving the stack stopped"
    "${DC[@]}" down || true
  fi
  die "deployment failed health check and was rolled back"
fi
ok "healthy: $(curl -fsS "${HEALTH_URL}")"

# --- 9. Smoke test ------------------------------------------------------------
if [ "${SKIP_SMOKE:-false}" != "true" ]; then
  log "smoke test (Playwright, desktop)"
  BASE_URL="http://127.0.0.1:9999" npx playwright test --project=desktop-chrome capsule-flow \
    || { printf '\033[31m[deploy] smoke test failed — rolling back\033[0m\n' >&2
         bash "$(dirname "$0")/rollback-preview.sh" || true
         die "smoke test failed"; }
fi

# --- 10. Record the release ---------------------------------------------------
mkdir -p "${RUNTIME_DIR}/current" "${RELEASES_DIR}/${BUILD_ID}"
if [ "${PREVIOUS}" != "none" ]; then
  echo "${PREVIOUS}" > "${RUNTIME_DIR}/PREVIOUS_BUILD_ID"
fi
echo "${BUILD_ID}"   > "${RUNTIME_DIR}/current/BUILD_ID"
echo "${COMMIT_SHA}" > "${RUNTIME_DIR}/current/COMMIT_SHA"
date -u +%FT%TZ      > "${RUNTIME_DIR}/current/DEPLOYED_AT"
cp "${RUNTIME_DIR}/current/BUILD_ID" "${RELEASES_DIR}/${BUILD_ID}/BUILD_ID"
cp "${RUNTIME_DIR}/current/COMMIT_SHA" "${RELEASES_DIR}/${BUILD_ID}/COMMIT_SHA"

ok "deployed build ${BUILD_ID} (${COMMIT_SHA})"
ok "preview: http://127.0.0.1:9999  (public: http://\$(hostname -I | awk '{print \$1}'):9999)"
"${DC[@]}" ps --format 'table {{.Name}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
