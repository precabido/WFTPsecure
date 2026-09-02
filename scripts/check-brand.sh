#!/usr/bin/env bash
#
# Enforce §1: the product's DISPLAY name lives in exactly one file.
#
# packages/config/src/brand.ts is the single source of truth. Everything
# user-visible reads from it, so the product can be renamed by editing that file
# alone. This check fails the build if the display name is hard-coded anywhere
# else in source, which is how that guarantee decays in practice.
#
# Scope note: the check is CASE-SENSITIVE and targets the display form
# ("CINDERLINK"), not the lowercase slug. Infrastructure identifiers -- the
# database name, container and volume prefixes, temp-directory prefixes -- use
# the slug deliberately and are NOT covered, because renaming those is a
# migration, not a text edit: you cannot rename a live database, a Docker
# volume, or an on-disk path by changing a TypeScript constant.

set -uo pipefail

BRAND_FILE="packages/config/src/brand.ts"
NAME="$(grep -oP "name:\s*'\K[^']+" "${BRAND_FILE}" | head -1)"

if [ -z "${NAME}" ]; then
  echo "could not read the product name from ${BRAND_FILE}" >&2
  exit 2
fi

echo "checking that '${NAME}' appears only in ${BRAND_FILE}"

# Source only. Docs and captured evidence legitimately contain the name, and
# test fixture payloads may embed it in a literal secret string.
# -I skips binaries; no -i, so the lowercase slug does not match.
HITS="$(grep -rnI --include='*.ts' --include='*.tsx' --include='*.css' \
        --include='*.mjs' --include='*.yml' \
        -e "${NAME}" packages apps infra 2>/dev/null \
        | grep -v node_modules \
        | grep -v "${BRAND_FILE}" \
        | grep -vE '_PLAINTEXT_CANARY_|E2E-SECRET' \
        || true)"

if [ -n "${HITS}" ]; then
  echo "FAIL: the product name is hard-coded outside ${BRAND_FILE}:" >&2
  echo "${HITS}" >&2
  echo >&2
  echo "Read it from the brand config instead: import { brand } from '@cinderlink/config/brand'" >&2
  exit 1
fi

echo "PASS: product naming is centralised"
