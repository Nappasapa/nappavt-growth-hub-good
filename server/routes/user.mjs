// User + auth routes: /api/health, /api/me, /api/access/status,
// /api/auth/login, /api/auth/logout, /api/invites/signup-claim.

import { sendJson, readJsonBody } from '../http.mjs';
import { pingDb, dbToIso, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import {
  requireUser, login, logout, loginThrottleCheck, loginThrottleRecord,
  signupAndClaim, hashPassword, sessionCookieHeader as makeSessionCookie,
  clearSessionCookieHeader,
} from '../auth.mjs';
import { resolveAccess } from '../workspace.mjs';
import { log } from '../log.mjs';

export const routes = [];

const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', '/api/health', async ({ res }) => {
  // Public probe: reveals only API liveness + DB reachability — never
  // credentials, error details or schema info.
  let dbOk = false;
  try {
    dbOk = await pingDb();
  } catch { /* unreachable */ }
  return sendJson(res, {
    ok: dbOk,
    service: 'nappavt-growth-hub-api',
    db: dbOk,
    session_auth: true,
    time: nowIso(),
  }, { status: dbOk ? 200 : 503 });
});

route('GET', '/api/me', async ({ req, res }) => {
  const auth = await requireUser(req, res, { touchLastSeen: true });
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  return sendJson(res, {
    id: auth.user.id,
    email: auth.user.email,
    role: access.role,
    owner_user_id: access.owner_user_id,
    via: auth.via,
  });
});

route('GET', '/api/access/status', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  return sendJson(res, { role: access.role, owner_user_id: access.owner_user_id });
});

route('POST', '/api/auth/login', async ({ req, res }) => {
  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const email = String(body.value?.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(body.value?.password || '');
  if (!email || !email.includes('@') || password.length < 1) {
    return sendJson(res, { error: 'invalid_login_input' }, { status: 400 });
  }
  const gate = loginThrottleCheck(req, email);
  if (!gate.allowed) {
    return sendJson(res, { error: 'rate_limited', retry_after_seconds: gate.retryAfterSeconds }, { status: 429 });
  }
  try {
    const result = await login(req, email, password);
    loginThrottleRecord(req, email, Boolean(result));
    if (!result) return sendJson(res, { error: 'invalid_credentials' }, { status: 401 });
    res.setHeader('set-cookie', makeSessionCookie(result.token));
    return sendJson(res, { ok: true, user: result.user, via: 'session' });
  } catch (err) {
    log.error('login failed:', err.message);
    return sendJson(res, { error: 'internal_error' }, { status: 500 });
  }
});

route('POST', '/api/auth/logout', async ({ req, res }) => {
  try {
    await logout(req);
  } catch { /* session may already be gone */ }
  res.setHeader('set-cookie', clearSessionCookieHeader());
  return sendJson(res, { ok: true });
});

const weakPassword = pwd => String(pwd || '').length < 8
  ? 'Password must be at least 8 characters.' : null;

// Single-step advisor onboarding: create account + claim invite + session.
route('POST', '/api/invites/signup-claim', async ({ req, res }) => {
  const body = await readJsonBody(req, 8 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const token = String(body.value?.token || '').trim();
  const email = String(body.value?.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(body.value?.password || '');
  if (!token || token.length > 128 || token.length < 16) {
    return sendJson(res, { error: 'invalid_token' }, { status: 400 });
  }
  if (!email || !email.includes('@')) return sendJson(res, { error: 'invalid_email' }, { status: 400 });
  const weak = weakPassword(password);
  if (weak) return sendJson(res, { error: 'weak_password', detail: weak }, { status: 400 });

  const gate = loginThrottleCheck(req, email); // same throttle pool as login
  if (!gate.allowed) {
    return sendJson(res, { error: 'rate_limited', retry_after_seconds: gate.retryAfterSeconds }, { status: 429 });
  }

  const result = await signupAndClaim({ email, password, token });
  if (result.error) {
    loginThrottleRecord(req, email, false);
    return sendJson(res, { error: result.error }, { status: result.status });
  }
  loginThrottleRecord(req, email, true);
  const session = await login(req, email, password);
  if (!session) return sendJson(res, { error: 'internal_error' }, { status: 500 });
  res.setHeader('set-cookie', makeSessionCookie(session.token));
  log.info('advisor account created + invite claimed for owner', result.owner_user_id);
  return sendJson(res, { ok: true, user: session.user, role: result.role, owner_user_id: result.owner_user_id });
});

// hashPassword is re-exported for the CLI; referenced here to keep tree whole.
export { hashPassword };
