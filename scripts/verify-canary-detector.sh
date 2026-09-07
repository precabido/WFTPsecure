#!/usr/bin/env bash
#
# Meta-test: prove that verify-no-plaintext.sh can actually FAIL.
#
# A leak detector that always reports success is worse than no detector, because
# it manufactures false confidence. This script deliberately plants the canary
# marker in each searched location, runs the detector, and asserts that it
# reports a failure. It then removes what it planted.
#
# Run it after changing verify-no-plaintext.sh, and in CI alongside it.

set -uo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres@127.0.0.1:55432/cinderlink}"
STORAGE_ROOT="${STORAGE_ROOT:-/srv/cinderlink/data/object-storage}"
LOG_DIR="${LOG_DIR:-/srv/cinderlink/logs}"
HERE="$(cd "$(dirname "$0")" && pwd)"

FAILURES=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

echo "Canary detector self-test"
echo

# The detector generates its own random marker per run, so to plant something it
# will find we must plant a value matching its prefix pattern in a way that any
# marker would hit. We instead run the detector with a FIXED marker via an
# override, plant that exact string, and confirm detection.
export CANARY_OVERRIDE="CINDERLINK_PLAINTEXT_CANARY_selftest_$$"

cleanup() {
  psql "${DATABASE_URL}" -q -c \
    "DELETE FROM capsules WHERE encrypted_manifest_object_key LIKE '%selftest%'" >/dev/null 2>&1
  rm -f "${STORAGE_ROOT}/selftest-leak" "${LOG_DIR}/selftest-leak.log" 2>/dev/null
}
trap cleanup EXIT

# --- 1. Storage leak ---------------------------------------------------------
echo "[1/2] Planting the canary in object storage"
mkdir -p "${STORAGE_ROOT}"
printf 'leaked: %s\n' "${CANARY_OVERRIDE}" > "${STORAGE_ROOT}/selftest-leak"

OUTPUT="$(CANARY_OVERRIDE="${CANARY_OVERRIDE}" bash "${HERE}/verify-no-plaintext.sh" 2>&1)"
if printf '%s' "${OUTPUT}" | grep -q 'object storage: canary FOUND'; then
  pass "detector reported the planted storage leak"
else
  fail "detector MISSED a planted storage leak"
  printf '%s\n' "${OUTPUT}" | tail -20
fi
rm -f "${STORAGE_ROOT}/selftest-leak"

# --- 2. Log leak -------------------------------------------------------------
echo "[2/2] Planting the canary in a log file"
mkdir -p "${LOG_DIR}"
printf 'leaked: %s\n' "${CANARY_OVERRIDE}" > "${LOG_DIR}/selftest-leak.log"

OUTPUT="$(CANARY_OVERRIDE="${CANARY_OVERRIDE}" bash "${HERE}/verify-no-plaintext.sh" 2>&1)"
if printf '%s' "${OUTPUT}" | grep -q 'logs: canary FOUND'; then
  pass "detector reported the planted log leak"
else
  fail "detector MISSED a planted log leak"
  printf '%s\n' "${OUTPUT}" | tail -20
fi
rm -f "${LOG_DIR}/selftest-leak.log"

echo
if [ ${FAILURES} -eq 0 ]; then
  echo "RESULT: PASS — the detector correctly reports leaks it is shown."
  exit 0
fi
echo "RESULT: FAIL — the detector cannot be trusted."
exit 1
