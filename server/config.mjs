// Central environment configuration for the Growth Hub backend.
// Every value comes from process.env (optionally hydrated from a local .env
// file that is NEVER committed). Nothing secrets-related may be required by the
// frontend — the browser only ever talks to this server over HTTP.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(here, '..');

// Minimal .env loader (KEY=VALUE lines, # comments, no shell features).
// Real env vars always win. Missing file is fine.
export function loadDotEnv(path = resolve(ROOT_DIR, '.env')) {
  if (!existsSync(path)) return;
  try {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[growth-hub] could not read .env:', err.message);
  }
}

loadDotEnv();

const str = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const int = (name, fallback) => {
  const n = parseInt(str(name, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const bool = (name, fallback) => {
  const v = str(name, '').toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

export const config = {
  env: str('NODE_ENV', 'production'),
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8788),
  // Public origin of this deployment (used for the same-origin guard). Leave
  // empty to accept the request's own Host header.
  appOrigin: str('APP_ORIGIN', ''),

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'growthhub'),
    password: str('DB_PASSWORD', ''),
    name: str('DB_NAME', 'growthhub'),
    connectionLimit: int('DB_CONNECTION_LIMIT', 8),
    ssl: bool('DB_SSL', false),
    connectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', 10000),
    queryTimeoutMs: int('DB_QUERY_TIMEOUT_MS', 60000),
  },

  // Session cookies. Secret optional but recommended: when set, cookie values
  // carry an HMAC so forged/foreign cookies are rejected before any DB read.
  sessionSecret: str('SESSION_SECRET', ''),
  sessionDays: int('SESSION_DAYS', 14),
  secureCookies: bool('SECURE_COOKIES', true), // set false only for plain-http local dev

  // First-run owner provisioning / CLI bootstrap. ONLY used when creating the
  // first user (or via npm run user:create). Never logged.
  ownerEmail: str('OWNER_EMAIL', '').toLowerCase(),
  ownerPassword: str('OWNER_PASSWORD', ''),

  // Bot channel (Nappa Bot on Craftnode): shared secret, never in browsers.
  botSyncToken: str('BOT_SYNC_TOKEN', ''),

  storageDriver: str('STORAGE_DRIVER', 'local'),
  storageDir: resolve(ROOT_DIR, str('STORAGE_DIR', 'data/clips')),

  rateLimit: {
    loginWindowMs: int('LOGIN_RATE_WINDOW_MS', 10 * 60 * 1000),
    loginMax: int('LOGIN_RATE_MAX', 10),
    botWindowMs: int('BOT_RATE_WINDOW_MS', 60 * 1000),
    botMax: int('BOT_RATE_MAX', 240),
  },

  scheduler: bool('ENABLE_SCHEDULER', true),
  schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 15 * 60 * 1000),

  autoMigrate: bool('AUTO_MIGRATE', true),
  maxStateBytes: int('MAX_STATE_BYTES', 25 * 1024 * 1024),
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),

  isTestenv: str('NODE_ENV', '') === 'test',
};

export function assertSafeConfig() {
  const problems = [];
  if (!config.db.password && !config.isTestenv) {
    problems.push('DB_PASSWORD is empty — set it in .env (never commit it).');
  }
  if (!config.botSyncToken && !config.isTestenv) {
    problems.push('BOT_SYNC_TOKEN is empty — /api/bot/* will answer 503 until you set one.');
  }
  return problems;
}

// Redacted config snapshot for startup logs — proof that secrets never leak.
export function redactedConfigSummary() {
  return {
    env: config.env,
    listen: `${config.host}:${config.port}`,
    db: { host: config.db.host, port: config.db.port, name: config.db.name, user: config.db.user, pool: config.db.connectionLimit, ssl: config.db.ssl, passwordSet: Boolean(config.db.password) },
    botTokenSet: Boolean(config.botSyncToken),
    storage: { driver: config.storageDriver, dir: config.storageDir },
    scheduler: config.scheduler,
    secureCookies: config.secureCookies,
    sessionSecretSet: Boolean(config.sessionSecret),
  };
}
