// Migration runner: `node server/migrate.mjs <create|up|status|down> [name]`
//  - create : CREATE DATABASE IF NOT EXISTS (utf8mb4) using a bootstrap
//             connection without a selected database
//  - up     : apply pending server/migrations/<nnnn>_<name>.sql in order
//  - status : list applied/pending migrations
//  - down   : apply the newest migration's <name>.down.sql and un-record it
// Bookkeeping table: growthhub_migrations(name PK, applied_at).
// DDL in MariaDB is not transactional — failures stop between statements and
// are reported with the migration name and statement index.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import mariadb from 'mariadb';
import { config } from './config.mjs';
import { splitStatements } from './sql.mjs';
import { nowDb } from './db.mjs';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
const BOOKKEEPING = 'growthhub_migrations';

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{4}_[A-Za-z0-9_]+\.sql$/.test(f))
    .sort()
    .map(f => ({
      name: f.replace(/\.sql$/, ''),
      file: resolve(MIGRATIONS_DIR, f),
      downFile: resolve(MIGRATIONS_DIR, f.replace(/\.sql$/, '.down.sql')),
    }));
}

function rootPoolOptions(noDatabase) {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    connectionLimit: 2,
    connectTimeout: config.db.connectTimeoutMs,
    dateStrings: true,
    multipleStatements: false,
    ...(noDatabase ? {} : { database: config.db.name }),
    ...(config.db.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

async function createDatabase(pool) {
  const name = String(config.db.name || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!name) throw new Error('DB_NAME must contain only [A-Za-z0-9_]');
  await pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  return name;
}

async function ensureBookkeeping(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${BOOKKEEPING} (
      name VARCHAR(191) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function appliedMigrations(pool) {
  await ensureBookkeeping(pool);
  const rows = await pool.query(`SELECT name FROM ${BOOKKEEPING} ORDER BY name`);
  return new Set(rows.map(r => String(r.name)));
}

export async function runCreate() {
  const pool = mariadb.createPool(rootPoolOptions(true));
  try {
    const name = await createDatabase(pool);
    console.log(`database ensured: ${name} (utf8mb4 / utf8mb4_unicode_ci)`);
  } finally {
    await pool.end();
  }
}

export async function runUp({ quiet = false } = {}) {
  await runCreate();
  const pool = mariadb.createPool(rootPoolOptions(false));
  try {
    const applied = await appliedMigrations(pool);
    const pending = listMigrations().filter(m => !applied.has(m.name));
    if (!pending.length) {
      if (!quiet) console.log('migrations: nothing pending');
      return { applied: 0 };
    }
    for (const mig of pending) {
      const statements = splitStatements(readFileSync(mig.file, 'utf8'));
      const conn = await pool.getConnection();
      try {
        let idx = 0;
        for (const stmt of statements) {
          idx += 1;
          try {
            await conn.query(stmt);
          } catch (err) {
            const detail = err && err.message ? err.message : String(err);
            throw new Error(`migration ${mig.name} statement #${idx} failed: ${detail.slice(0, 400)}`);
          }
        }
        await conn.query(`INSERT INTO ${BOOKKEEPING} (name, applied_at) VALUES (?, ?)`, [mig.name, nowDb()]);
        if (!quiet) console.log(`migrations: applied ${mig.name} (${statements.length} statements)`);
      } finally {
        conn.release();
      }
    }
    return { applied: pending.length };
  } finally {
    await pool.end();
  }
}

export async function runStatus() {
  const pool = mariadb.createPool(rootPoolOptions(false));
  try {
    const applied = await appliedMigrations(pool);
    for (const m of listMigrations()) {
      console.log(`${applied.has(m.name) ? '✓ applied' : '· pending '}  ${m.name}`);
    }
  } finally {
    await pool.end();
  }
}

export async function runDown() {
  const pool = mariadb.createPool(rootPoolOptions(false));
  try {
    const rows = await pool.query(`SELECT name FROM ${BOOKKEEPING} ORDER BY name DESC LIMIT 1`);
    if (!rows.length) { console.log('migrations: nothing to roll back'); return { reverted: 0 }; }
    const name = String(rows[0].name);
    const mig = listMigrations().find(m => m.name === name);
    if (!mig || !existsSync(mig.downFile)) throw new Error(`no down migration for ${name}`);
    const statements = splitStatements(readFileSync(mig.downFile, 'utf8'));
    for (const stmt of statements) await pool.query(stmt);
    await pool.query(`DELETE FROM ${BOOKKEEPING} WHERE name = ?`, [name]);
    console.log(`migrations: reverted ${name}`);
    return { reverted: 1 };
  } finally {
    await pool.end();
  }
}

// CLI entry point.
if (process.argv[1] && basename(process.argv[1]) === 'migrate.mjs') {
  const cmd = process.argv[2] || 'up';
  const fn = { create: runCreate, up: runUp, status: runStatus, down: runDown }[cmd];
  if (!fn) {
    console.error('usage: node server/migrate.mjs <create|up|status|down>');
    process.exit(1);
  }
  fn().then(
    () => process.exit(0),
    (err) => { console.error('MIGRATION FAILED:', err.message); process.exit(1); },
  );
}
