#!/usr/bin/env bash
#
# Roll the preview back to the previously deployed release (§31, §36).
#
# Rolling back restarts containers from the previous images. It deliberately
# does NOT touch volumes: capsule metadata and ciphertext live there, and a
# rollback is a code-level operation, not a data-level one. Database migrations
# in this project are additive, so the previous code runs against the current
# schema.

set -euo pipefail

PROJECT_NAME="cinderlink_preview_9999"
COMPOSE_FILE="infra/docker/docker-compose.yml"
RUNTIME_DIR="/srv/cinderlink"
HEALTH_URL="http://127.0.0.1:9999/healthz"

log() { printf '\033[36m[rollback]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[rollback] FATAL:\033[0m %s\n' "$1" >&2; exit 1; }

export COMPOSE_PROJECT_NAME="${PROJECT_NAME}"
DC=(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}")

PREVIOUS="$(cat "${RUNTIME_DIR}/PREVIOUS_BUILD_ID" 2>/dev/null || echo none)"
[ "${PREVIOUS}" != "none" ] || die "no previous release recorded in ${RUNTIME_DIR}/PREVIOUS_BUILD_ID"

log "rolling back to ${PREVIOUS}"

# Restart from the images already on the host. `up -d` without --build reuses
# the previous image layers; nothing is rebuilt from the (possibly broken) tree.
"${DC[@]}" up -d --no-build --force-recreate || die "could not restart services"

log "waiting for health"
for attempt in $(seq 1 45); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    CURRENT="$(cat "${RUNTIME_DIR}/current/BUILD_ID" 2>/dev/null || echo unknown)"
    echo "${PREVIOUS}" > "${RUNTIME_DIR}/current/BUILD_ID"
    echo "${CURRENT}"  > "${RUNTIME_DIR}/ROLLED_BACK_FROM"
    printf '\033[32m[rollback]\033[0m healthy on %s\n' "${PREVIOUS}"
    "${DC[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
    exit 0
  fi
  sleep 2
done

die "rollback did not become healthy; inspect: docker compose -p ${PROJECT_NAME} logs --tail=100"
