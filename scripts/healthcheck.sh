#!/usr/bin/env bash
#
# Operational status for this project only (§36).
set -uo pipefail

PROJECT_NAME="cinderlink_preview_9999"
COMPOSE_FILE="infra/docker/docker-compose.yml"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:9999/healthz}"

echo "== containers (this project only) =="
docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" ps \
  --format 'table {{.Name}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null \
  || echo "  compose project not running"

echo
echo "== health =="
if curl -fsS --max-time 5 "${HEALTH_URL}"; then echo; else echo "  UNHEALTHY: ${HEALTH_URL} did not respond"; fi

echo
echo "== published ports (expect only 9999 from this project) =="
ss -ltnp 2>/dev/null | grep -E ':(9999)\b' || echo "  9999 not listening"

echo
echo "== release =="
for f in BUILD_ID COMMIT_SHA DEPLOYED_AT; do
  printf '  %-12s %s\n' "$f" "$(cat "/srv/cinderlink/current/$f" 2>/dev/null || echo '-')"
done

echo
echo "== disk =="
df -h /srv 2>/dev/null | tail -1
