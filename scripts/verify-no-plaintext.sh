#!/usr/bin/env bash
#
# Plaintext canary verification (§33 "Privacidad", §39).
#
# Creates a capsule whose content contains a unique, unmistakable marker, then
# searches every place the server could possibly have leaked it: PostgreSQL
# (every column of every table), the object store, Redis, and all service logs.
#
# The canary is generated fresh on each run and is not a real secret, so it is
# safe for the marker itself to appear in this script's output on failure —
# that is what makes the failure diagnosable.
#
# Usage:
#   scripts/verify-no-plaintext.sh
#
# Environment:
#   API_URL       default http://127.0.0.1:4000
#   DATABASE_URL  default postgres://postgres@127.0.0.1:55432/cinderlink
#   REDIS_URL     host:port form, default 127.0.0.1:56379
#   STORAGE_ROOT  default /srv/cinderlink/data/object-storage
#   LOG_DIR       default /srv/cinderlink/logs

set -uo pipefail

API_URL="${API_URL:-http://127.0.0.1:4000}"
DATABASE_URL="${DATABASE_URL:-postgres://postgres@127.0.0.1:55432/cinderlink}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-56379}"
STORAGE_ROOT="${STORAGE_ROOT:-/srv/cinderlink/data/object-storage}"
LOG_DIR="${LOG_DIR:-/srv/cinderlink/logs}"

# A fresh random marker per run, so a stale value from an earlier run cannot
# make this pass by accident. CANARY_OVERRIDE exists only for the detector
# self-test (verify-canary-detector.sh), which must plant a known string.
CANARY="${CANARY_OVERRIDE:-CINDERLINK_PLAINTEXT_CANARY_$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
FAILURES=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

echo "Plaintext canary verification"
echo "  canary marker: ${CANARY}"
echo

# ---------------------------------------------------------------------------
# 1. Create a capsule through the real client-side crypto path.
#
# The Node helper below performs exactly what the browser does: it seals a
# manifest containing the canary with @cinderlink/crypto and POSTs only the
# ciphertext. If this script instead POSTed the canary in cleartext, the test
# would be measuring nothing.
# ---------------------------------------------------------------------------
echo "[1/6] Creating a capsule containing the canary (encrypted client-side)"
# Capture stdout only: the helper prints the capsule id there, and Node may
# emit unrelated warnings on stderr that would otherwise corrupt the id.
CREATE_ERR="$(mktemp)"
CREATE_OUTPUT="$(CANARY="${CANARY}" API_URL="${API_URL}" node --experimental-strip-types \
  "$(dirname "$0")/lib/create-canary-capsule.ts" 2>"${CREATE_ERR}")"
CREATE_STATUS=$?

if [ ${CREATE_STATUS} -ne 0 ]; then
  cat "${CREATE_ERR}"
  rm -f "${CREATE_ERR}"
  echo "FATAL: could not create the canary capsule; is the API running at ${API_URL}?"
  exit 2
fi
rm -f "${CREATE_ERR}"

CAPSULE_ID="$(printf '%s' "${CREATE_OUTPUT}" | tr -d '\n')"
echo "  capsule id: ${CAPSULE_ID}"
echo

# ---------------------------------------------------------------------------
# 2. PostgreSQL — every text-ish column of every table in the public schema.
# ---------------------------------------------------------------------------
echo "[2/6] Searching PostgreSQL"
# Casting the whole row to text catches every column, including bytea, in one
# comparison — a per-column loop would silently skip a column added later.
PG_NOTICES="$(psql "${DATABASE_URL}" -At <<SQL 2>&1 | grep -c 'HIT in table' || true
DO \$\$
DECLARE r RECORD; hits BIGINT;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_type='BASE TABLE' LOOP
    EXECUTE format('SELECT count(*) FROM %I t WHERE CAST(t AS text) LIKE %L',
                   r.table_name, '%${CANARY}%') INTO hits;
    IF hits > 0 THEN RAISE NOTICE 'HIT in table %', r.table_name; END IF;
  END LOOP;
END \$\$;
SQL
)"

if [ "${PG_NOTICES}" = "0" ]; then
  pass "PostgreSQL: canary not present in any table"
else
  fail "PostgreSQL: canary FOUND in ${PG_NOTICES} table(s)"
fi

# ---------------------------------------------------------------------------
# 3. Object storage — every stored blob.
# ---------------------------------------------------------------------------
echo "[3/6] Searching object storage (${STORAGE_ROOT})"
if [ -d "${STORAGE_ROOT}" ]; then
  if grep -rl --binary-files=text "${CANARY}" "${STORAGE_ROOT}" >/dev/null 2>&1; then
    fail "object storage: canary FOUND in stored blobs"
    grep -rl --binary-files=text "${CANARY}" "${STORAGE_ROOT}" 2>/dev/null | head -5
  else
    pass "object storage: canary not present in any blob"
  fi

  # Storage keys must not embed content or filenames either (§14).
  if find "${STORAGE_ROOT}" -name "*${CANARY}*" 2>/dev/null | grep -q .; then
    fail "object storage: canary FOUND in an object key"
  else
    pass "object storage: canary not present in any object key"
  fi
else
  echo "  (storage root not found; skipping)"
fi

# ---------------------------------------------------------------------------
# 4. Redis — keys and values.
# ---------------------------------------------------------------------------
echo "[4/6] Searching Redis"
if command -v redis-cli >/dev/null 2>&1; then
  REDIS_DUMP="$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" --scan 2>/dev/null | head -1000)"
  if printf '%s' "${REDIS_DUMP}" | grep -q "${CANARY}"; then
    fail "Redis: canary FOUND in a key name"
  else
    pass "Redis: canary not present in key names"
  fi

  REDIS_VALUES=""
  while IFS= read -r key; do
    [ -z "${key}" ] && continue
    REDIS_VALUES="${REDIS_VALUES}$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" GET "${key}" 2>/dev/null)"
  done <<< "${REDIS_DUMP}"
  if printf '%s' "${REDIS_VALUES}" | grep -q "${CANARY}"; then
    fail "Redis: canary FOUND in a value"
  else
    pass "Redis: canary not present in values"
  fi
else
  echo "  (redis-cli unavailable; skipping)"
fi

# ---------------------------------------------------------------------------
# 5. Service logs.
# ---------------------------------------------------------------------------
echo "[5/6] Searching logs (${LOG_DIR})"
if [ -d "${LOG_DIR}" ]; then
  if grep -rl --binary-files=text "${CANARY}" "${LOG_DIR}" >/dev/null 2>&1; then
    fail "logs: canary FOUND"
    grep -rl --binary-files=text "${CANARY}" "${LOG_DIR}" 2>/dev/null | head -5
  else
    pass "logs: canary not present"
  fi
else
  echo "  (log directory not found; skipping)"
fi

# ---------------------------------------------------------------------------
# 6. HTTP surface — SSR HTML and the public status response.
# ---------------------------------------------------------------------------
echo "[6/6] Searching HTTP responses"
STATUS_BODY="$(curl -sS "${API_URL}/api/v1/capsules/${CAPSULE_ID}/status" 2>/dev/null)"
if printf '%s' "${STATUS_BODY}" | grep -q "${CANARY}"; then
  fail "status endpoint: canary FOUND in the response"
else
  pass "status endpoint: canary not present"
fi

if [ -n "${WEB_URL:-}" ]; then
  SSR_HTML="$(curl -sS "${WEB_URL}/c/${CAPSULE_ID}" 2>/dev/null)"
  if printf '%s' "${SSR_HTML}" | grep -q "${CANARY}"; then
    fail "SSR HTML: canary FOUND in the rendered page"
  else
    pass "SSR HTML: canary not present"
  fi
fi

echo
if [ ${FAILURES} -eq 0 ]; then
  echo "RESULT: PASS — the canary appears nowhere the server can read."
  exit 0
fi
echo "RESULT: FAIL — ${FAILURES} location(s) leaked plaintext."
exit 1
