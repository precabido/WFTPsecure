# Deployment handoff

**Read this fully before running anything.** It is written for a Claude Code
session with SSH access to the target VPS. The previous session built and
verified the software but had no network route to the host, so nothing has ever
been deployed. You are performing the first deployment.

---

## 0. What you are deploying

CINDERLINK: encrypted, ephemeral capsules for sharing a message, credential or
file with one person, once. Content is encrypted in the browser; the server
stores only ciphertext, random identifiers and expiry metadata.

| | |
|---|---|
| Repository | `precabido/SmileChat` |
| Branch | `claude/cinderlink-initial-build-wpdzzf` |
| Verified commit | `00268f3` |
| Pull request | #1 |
| Target | `167.86.75.42`, preview on **port 9999 over HTTP** |

State on arrival: 90 unit tests, 57 integration tests, 50 browser tests, 0 type
errors — all green in the build environment. Never deployed anywhere.

---

## 1. THE ISOLATION CONTRACT — read before touching the disk

This VPS runs other people's production services. The single most important
property of this deployment is that it changes nothing outside itself.

### Never touch these

| Path / resource | Why |
|---|---|
| `/srv/smilechat-social`, `/srv/hapax-veil`, rest of `/srv` | Live data, other projects (~174 GB) |
| `/opt/.spaindb/manticore-data` | Live index of the running `spaindb-manticore` container (~85 GB) |
| `/root/claude-isolated/*` | Working trees named after live ports 5555/5556 (~51 GB) |
| Any container not prefixed `cinderlink_preview_9999` | 7 other containers run here |
| The host's global nginx config | This project ships its own gateway container |
| UFW default policies | Only add the one 9999/tcp rule |

### Never run these

```
docker system prune -a      # deletes other projects' images
docker volume prune         # deletes other services' data
docker network prune
docker compose ... down -v  # destroys this project's live data
pkill / killall
systemctl stop <anything you did not create>
```

Verified at handoff time: 7 containers run here — `smilechat-analytics`,
`smilechat-analytics-db`, `smilechat-management-db`,
`smilechat-newsletter-postgres`, `hapax-redis`, `hapax-postgres`,
`spaindb-manticore`. **All seven must still be running, with unchanged uptime,
when you finish.**

---

## 2. Pre-flight

```bash
# Baseline — capture BEFORE changing anything
mkdir -p /root/codex-isolated
{ hostname; date -u; uname -a; uptime; df -h; free -h;
  docker version --format '{{.Server.Version}}'; docker compose version;
  systemctl --failed; ufw status verbose; ss -ltnp;
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}';
} > /root/vps-before.txt 2>&1
cat /root/vps-before.txt
```

Check three things and stop if any is wrong:

1. **Port 9999 free.** `ss -ltnp | grep ':9999'` must print nothing. If
   something owns it, do **not** kill it — report the PID and owning service and
   stop.
2. **Disk headroom.** `df -h /`. The deploy script requires ≥ 6 GiB free to
   build and refuses otherwise. See §4 for the storage policy decision.
3. **Docker healthy.** `docker ps` lists the 7 containers above.

---

## 3. Clone and open the port

```bash
cd /root/codex-isolated
git clone -b claude/cinderlink-initial-build-wpdzzf \
  https://github.com/precabido/SmileChat.git cinderlink-preview-9999
cd cinderlink-preview-9999
git rev-parse --short HEAD          # expect 00268f3 or later

ufw allow 9999/tcp
ufw status numbered                 # confirm default policies unchanged
```

The working directory path is **not** cosmetic:
`scripts/deploy-preview.sh` refuses to run anywhere else, so it can never act on
another project's stack.

---

## 4. Secrets and the storage policy — the one decision to make

```bash
PUBLIC_BASE_URL="http://167.86.75.42:9999" ./scripts/bootstrap-secrets.sh
```

This generates `/srv/cinderlink/config/preview.env` (mode 600, CSPRNG, never
printed) and **sizes the storage bounds to the host it finds**. Read its output.

There are three independent bounds; the strictest wins:

| Variable | Meaning |
|---|---|
| `STORAGE_MIN_FREE_BYTES` | Absolute reserve that must stay free on disk |
| `STORAGE_PRESSURE_PERCENT` | Refuse uploads above this % disk utilisation |
| `STORAGE_CAP_BYTES` | Quota on bytes this service itself may store |

**Decide the percentage based on the disk you actually find:**

- **Disk comfortably under 80%** → leave the default `80`. Nothing to do.
- **Disk large but still above 80%** (the situation at handoff: 387 GB shared
  with other projects) → a percentage is the wrong metric there. 86% of 387 GB
  still leaves 52 GB, which is no danger for a service storing tens of MB. Set
  `STORAGE_PRESSURE_PERCENT=99` in `preview.env` and rely on
  `STORAGE_MIN_FREE_BYTES`, which is the bound that tracks real danger.

If you skip this and the disk is above the threshold, the deploy script stops
with the exact numbers rather than starting a service that would 507 on every
upload. That refusal is working as designed — read it, decide, do not force it.

Do not print the contents of `preview.env` into the transcript.

---

## 5. Deploy

```bash
./scripts/deploy-preview.sh
```

It performs, in order and stopping on the first failure:

1. Validates working directory and Docker project name
2. Checks `preview.env` exists and is mode 600
3. Checks disk headroom and the upload threshold
4. `git diff --check`, typecheck, unit tests, integration tests — **before**
   touching anything running
5. Builds images, starts the stack, runs migrations in the API container
6. Waits for `http://127.0.0.1:9999/healthz`
7. Runs a Playwright smoke test
8. Records the release; **rolls back automatically** if health or smoke fails

If the integration tests fail because PostgreSQL is not reachable from the host
shell, that is expected — they need a database. Either point `DATABASE_URL` at a
scratch database or run with `SKIP_INTEGRATION=true`, noting it in your report.
Do **not** disable the typecheck or unit tests.

Expect the first build to take several minutes and a few GB of layer cache.

---

## 6. Verify — do not report success without these

```bash
# a) Public reachability
curl -fsS http://127.0.0.1:9999/healthz          # {"status":"ok","build":"..."}
curl -fsS http://167.86.75.42:9999/healthz       # from outside, if you can

# b) Only port 9999 is published by this project
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml ps
ss -ltnp | grep ':9999'
# Postgres, Redis, the API and the web app must NOT be listening on the host.

# c) The zero-knowledge property, end to end
DATABASE_URL="$(grep '^DATABASE_URL=' /srv/cinderlink/config/preview.env | cut -d= -f2-)" \
API_URL=http://127.0.0.1:9999 \
WEB_URL=http://127.0.0.1:9999 \
STORAGE_ROOT=/srv/cinderlink/data/object-storage \
LOG_DIR=/srv/cinderlink/logs \
  ./scripts/verify-no-plaintext.sh        # must print RESULT: PASS

# d) Prove the check above can fail
  ./scripts/verify-canary-detector.sh     # must print RESULT: PASS

# e) Nothing else on the host moved
{ systemctl --failed; ss -ltnp; docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}';
  df -h; free -h; ufw status verbose; } > /root/vps-after.txt 2>&1
diff /root/vps-before.txt /root/vps-after.txt
```

The only acceptable differences between before and after: TCP 9999 now
listening, containers prefixed `cinderlink_preview_9999`, and disk usage grown
by the build. **If any pre-existing container restarted or vanished, stop and
report it.**

Copy the sanitised before/after into `docs/vps-before.txt` and
`docs/vps-after.txt` — no environment variables, no secrets.

---

## 7. Survive reboots

```bash
cp infra/systemd/cinderlink-preview.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cinderlink-preview.service
systemctl status cinderlink-preview.service
```

The unit starts and stops exactly one compose project. Its `ExecStop` is `down`,
never `down -v`.

---

## 8. Manual acceptance in a browser

Open `http://167.86.75.42:9999` and confirm:

- [ ] The HTTP preview warning band is visible at the top
- [ ] Creating a note yields a link of the form `/c/<id>#v=1&k=<key>`
- [ ] Opening that link shows a **gate** — content is not revealed
- [ ] Reloading the gate several times does not consume the capsule
- [ ] "Abrir y consumir" reveals the content
- [ ] Opening the same link in a private window says it is no longer available
- [ ] The management link revokes the capsule
- [ ] ES/EN toggle and light/dark both work
- [ ] Browser console is clean

---

## 9. What is NOT built — do not claim otherwise

- **Secure-request responder UI.** Crypto, API, database and worker paths are
  implemented and tested; the responder-facing page is not built.
- **Voice notes** and **code syntax highlighting** — offered as templates,
  not implemented in the composer.
- **Local history opt-in** (remember capsules on this device) — not implemented.
- Parts of the personalisation surface (icon, accent picker, destroy-animation
  picker, QR mode).
- **No external cryptographic audit.**
- **WebKit/Safari untested** — only Chromium was available.

Do not describe the deployment as complete against the original 41-section
specification. It is complete against milestones 0–5 plus the secure-request
backend.

---

## 10. Honest framing for the report

This preview runs over **plain HTTP**. An attacker on the network path can
replace the JavaScript that performs the encryption. Say so plainly; do not call
it secure, and do not let any summary imply the zero-knowledge property survives
an active network attacker on HTTP. The UI already states this and the app
refuses to start in production mode without HTTPS.

Use test data only.

---

## 11. Operating it afterwards

`docs/runbook.md` has the full set. The essentials:

```bash
cd /root/codex-isolated/cinderlink-preview-9999
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml ps
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml logs --tail=200
./scripts/healthcheck.sh
./scripts/deploy-preview.sh      # redeploy
./scripts/rollback-preview.sh    # previous release, without touching volumes
```

---

## 12. Background you may want

| Document | Contents |
|---|---|
| `docs/architecture.md` | Diagrams: services, creation, opening, secure requests |
| `docs/crypto-format.md` | Envelope spec, AAD, KDF, link formats, measurements |
| `docs/threat-model.md` | Adversaries, with an explicit "not defended" column |
| `docs/privacy-model.md` | What the server sees and stores |
| `docs/qa-report.md` | Test results, measurements, every defect found |
| `docs/known-limitations.md` | The honest limits |
| `docs/runbook.md` | Operations |

Two design points worth knowing before you debug anything:

- **The claim is one conditional UPDATE.** Incrementing the counter and testing
  eligibility happen in the same statement, so PostgreSQL's row lock plus
  EvalPlanQual guarantee exactly one winner. Verified with 100 concurrent
  claimants. Do not "optimise" it into a SELECT-then-UPDATE.
- **The API and worker run TypeScript directly** under Node's native type
  stripping — no build step. That is why nothing in `apps/` or `packages/` uses
  TypeScript syntax that emits code (parameter properties, enums, decorators).
  If you add any, the services stop booting.
