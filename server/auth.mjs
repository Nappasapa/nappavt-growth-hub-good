// Application authentication: scrypt password hashing, DB-backed sessions,
// secure httpOnly cookies, HMAC-signed cookie values (when SESSION_SECRET set),
// login rate limiting, and first-user/CLI provisioning.
//
// Session token security:
//  - token: 32 random bytes (hex, 64 chars) — stored hashed (sha256) in DB
//  - cookie value: token or token.sig where sig = sha256(secret + '.' + token)
//    (first 40 hex chars) — forged/foreign cookies rejected before any DB read
//  - expiry: SESSION_DAYS (default 14), sliding renewal in the last 3 days

import crypto from 'node:crypto';
import { config, ROOT_DIR } from './config.mjs';
import { query, queryOne, exec, nowDb, isoToDb, nowIso, dbToIso, withIsoDates, inTransaction } from './db.mjs';
import { log, maskEmail } from './log.mjs';
import { sendJson, parseCookies, cookieHeader, secureCompare, clientIp } from './http.mjs';

export const SESSION_COOKIE = 'gh_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length || SCRYPT.keylen, {
      N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const newToken = () => crypto.randomBytes(32).toString('hex');
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

function cookieSignature(token) {
  if (!config.sessionSecret) return '';
  return crypto.createHmac('sha256', config.sessionSecret).update(token).digest('hex').slice(0, 40);
}
export function packCookieValue(token) {
  const sig = cookieSignature(token);
  return sig ? `${token}.${sig}` : token;
}
function unpackCookieValue(value) {
  const raw = String(value || '');
  const dot = raw.lastIndexOf('.');
  if (dot === -1) {
    return config.sessionSecret ? null : (raw.length === 64 && /^[0-9a-f]+$/.test(raw) ? raw : null);
  }
  const token = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (token.length !== 64 || !/^[0-9a-f]+$/.test(token)) return null;
  const expected = cookieSignature(token);
  if (!expected) return null; // dotted cookie but SESSION_SECRET unset — reject
  return secureCompare(sig, expected) ? token : null;
}

const sessionSeconds = () => config.sessionDays * 24 * 3600;

async function createSession(userId) {
  const token = newToken();
  const id = tokenHash(token);
  await exec(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [id, userId, isoToDb(nowIso()), isoToDb(new Date(Date.now() + sessionSeconds() * 1000).toISOString())],
  );
  return token;
}

export function sessionCookieHeader(token) {
  return cookieHeader(SESSION_COOKIE, packCookieValue(token), {
    secure: config.secureCookies,
    maxAgeSeconds: sessionSeconds(),
  });
}
export function clearSessionCookieHeader() {
  return cookieHeader(SESSION_COOKIE, '', { secure: config.secureCookies, maxAgeSeconds: 0 });
}

// ---- per-IP/email login throttling (in-memory; documented single-process) --
const loginAttempts = new Map(); // key -> { fails: number, firstAt: number, lockedUntil: number }
function throttleKey(req, email) {
  return `${clientIp(req)}|${String(email || '').toLowerCase().slice(0, 191)}`;
}
export function loginThrottleCheck(req, email) {
  const rec = loginAttempts.get(throttleKey(req, email));
  if (!rec) return { allowed: true };
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (now - rec.firstAt > config.rateLimit.loginWindowMs) loginAttempts.delete(throttleKey(req, email));
  return { allowed: true };
}
export function loginThrottleRecord(req, email, ok) {
  const key = throttleKey(req, email);
  if (ok) { loginAttempts.delete(key); return; }
  const now = Date.now();
  const rec = loginAttempts.get(key) || { fails: 0, firstAt: now, lockedUntil: 0 };
  if (now - rec.firstAt > config.rateLimit.loginWindowMs) { rec.fails = 0; rec.firstAt = now; }
  rec.fails += 1;
  if (rec.fails >= config.rateLimit.loginMax) {
    rec.lockedUntil = now + 15 * 60 * 1000;
    rec.fails = 0;
    rec.firstAt = now;
  }
  loginAttempts.set(key, rec);
}

// ---- user management -------------------------------------------------------
export async function findUserByEmail(email) {
  const row = await queryOne('SELECT id, email, password_hash FROM users WHERE email = ?', [String(email || '').toLowerCase()]);
  return row || null;
}
export async function getUserById(id) {
  return queryOne('SELECT id, email FROM users WHERE id = ?', [String(id)]);
}
export async function createUser(email, password) {
  const id = crypto.randomUUID();
  await exec('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
    id, String(email || '').toLowerCase(), password ? hashPassword(password) : null, nowDb(),
  ]);
  return { id, email: String(email || '').toLowerCase() };
}
export async function setUserPassword(userId, password) {
  await exec('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), userId]);
  // Rotating a password kills all of that user's sessions.
  await exec('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

// Bootstrap the first user (the workspace owner) from OWNER_EMAIL/OWNER_PASSWORD
// — runs at startup when the users table is empty. Returns the user or null.
export async function provisionOwnerIfNeeded() {
  const row = await queryOne('SELECT id FROM users LIMIT 1');
  if (row) return null;
  if (!config.ownerEmail || !config.ownerPassword) {
    return null; // CLI (`npm run user:create`) is the other path — documented.
  }
  if (!config.ownerEmail.includes('@')) throw new Error('OWNER_EMAIL looks invalid');
  if (config.ownerPassword.length < 8) throw new Error('OWNER_PASSWORD must be at least 8 characters');
  const user = await createUser(config.ownerEmail, config.ownerPassword);
  log.info('first user (workspace owner) provisioned for', maskEmail(config.ownerEmail));
  return user;
}

// ---- request identity ------------------------------------------------------
// Returns { user:{id,email}, sessionId, renew } or null.
export async function sessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = unpackCookieValue(cookies[SESSION_COOKIE]);
  if (!token) return null;
  const id = tokenHash(token);
  const row = await queryOne(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    [id],
  );
  if (!row) return null;
  const expiresAt = row.expires_at ? new Date(String(row.expires_at).replace(' ', 'T') + 'Z').getTime() : 0;
  const now = Date.now();
  if (!expiresAt || expiresAt <= now) {
    await exec('DELETE FROM sessions WHERE id = ?', [id]);
    return null;
  }
  // Sliding renewal in the last 3 days of the session.
  const renew = expiresAt - now < 3 * 24 * 3600 * 1000;
  if (renew) {
    await exec('UPDATE sessions SET expires_at = ? WHERE id = ?', [
      isoToDb(new Date(now + sessionSeconds() * 1000).toISOString()), id,
    ]);
  }
  return { user: { id: String(row.id), email: String(row.email) }, sessionId: id, renew };
}

// Middleware-style resolver shared by all user routes.
// Returns { user, via } or sends a 401 and returns { responseSent: true }.
export async function requireUser(req, res, { touchLastSeen = false } = {}) {
  const session = await sessionFromRequest(req);
  if (!session) {
    sendJson(res, { error: 'not_authenticated' }, { status: 401 });
    return { responseSent: true };
  }
  if (session.renew) {
    // Renew cookie as well (fresh Max-Age)
    const token = parseCookies(req)[SESSION_COOKIE];
    const unpacked = token ? unpackCookieValue(token) : null;
    if (unpacked) res.setHeader('set-cookie', sessionCookieHeader(unpacked));
  }
  if (touchLastSeen) {
    exec('UPDATE users SET last_seen_at = ? WHERE id = ?', [nowDb(), session.user.id]).catch(() => {});
  }
  return { user: session.user, via: 'session' };
}

export async function login(req, email, password) {
  const user = await findUserByEmail(String(email || '').trim());
  // Always run a verify (constant shape against user-enumeration timing).
  const hashOk = verifyPassword(password, user && user.password_hash ? user.password_hash : null);
  if (!user) { log.info('login failed — no user for', maskEmail(String(email || '').trim())); return null; }
  if (!user.password_hash) { log.warn('login failed — no password set for', maskEmail(String(email || '').trim())); return null; }
  if (!hashOk) { log.info('login failed — password mismatch for', maskEmail(String(email || '').trim())); return null; }
  const token = await createSession(user.id);
  return { user: { id: String(user.id), email: String(user.email) }, token };
}

export async function logout(req) {
  const session = await sessionFromRequest(req);
  if (session) await exec('DELETE FROM sessions WHERE id = ?', [session.sessionId]);
}

export async function purgeExpiredSessions() {
  const res = await exec('DELETE FROM sessions WHERE expires_at <= ?', [nowDb()]);
  return res.affectedRows;
}

// ---- invite-aware signup ---------------------------------------------------
// POST /api/invites/signup-claim uses this: creates the account and claims the
// invite in ONE transaction so an advisor link is single-step.
// Failure at ANY step rolls back — no orphan users, no half-claimed invites.
class InviteError extends Error {
  constructor(error, status) { super(error); this.inviteError = error; this.inviteStatus = status; }
}

export async function signupAndClaim({ email, password, token }) {
  const existing = await findUserByEmail(email);
  if (existing) return { error: 'email_registered', status: 409 };

  // Cheap pre-check (re-verified under a row lock inside the transaction).
  const pre = await queryOne(
    'SELECT token, owner_user_id, expires_at, claimed_by_user_id FROM growth_hub_invites WHERE token = ?',
    [token],
  );
  if (!pre) return { error: 'invite_not_found', status: 404 };
  if (pre.claimed_by_user_id) return { error: 'invite_already_claimed', status: 409 };
  const preIso = dbToIso(pre.expires_at);
  if (preIso && preIso <= nowIso()) return { error: 'invite_expired', status: 410 };

  try {
    return await inTransaction(async (tx) => {
      const invite = await tx.one(
        'SELECT token, owner_user_id, expires_at, claimed_by_user_id FROM growth_hub_invites WHERE token = ? FOR UPDATE',
        [token],
      );
      if (!invite) throw new InviteError('invite_not_found', 404);
      if (invite.claimed_by_user_id) throw new InviteError('invite_already_claimed', 409);
      const inviteIso = dbToIso(invite.expires_at);
      if (inviteIso && inviteIso <= nowIso()) throw new InviteError('invite_expired', 410);

      const newUser = { id: crypto.randomUUID(), email: String(email).toLowerCase() };
      const now = nowDb();
      await tx.exec('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
        newUser.id, newUser.email, hashPassword(password), now,
      ]);

      const ownerId = String(invite.owner_user_id);
      if (ownerId !== newUser.id) {
        await tx.exec(
          `INSERT INTO growth_hub_members (owner_user_id, user_id, email, role, created_at, revoked_at)
           VALUES (?, ?, ?, 'advisor', ?, NULL)
           ON DUPLICATE KEY UPDATE revoked_at = NULL, email = VALUES(email)`,
          [ownerId, newUser.id, newUser.email, now],
        );
      }
      await tx.exec('UPDATE growth_hub_invites SET claimed_by_user_id = ?, claimed_at = ? WHERE token = ?', [
        newUser.id, now, token,
      ]);
      return { user: newUser, role: ownerId === newUser.id ? 'owner' : 'advisor', owner_user_id: ownerId };
    });
  } catch (err) {
    if (err instanceof InviteError) return { error: err.inviteError, status: err.inviteStatus };
    if (err && err.code === 'duplicate_key') return { error: 'email_registered', status: 409 };
    throw err;
  }
}
