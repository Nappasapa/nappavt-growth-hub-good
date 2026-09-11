// Full-stack integration test: real MariaDB + real server process + real
// HTTP round-trips (drives scripts/dev-smoke-node.mjs against a scratch
// deployment). Gated on TEST_DB_DSN — without it the suite skips cleanly:
//
//   TEST_DB_DSN="mysql://root:pw@127.0.0.1:3306/growthhub_test" \
//     node .test/server-integration.test.js
//
// CI provides the DSN via a mariadb service container (see .github/workflows).

'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const DSN = process.env.TEST_DB_DSN || '';
if (!DSN) {
  console.log('server-integration: skipped (set TEST_DB_DSN to run against a real MariaDB)');
  process.exit(0);
}

const u = new URL(DSN.replace(/^mysql:\/\//, 'mariadb://'));
const PORT = 18788 + Math.floor(Math.random() * 400);
const STORAGE = mkdtempSync(join(tmpdir(), 'growthhub-it-'));

const env = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  DB_HOST: u.hostname,
  DB_PORT: u.port || '3306',
  DB_USER: decodeURIComponent(u.username || 'root'),
  DB_PASSWORD: decodeURIComponent(u.password || ''),
  DB_NAME: (u.pathname || '/growthhub').slice(1) || 'growthhub',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SECURE_COOKIES: '0',
  AUTO_MIGRATE: '0', // migration runs once below, explicitly
  OWNER_EMAIL: 'owner@it.dev',
  OWNER_PASSWORD: 'owner-pass-it-2026',
  BOT_SYNC_TOKEN: 'it-bot-token-8c4f9e',
  STORAGE_DIR: STORAGE,
  ENABLE_SCHEDULER: '0',
  LOGIN_RATE_MAX: '50', // avoid self-inflicted lockout during red-team checks
};

let server = null;
const cleanup = () => { if (server && !server.killed) { try { server.kill('SIGTERM'); } catch {} } };
process.on('exit', cleanup);

function run(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

(async () => {
  console.log('server integration (MariaDB):');
  let pass = 0, fail = 0;
  const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  ok -', name); }
    else { fail++; console.error('  FAIL -', name, String(extra).slice(0, 500)); }
  };

  // 1. schema bootstrap (fresh: down everything then up)
  {
    let r = run('node', ['server/migrate.mjs', 'create']);
    t('database created', r.code === 0, r.out.slice(-200));
    // reset: roll down repeatedly (max 5) — fresh DB is fine with 0 downs
    for (let i = 0; i < 5; i++) {
      const d = run('node', ['server/migrate.mjs', 'down']);
      if (d.code !== 0 || /nothing to roll back/.test(d.out)) break;
    }
    r = run('node', ['server/migrate.mjs', 'up']);
    t('migrations apply cleanly', r.code === 0, r.out.slice(-300));
    r = run('node', ['server/migrate.mjs', 'status']);
    t('status reports 0001 applied', r.code === 0 && /✓ applied\s+0001_init/.test(r.out), r.out.slice(-200));
  }

  // 2. boot the real server
  server = spawn('node', ['server/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const base = `http://127.0.0.1:${PORT}`;
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      const data = await res.json();
      if (res.status === 200 && data.ok === true) { healthy = true; break; }
    } catch { /* boot still in flight */ }
    await new Promise(r => setTimeout(r, 500));
  }
  t('server boots + health 200 with db', healthy, serverLog.slice(-400));
  if (serverLog) {
    t('startup log leaks no secrets', !/owner-pass-it-2026|it-bot-token|0123456789abcdef0123456789/.test(serverLog), serverLog.slice(0, 300));
  }

  // 3. drive the full black-box smoke suite against it
  const smoke = run('node', ['scripts/dev-smoke-node.mjs'], {
    SMOKE_API_BASE: base,
    SMOKE_OWNER_EMAIL: env.OWNER_EMAIL,
    SMOKE_OWNER_PASSWORD: env.OWNER_PASSWORD,
    SMOKE_ADVISOR_EMAIL: 'advisor@it.dev',
    SMOKE_ADVISOR_PASSWORD: 'advisor-pass-it-2026',
    BOT_SYNC_TOKEN: env.BOT_SYNC_TOKEN,
  });
  const smokeOk = smoke.code === 0 && !/ FAIL - /.test(smoke.out);
  t('dev-smoke: full E2E green (auth+state+notes+clips+bot)', smokeOk, smoke.out.split('\n').filter(l => /FAIL|error/i.test(l)).join('\n').slice(-600));

  console.log(`\nserver-integration: ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('SUITE CRASH:', err); cleanup(); process.exit(1); });
