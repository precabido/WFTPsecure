# Deployment

## Target layout

```
/root/codex-isolated/cinderlink-preview-9999/   working tree (this repository)
/srv/cinderlink/
├── config/preview.env      secrets, mode 600, never committed
├── data/postgres/          database volume
├── data/object-storage/    ciphertext blobs — outside any served directory
├── logs/
├── backups/                schema dumps only, never ciphertext
├── releases/<build-id>/
└── current/                BUILD_ID, COMMIT_SHA, DEPLOYED_AT
```

## Isolation contract

| Property | Value |
|---|---|
| Docker project | `cinderlink_preview_9999` |
| Docker network | `cinderlink_preview_9999_net` |
| Published ports | **9999 only** |
| Host nginx | not read, not modified |
| Other `/srv` projects | not touched |

Verified from the resolved compose config: exactly one `published:` entry
(`9999`); `api`, `web`, `worker`, `postgres` and `redis` are internal-only;
every service carries `no-new-privileges:true` and `cap_drop: ALL`; `gateway`,
`web` and `redis` run read-only.

## First deployment

```bash
# 1. Check the port is free. If something else owns it, STOP and document it —
#    do not kill another project's process.
ss -ltnp | grep ':9999' || echo "9999 is free"

# 2. Open only this port. Do not change UFW's default policies.
ufw allow 9999/tcp
ufw status numbered

# 3. Generate secrets (CSPRNG, mode 600, never printed)
PUBLIC_BASE_URL="http://<host>:9999" ./scripts/bootstrap-secrets.sh

# 4. Deploy
./scripts/deploy-preview.sh

# 5. Verify
curl -fsS http://127.0.0.1:9999/healthz
./scripts/healthcheck.sh
./scripts/verify-no-plaintext.sh
```

## Survive reboots

```bash
cp infra/systemd/cinderlink-preview.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cinderlink-preview.service
systemctl status cinderlink-preview.service
```

The unit starts and stops exactly one compose project. Its `ExecStop` is `down`,
never `down -v`: the volumes hold the only copy of live capsule data.

## Moving to production (HTTPS)

The preview configuration is deliberately not production-ready. To promote it:

1. Terminate TLS in front of the gateway (a reverse proxy or a load balancer).
2. Set `PUBLIC_BASE_URL=https://your-domain`.
3. Set `APP_MODE=production`.
4. **Remove `ALLOW_INSECURE_PREVIEW`.** With it removed and a non-HTTPS base
   URL, the API exits 78 with an explanation rather than starting.
5. Set `PUBLIC_PREVIEW_WARNING=false` — only now is the warning band untrue.
6. Add HSTS at the TLS terminator.
7. Raise `MAX_TTL_HOURS`, `MAX_FILE_MB` and the rate limits to suit.

Step 4 is the important one. The guard exists so that a misconfigured
production deploy fails loudly instead of quietly serving a security claim it
cannot keep.

## Rollback

```bash
./scripts/rollback-preview.sh
```

Restarts from the previous images without rebuilding and without touching
volumes. Migrations are additive, so previous code runs against the current
schema.

## Non-interference audit

Capture `docs/vps-before.txt` before the first deployment and
`docs/vps-after.txt` afterwards:

```bash
{ hostname; date; uname -a; uptime; df -h; free -h;
  docker version; docker compose version;
  systemctl --failed; ufw status verbose; ss -ltnp;
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}';
} > docs/vps-after.txt 2>&1
```

Sanitise before committing: never include environment variables or secrets.

The only expected differences are TCP 9999 listening and containers prefixed
`cinderlink_preview_9999`. Nothing else should have appeared, disappeared or
restarted.
