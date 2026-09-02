# Runbook

Operating the isolated preview. Every command here is scoped to this project's
docker compose project name and touches nothing else on the host.

```
PROJECT   cinderlink_preview_9999
NETWORK   cinderlink_preview_9999_net
WORKDIR   /root/codex-isolated/cinderlink-preview-9999
RUNTIME   /srv/cinderlink
PORT      9999 (the only published port)
```

---

## Status

```bash
cd /root/codex-isolated/cinderlink-preview-9999
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml ps
curl -fsS http://127.0.0.1:9999/healthz
./scripts/healthcheck.sh          # containers + health + port + release + disk
```

## Logs

```bash
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml \
  logs --tail=200 gateway web api worker
```

Logs contain no capsule content and no full URLs. If you find either, that is a
bug — file it.

## Start / stop / restart

```bash
# start (also what systemd does on boot)
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml up -d

# stop THIS project only
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml down

# restart one service
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml restart api
```

**Never run `down -v`.** The volumes hold the only copy of live capsule metadata
and ciphertext; removing them destroys user data. Likewise never run
`docker system prune -a`, `docker volume prune`, or `docker network prune` on
this host — they reach outside this project and will take other people's
containers with them.

## Deploy

```bash
./scripts/deploy-preview.sh
```

The script validates the working directory and project name, runs typecheck,
unit tests and integration tests **before** touching anything running, builds,
starts, waits for `/healthz`, runs a Playwright smoke test, and records the
release. If health or smoke fails it rolls back automatically, so port 9999 is
never left serving a broken build.

Skips for a hurry (use sparingly): `SKIP_INTEGRATION=true`, `SKIP_SMOKE=true`.

## Rollback

```bash
./scripts/rollback-preview.sh
```

Restarts from the previous images without rebuilding. It does not touch volumes:
a rollback is a code operation, not a data operation. Migrations in this project
are additive, so previous code runs against the current schema.

## Migrations

Migrations run automatically in the API container at boot
(`RUN_MIGRATIONS=true`). To run them by hand:

```bash
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml \
  exec api node --experimental-strip-types packages/database/src/migrate.ts
```

The runner is forward-only, applies `.sql` files in filename order inside a
transaction, and records them in `schema_migrations`.

## Cleanup worker

The worker sweeps every 30 s and reconciles storage against the database every
20th tick. It is idempotent: any sweep can run twice or be killed halfway
without corrupting state.

Force a sweep by restarting it:

```bash
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml restart worker
```

Check what it is doing:

```bash
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml \
  logs --tail=50 worker
```

## Storage pressure

The API refuses new uploads at 80% of `STORAGE_CAP_BYTES` and returns
`507 storage-full`. To inspect:

```bash
df -h /srv
du -sh /srv/cinderlink/data/object-storage
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml \
  exec postgres psql -U cinderlink -d cinderlink -c \
  'SELECT cipher_bytes FROM storage_accounting;'
```

If accounting and reality diverge (possible after an unclean shutdown), the
reconciliation pass corrects storage; restart the worker to trigger one sooner.

## Verifying the zero-knowledge property

```bash
./scripts/verify-no-plaintext.sh       # must print RESULT: PASS
./scripts/verify-canary-detector.sh    # proves the check above can fail
```

Run both. A leak detector that cannot fail is worse than none.

## Purging a reported capsule

The server cannot read a capsule, so a report is handled by identifier only:

```bash
curl -fsS -X POST http://127.0.0.1:9999/api/v1/report/<capsuleId>
```

This revokes the capsule; the worker then deletes its ciphertext. The response
says explicitly that the contents were not and cannot be inspected. Do not claim
otherwise in any downstream communication.

## Recovery

**API will not start.** Check for a configuration refusal first:

```bash
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml logs api | tail -30
```

Exit code 78 with an `InsecureTransportError` means `APP_MODE=production` was
set with a non-HTTPS `PUBLIC_BASE_URL`. That is the guard working, not a crash:
either provide HTTPS or set `ALLOW_INSECURE_PREVIEW=true` deliberately.

**Postgres will not start.** Inspect `/srv/cinderlink/data/postgres` ownership
and the container logs. Do not delete the data directory to "fix" it.

**Health check fails after deploy.** The deploy script has already rolled back.
Read `docker compose ... logs --tail=100` before redeploying.

**Disk full.** Delete build caches and old release directories under
`/srv/cinderlink/releases`, never the data directory. Deletes still succeed
while writes fail.

## Backups

Back up **schema and configuration**, not ephemeral ciphertext:

```bash
docker compose -p cinderlink_preview_9999 -f infra/docker/docker-compose.yml \
  exec postgres pg_dump -U cinderlink --schema-only cinderlink \
  > /srv/cinderlink/backups/schema-$(date -u +%F).sql
```

Backing up capsule blobs would defeat the product: a capsule destroyed at 14:00
would still exist in a 13:00 snapshot. If a full dump is ever required for
forensics, document why and delete it on a fixed schedule.

## Non-interference check

After any change, confirm nothing outside this project moved:

```bash
systemctl --failed
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
ufw status verbose
df -h; free -h
```

Expected difference from the baseline: TCP 9999 listening, and containers whose
names begin with `cinderlink_preview_9999`. Nothing else should have appeared,
disappeared, or restarted.
