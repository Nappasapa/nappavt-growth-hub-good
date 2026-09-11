# Growth Hub backend — Node.js + MariaDB (setup, operations, runbook)

The Growth Hub is a single all-in-one deployment: a small Node.js server
(native `node:http`, no framework) that serves the dashboard's static files
**and** the `/api/*` backend, storing everything in **MariaDB**. No Supabase,
no Cloudflare database products — it runs on any VPS, Docker host, bare metal,
or Pterodactyl-compatible egg that can run Node.js and reach MariaDB.

```
Browser (static SPA served by the backend, unchanged UI)
   │ same-origin HTTPS
   ▼
Node.js backend (server/)
   ├── MariaDB (users, state, invites, members, notes, sessions)
   ├── Clip storage driver: local disk (STORAGE_DIR) — bytes, never BLOBs
   └── /api/bot/* ← Nappa Bot (Craftnode) with BOT_SYNC_TOKEN
```

---

## 1. Requirements

- **Node.js ≥ 20** (22 LTS recommended)
- **MariaDB ≥ 10.6** (10.11/11.x tested) — MySQL 8.0 also works (the connector
  and SQL stay inside the common dialect: `DATETIME(3)`, `JSON_VALID`,
  `ON DUPLICATE KEY UPDATE`, `GET_LOCK`).
- Character set **utf8mb4** end to end (schema enforces it; compose flag sets
  server defaults).
- ~200 MB disk for the app + room for clips (your old Storage files).

## 2. Environment variables (`.env`, never committed)

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8788` | listen address |
| `APP_ORIGIN` | *(empty)* | public origin for the same-origin mutation guard (`https://hub.example.com`) |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | local defaults | MariaDB connection |
| `DB_CONNECTION_LIMIT` | `8` | pool size (shared; no per-request connections) |
| `DB_SSL` | `0` | TLS to the DB (managed MariaDB usually needs `1`) |
| `SESSION_SECRET` | *(empty)* | HMAC key for session cookies — **set it**: forged/foreign cookies are then rejected without a DB read. Generate: `openssl rand -hex 32` |
| `SESSION_DAYS` | `14` | session lifetime (sliding renewal in the last 3 days) |
| `SECURE_COOKIES` | `1` | `Secure` cookie flag — set `0` only for plain-http local dev |
| `OWNER_EMAIL` | *(empty)* | owner bootstrap e-mail (also pins the owner role) |
| `OWNER_PASSWORD` | *(empty)* | password used ONLY for first-user provisioning / CLI rotation |
| `BOT_SYNC_TOKEN` | *(empty)* | shared secret for `/api/bot/*` (bot bearer token) |
| `STORAGE_DRIVER` | `local` | clip storage driver |
| `STORAGE_DIR` | `data/clips` | clip object root (path-guarded, streamed I/O) |
| `MAX_UPLOAD_BYTES` | `2147483648` | bot clip upload cap (2 GB) |
| `MAX_STATE_BYTES` | `26214400` | dashboard blob cap (25 MB) |
| `ENABLE_SCHEDULER` | `1` | housekeeping jobs (advisory-locked, single writer) |
| `AUTO_MIGRATE` | `1` | run pending schema migrations at boot |
| `LOGIN_RATE_WINDOW_MS` / `LOGIN_RATE_MAX` | `600000` / `10` | login throttle |
| `BOT_RATE_WINDOW_MS` / `BOT_RATE_MAX` | `60000` / `240` | bot throttle |

## 3. MariaDB setup

```sql
CREATE DATABASE growthhub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'growthhub'@'%' IDENTIFIED BY 'a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, LOCK TABLES
  ON growthhub.* TO 'growthhub'@'%';
FLUSH PRIVILEGES;
```

Notes:
- The app needs DDL rights for migrations; if you want tighter runtime rights,
  run `npm run migrate` with a DBA user and give the app only DML rights.
- `GET_LOCK` (used by the scheduler) requires no special grant on MariaDB.
- Passwords are stored as `scrypt` hashes; OAuth tokens never touch the DB
  (they live on Craftnode with the bot; Google Drive tokens stay in browsers).

## 4. Local development

```bash
npm install
cp .env.example .env        # fill DB_* / OWNER_* / BOT_SYNC_TOKEN / SESSION_SECRET
npm run migrate             # creates database + tables (idempotent)
npm run dev                 # http://127.0.0.1:8788
npm test                    # unit + dom suite; integration auto-skips ...
   # ... unless TEST_DB_DSN is set (real MariaDB):
TEST_DB_DSN="mysql://root:pw@127.0.0.1:3306/growthhub_test" npm test
npm run smoke               # end-to-end against the running dev server
    #  (needs SMOKE_OWNER_EMAIL, SMOKE_OWNER_PASSWORD, SMOKE_ADVISOR_* and BOT_SYNC_TOKEN;
    #   set SECURE_COOKIES=0 for local http)
```

First login: the owner is created from `OWNER_EMAIL`+`OWNER_PASSWORD` on first
start (empty users table) — or any time via CLI:

```bash
OWNER_EMAIL=me@example.com OWNER_PASSWORD='long-unique' npm run user:create
OWNER_EMAIL=me@example.com OWNER_PASSWORD='new-one' npm run user:password   # rotate + sign-out-all
npm run user:list
npm run db:check
```

Advisors get accounts by opening their invite link and picking an
email+password (single-step `/api/invites/signup-claim`, atomic).

## 5. Production deployment (VPS / bare metal)

1. MariaDB running (§3), reachable from the app.
2. `.env` filled from `.env.example`; set `APP_ORIGIN=https://your-domain`.
3. `npm ci --omit=dev && npm run migrate && npm start` behind a process
   manager. systemd unit sketch:

```ini
[Unit]
Description=NappaVT Growth Hub
After=network-online.target mariadb.service

[Service]
WorkingDirectory=/opt/growthhub
EnvironmentFile=/opt/growthhub/.env
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
User=growthhub

[Install]
WantedBy=multi-user.target
```

4. Reverse proxy (nginx/Caddy/Apache) terminating TLS, forwarding to 127.0.0.1:8788.
   Cookies need HTTPS (`SECURE_COOKIES=1` default). Caddyfile example:
   `hub.example.com { reverse_proxy 127.0.0.1:8788 }`
5. Clips directory on persistent disk: `STORAGE_DIR` — keep it out of the
   git checkout (default `./data`, gitignored).

### Docker (recommended all-in-one)

```bash
cp .env.example .env   # edit DB_PASSWORD / DB_ROOT_PASSWORD / OWNER_* / BOT_SYNC_TOKEN / SESSION_SECRET
docker compose up -d --build
docker compose logs -f backend
```

Compose brings up `mariadb:11` (utf8mb4 server flags, healthcheck, named
volume) + the backend (migrations auto-run at boot; clips on a named volume).
Google Drive uploads remain browser-direct — nothing extra to configure.

### Pterodactyl-compatible notes

- Egg: generic Node.js egg, startup `node server/index.mjs`, port 8788 (or the
  panel-assigned port via `PORT`).
- Database: panel-provided MySQL/MariaDB — create the DB/user (§3), put
  credentials in panel environment variables (no `.env` file needed; the app
  reads plain process.env).
- Storage: mount/persist `/app/data` (the `STORAGE_DIR`) through panel
  mounts, or set `STORAGE_DIR` to the panel persistent volume path.

## 6. Bot (Craftnode) — unchanged contract

The bot keeps the same endpoints and auth style as documented in
`docs/BOT_HANDOFF_PROMPT.md`; only `GROWTH_HUB_API_BASE` changes (points to
this backend). Set the same `BOT_SYNC_TOKEN` in both places. New convenience:
`PUT /api/bot/clips/<key>` (streamed upload, used by the clip-migration
script and useful for backups).

## 7. Backups

```bash
# database (structure + data — sessions table optional)
mariadb-dump --single-transaction --routines --triggers --hex-blob \
  -u growthhub -p growthhub > backup-$(date +%F).sql

# clip objects (bytes live OUTSIDE the database!)
tar -czf clips-$(date +%F).tar.gz -C data clips
```

Suggested cron (daily, keep 14):
`0 3 * * * /opt/growthhub/scripts/…` (or two lines in /etc/crontab) — pruned
with `ls -t backup-*.sql | tail -n +15 | xargs -r rm`.

**Database dumps do NOT include the media files** (by design — big binaries
live on the storage driver, metadata in MariaDB). Back up both.

## 8. Restore

```bash
mariadb -u growthhub -p growthhub < backup-2026-09-11.sql
tar -xzf clips-2026-09-11.tar.gz -C data        # clip objects
npm run migrate                                  # ensure schema current
```

## 9. Rollback (if anything goes wrong post-cutover)

- The Supabase project remains untouched until you delete it manually — redeploy
  the previous release (git tag/branch) to flip traffic back.
- New world rollback = redeploy previous git revision + restore DB from the
  last dump + restore clips tarball (schema down-migrations exist for iterating:
  `npm run migrate:down`, but production rollback is **backup restore**, not
  down-migrations).

## 10. Error handling & ops semantics (what to expect in logs)

- DB down → `/api/health` 503 `{ok:false, db:false}`; API calls →
  `{error:'service_unavailable'}`; no stack traces or credentials in responses.
- Pool contention/deadlock → mapped to 503, logged server-side with error code.
- Duplicate keys → 409 `duplicate_key` inside the app; surfaced as claim/
  conflict codes like the old API (`invite_already_claimed`, etc.).
- Scheduler: `scheduler housekeeping: {sessions:N, invites:M}` when it removes
  anything; silent otherwise; `GET_LOCK` contention simply skips the tick.
- Session expiry purges: hourly via scheduler (15-min default interval).
