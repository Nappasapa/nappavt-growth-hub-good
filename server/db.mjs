// MariaDB access layer: one shared connection pool (never per-request
// connections), parameterized queries only, ISO-8601 <-> UTC DATETIME
// conversion, transactions helper, advisory locks, and safe error mapping.

import mariadb from 'mariadb';
import { config } from './config.mjs';
import { log, describeError } from './log.mjs';

let pool = null;

export function getPool() {
  if (!pool) {
    pool = mariadb.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      connectionLimit: config.db.connectionLimit,
      connectTimeout: config.db.connectTimeoutMs,
      // Keep DATETIME(3) as plain UTC strings — no timezone surprises.
      dateStrings: true,
      // Node numbers for counters; IDs here are UUID strings anyway.
      insertIdAsNumber: true,
      bigIntAsNumber: true,
      charset: 'utf8mb4',
      ...(config.db.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

// ---- timestamp helpers -----------------------------------------------------
// API/frontend/bot contract: ISO-8601 'Z' strings (lexicographically sortable).
// MariaDB stores UTC DATETIME(3): 'YYYY-MM-DD HH:MM:SS.mmm'.
export function isoToDb(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}
export function dbToIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/.exec(s);
  if (m) {
    const ms = (m[3] || '').padEnd(3, '0').slice(0, 3);
    return `${m[1]}T${m[2]}${ms ? `.${ms}` : ''}Z`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
export const nowIso = () => new Date().toISOString();
export const nowDb = () => isoToDb(nowIso());

// Convert *_at columns of a row from DB format to the API contract format.
export function withIsoDates(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (f in out) out[f] = out[f] === null || out[f] === undefined ? null : dbToIso(out[f]);
  }
  return out;
}
export function rowsIsoDates(rows, fields) {
  return (rows || []).map(r => withIsoDates(r, fields));
}

// ---- query helpers ---------------------------------------------------------
export class DbError extends Error {
  constructor(message, { code = 'db_error', status = 500, cause } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function mapError(err) {
  // Graceful, classifiable errors; the original stays in server logs.
  const code = err && err.code ? String(err.code) : '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ER_GET_CONNECTION_TIMEOUT') {
    return new DbError('database unavailable', { code: 'db_unavailable', status: 503, cause: err });
  }
  if (code === 'ER_DUP_ENTRY') {
    return new DbError('duplicate key', { code: 'duplicate_key', status: 409, cause: err });
  }
  if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') {
    return new DbError('database contention', { code: 'db_contention', status: 503, cause: err });
  }
  if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2') {
    return new DbError('foreign key violation', { code: 'fk_violation', status: 409, cause: err });
  }
  return new DbError('database error', { code: 'db_error', status: 500, cause: err });
}

// SELECT → array of rows (number fields already JS numbers).
export async function query(sql, params = []) {
  try {
    return await getPool().query(sql, params);
  } catch (err) {
    log.error('db query failed:', describeError(err));
    throw mapError(err);
  }
}
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows && rows.length ? rows[0] : null;
}
// INSERT/UPDATE/DELETE → { affectedRows, insertId }
export async function exec(sql, params = []) {
  try {
    const res = await getPool().query(sql, params);
    return { affectedRows: Number(res.affectedRows ?? 0), insertId: Number(res.insertId ?? 0) };
  } catch (err) {
    log.error('db exec failed:', describeError(err));
    throw mapError(err);
  }
}

// Transaction wrapper: BEGIN/COMMIT with guaranteed ROLLBACK + release.
export async function inTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const api = {
      query: async (sql, params = []) => conn.query(sql, params),
      one: async (sql, params = []) => {
        const rows = await conn.query(sql, params);
        return rows && rows.length ? rows[0] : null;
      },
      exec: async (sql, params = []) => {
        const res = await conn.query(sql, params);
        return { affectedRows: Number(res.affectedRows ?? 0), insertId: Number(res.insertId ?? 0) };
      },
    };
    const result = await fn(api);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    if (!(err instanceof DbError)) {
      log.error('db transaction failed:', describeError(err));
      throw mapError(err);
    }
    throw err;
  } finally {
    try { conn.release(); } catch { /* already released */ }
  }
}

// Single-writer advisory lock for the scheduler (MariaDB-native).
export async function withAdvisoryLock(name, fn) {
  const conn = await getPool().getConnection();
  try {
    const rows = await conn.query('SELECT GET_LOCK(?, 0) AS got', [name]);
    const got = rows && rows[0] ? Number(rows[0].got) : 0;
    if (got !== 1) return false; // another instance holds it — fine
    try {
      await fn();
      return true;
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
    }
  } finally {
    try { conn.release(); } catch { /* ignore */ }
  }
}

export async function pingDb() {
  const rows = await query('SELECT 1 AS one');
  return Array.isArray(rows) && rows.length > 0;
}
