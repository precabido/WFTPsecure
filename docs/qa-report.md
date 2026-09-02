# QA report

All figures below are from actual runs on this machine against a real
PostgreSQL 16.13, a real Redis 7, real filesystem storage, and a real Chromium.
Nothing is estimated.

**Environment:** Linux 6.18, Node 22.22.2, 4 vCPU / 15 GB RAM,
PostgreSQL 16.13, Redis 7, Chromium 1194 (Playwright 1.49.1).

---

## Summary

| Suite | Tests | Result |
|---|---:|---|
| Unit — cryptography | 80 | **80 passed** |
| Integration — API, claim race, worker | 55 | **55 passed** |
| E2E — desktop Chrome + mobile viewport | 22 | **22 passed** |
| Accessibility — axe-core + keyboard + responsive | 28 | **28 passed** |
| **Total** | **185** | **185 passed, 0 failed** |

Plus two shell verifications: `verify-no-plaintext.sh` (PASS) and
`verify-canary-detector.sh` (PASS — proves the former can fail).

---

## 1. Cryptography (80 tests, 1.2 s)

`packages/crypto/test/` — envelope (24), stream (21), password/link/sealed (35).

Covered per §33:

| Requirement | Covered by |
|---|---|
| Text roundtrip | `recovers an ASCII manifest` |
| Unicode roundtrip | emoji, CJK, Arabic RTL, mathematical alphanumerics |
| Binary file roundtrip | 5 MiB through 2 MiB chunks, byte-for-byte |
| Correct password | `recovers the root key with the correct password` |
| Wrong password | rejected locally, `code: 'wrong-password'` |
| Wrong key | `rejects a wrong root key` |
| Tampered ciphertext | flipped bit at tag and at body |
| Tampered nonce | first byte XORed |
| Wrong AAD | right ciphertext + wrong context rejected |
| Chunk removed | `rejects a removed chunk` |
| Chunk duplicated | `rejects a duplicated chunk` |
| Chunks reordered | `rejects reordered chunks` |
| File truncated | **every surviving chunk authenticates; absent TAG_FINAL still refuses** |
| Unknown version | `code: 'unsupported-version'` |
| Size limits | hostile KDF params rejected before allocation |
| memzero | buffer verified all-zero after the call |

Notable extras beyond the brief: AAD injectivity (the `("ab","c")` vs `("a","bc")`
collision), cross-capsule and cross-object chunk replay, data appended after
`TAG_FINAL`, zero-byte files, and 500 random split-delivery keys round-tripped.

## 2. Integration (55 tests, ~2.7 s)

### Claim race — the central correctness proof (13 tests)

Real PostgreSQL, real concurrency, a 40-connection pool so contention is genuine
rather than serialised by a small pool.

| Scenario | Result |
|---|---|
| 100 simultaneous claims, `max_claims = 1` | **exactly 1 winner, 99 rejected** |
| Repeated over 10 independent capsules (50 claimants each) | **1 winner every time** |
| 100 simultaneous claims, `max_claims = 5` | **exactly 5 winners** |
| Retrieval tokens issued | **distinct per winner, never shared** |
| Losers | receive a rejection, never a token |
| `claims_count` after the storm | **exactly 1** (no overshoot) |
| 25 repeated status reads then a claim | **still claimable — GET never consumes** |

### API (31 tests)

Creation, validation, claim, retrieval leases, management, chunked uploads with
resume, rate limiting, security headers, error shape.

Highlights:
- An unknown field (`title`) is rejected **400**, not silently stored.
- Unknown id and consumed id return an identical response shape, so probing
  teaches an attacker nothing.
- The management token is stored only as a 32-byte SHA-256 hash.
- Redis keys contain no IP address (asserted against `203.0.113.45`).
- An incomplete upload cannot be completed (**409 incomplete**).
- A re-uploaded chunk is idempotent, which is what makes resume safe.
- Errors never contain a stack trace, `/home/`, `/srv/` or `node_modules`.

### Worker (11 tests)

- A capsule with an **active lease is not purged** — a slow download is not
  destroyed mid-flight.
- Purged once the lease expires, or immediately once retrieval completes.
- Sweeps are idempotent across repeated ticks.
- Reconciliation removes a blob nothing references, and never removes one an
  open upload session still needs.
- Storage accounting returns to zero after purge.

## 3. End-to-end, real browser (22 tests, ~19 s per project)

Desktop Chrome (1280×900) and mobile (Pixel 5). Both pass identically.

| Assertion | Outcome |
|---|---|
| Key appears only after `#`, never in the path | pass |
| Plaintext appears in **no** request URL the browser made | pass |
| 5× GET + 5× HEAD + 3 reloads leave a one-time capsule claimable | pass |
| Explicit "Open and consume" reveals the content | pass |
| **A second person, fresh browser context, cannot open it** | pass |
| Reload after opening does not re-reveal | pass |
| Wrong password rejected locally, capsule still openable with the right one | pass |
| Revoke from the management page blocks opening | pass |
| Management page never contains the plaintext, nor any IP | pass |
| Console errors | **0** |
| Third-party network requests | **0** |
| robots.txt disallows everything | pass |

## 4. Accessibility (28 tests)

axe-core with `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`:

| Route / state | Violations |
|---|---|
| Home — light | **0** |
| Home — dark | **0** |
| How it works | **0** |
| Security | **0** |
| Privacy | **0** |
| Advanced panel (open) | **0** |
| Recipient gate | **0** |

Plus: full creation flow by keyboard only; skip link is the first focusable
element; `:focus-visible` outline present when reached by keyboard; paste not
blocked in the password field; no horizontal scroll at 320 px; usable at 200 %
zoom; reduced motion removes the seal particle entirely (not merely shortens it).

### Contrast defects found and fixed

axe found seven real failures. Ratios were computed, not eyeballed:

| Token | Before | After |
|---|---:|---:|
| `--text-tertiary` (light) | 3.50 | **5.27** |
| `--warn` on `--warn-soft` | 3.31 | **5.33** |
| `--safe` on `--safe-soft` | 3.60 | **5.75** |
| `--danger` on `--danger-soft` | 3.78 | **5.40** |
| `--accent` as text on `--accent-soft` | 4.39 | **5.60** |
| white on `--accent` (button) | 5.15 | **6.57** |
| `--text-tertiary` (dark) | 3.92 | **5.78** |

The brighter original violet survives in `--accent-gradient`, which is
decorative and never carries text.

## 5. Zero-knowledge verification

`scripts/verify-no-plaintext.sh` → **RESULT: PASS**

A capsule is created through the real client-side crypto path with a unique
canary in its title, sender alias, message, field label and field value. The
canary is then absent from:

| Surface | Result |
|---|---|
| PostgreSQL — every column of every table | not present |
| Object storage — every blob | not present |
| Object storage — every object key | not present |
| Redis — key names | not present |
| Redis — values | not present |
| Service logs | not present |
| Public status response | not present |
| Server-rendered HTML | not present |

`scripts/verify-canary-detector.sh` → **RESULT: PASS**. It plants canaries in
storage and in a log file and confirms the detector reports both — so the result
above is not vacuous.

## 6. Performance

Measured with libsodium in Node on this machine.

**secretstream throughput** (16 MiB payload, best of 3, warmed):

| Chunk | Throughput |
|---|---|
| 64 KiB | 189 MiB/s |
| 256 KiB | 276 MiB/s |
| 512 KiB | 282 MiB/s |
| **1 MiB (chosen)** | **285 MiB/s** |
| 2 MiB | 279 MiB/s |
| 4 MiB | 235 MiB/s |

**Argon2id:** `INTERACTIVE` 154 ms · **chosen profile (ops 4, 64 MiB) ~660 ms** ·
`MODERATE` 3 874 ms.

**Bundle (production build):**

| Route | Route JS | First Load JS |
|---|---:|---:|
| `/` (composer) | 7.3 kB | **124 kB** |
| `/c/[id]` | 5.5 kB | 122 kB |
| `/m/[id]` | 2.9 kB | 114 kB |
| `/security` | 2.6 kB | 113 kB |
| shared | — | 105 kB |

libsodium (~200 kB WASM) is **absent from every initial bundle** — it loads on
first cryptographic use. The QR encoder likewise loads only on the result
screen.

## 7. Defects found and fixed during QA

| # | Defect | Found by | Fix |
|---|---|---|---|
| 1 | Split-delivery keys used `-` as a group separator and stripped it on parse — but `-` is in the base64url alphabet, silently corrupting ~half of all keys | unit test | separator is now whitespace; regression test pins it |
| 2 | `randomBytes` via libsodium ran at ~0.3 MiB/s; a bulk call froze the thread for 15 s | perf profiling | capped at 1 KiB with an explanatory error; bulk data uses the platform CSPRNG |
| 3 | Rate limits were captured from `process.env` at module import, so `buildApp({ env })` silently ignored the caller's limits | integration test | `resolveRateLimits(env)` takes the environment explicitly |
| 4 | Bodyless POSTs (claim, revoke, retrieval-complete) failed: the client sent `content-type: application/json` with no body, Fastify rejected it, and the error handler turned the 400 into a **500** | E2E in a real browser | client omits the header without a body; server tolerates an empty JSON body; error handler preserves 4xx |
| 5 | Seven WCAG contrast failures | axe-core | palette recomputed (table above) |
| 6 | TypeScript parameter properties broke Node's strip-only loader | running the service | rewritten as explicit fields |
| 7 | Duration labels read "5min 0s", "1h 0min" | visual review of evidence | zero units omitted |

Three *test* defects were also fixed rather than worked around: a scan that
measured a mid-fade-in frame, a `:focus-visible` check that used programmatic
focus (which never triggers it) on a button that was disabled anyway, and a
`test.use({ reducedMotion })` option that never reached the page — that
assertion was silently vacuous until switched to explicit `emulateMedia`.

## 8. Known gaps

- **Not deployed to the target VPS.** See the delivery notes: this session had
  no SSH client, no identity key, and no network route to `167.86.75.42`.
- **WebKit/Safari not exercised.** Only Chromium is available here. The
  Argon2id memory parameter is chosen with mobile Safari in mind but is
  untested there.
- **Secure-request UI is partial.** The crypto, API, database and worker paths
  are implemented and tested; the responder-facing page is not built.
- **Voice notes and code syntax highlighting** are specified in the templates
  but not implemented in the composer.
- **No external cryptographic audit.**
