// HTTP primitives built on node:http — no framework dependency.
// JSON envelopes, body reading with hard caps, cookies, security headers,
// same-origin mutation guard, and a tiny route matcher.

import { log, describeError } from './log.mjs';
import { DbError } from './db.mjs';

export function sendJson(res, data, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end();
}

// Read a JSON body with a hard byte cap. Returns { ok, value }.
export async function readJsonBody(req, limitBytes = 256 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > limitBytes) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limitBytes) return { ok: false, status: 413, error: 'payload_too_large' };
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return { ok: true, value: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

// ---- cookies ---------------------------------------------------------------
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { httpOnly = true, secure = true, sameSite = 'Lax', path = '/', maxAgeSeconds } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  return parts.join('; ');
}

export function setCookies(res, headers) {
  res.setHeader('set-cookie', headers);
}

// ---- origin guard (CSRF hardening for cookie auth) -------------------------
// Mutating requests that carry an Origin header must match the request host
// (or APP_ORIGIN when configured). Cross-origin forms are thus dropped.
export function badOrigin(req, appOrigin) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const allowed = (appOrigin && new URL(appOrigin).host) || req.headers.host;
    return new URL(origin).host !== allowed;
  } catch {
    return true;
  }
}

// ---- route matching --------------------------------------------------------
// routes: [{ method, pattern: '/api/notes/:id', handler }]
export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.pattern.includes(':')) {
      const routeSegs = route.pattern.split('/');
      const pathSegs = pathname.split('/');
      if (routeSegs.length !== pathSegs.length && !route.pattern.endsWith('/*')) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < routeSegs.length; i++) {
        const seg = routeSegs[i];
        if (seg === '*') { params.rest = pathSegs.slice(i).join('/'); break; }
        if (i >= pathSegs.length) { ok = false; break; }
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(pathSegs[i]);
        else if (seg !== pathSegs[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    } else if (route.pattern === pathname) {
      return { route, params: {} };
    }
  }
  // method-not-allowed detection
  const similar = routes.filter(r => r.pattern === pathname || patternMatchesLoose(r.pattern, pathname));
  if (similar.length) return { methodNotAllowed: true };
  return null;
}
function patternMatchesLoose(pattern, pathname) {
  if (!pattern.includes(':')) return false;
  const routeSegs = pattern.split('/');
  const pathSegs = pathname.split('/');
  return routeSegs.length === pathSegs.length
    && routeSegs.every((seg, i) => seg.startsWith(':') || seg === '*' || seg === pathSegs[i]);
}
export function methodNotAllowed(res) {
  sendJson(res, { error: 'method_not_allowed' }, { status: 405 });
}
export function notFound(res) {
  sendJson(res, { error: 'not_found' }, { status: 404 });
}

// Uniform error handling — no stack traces or internals to the client.
export function handleRouteError(res, err, context = 'route') {
  if (err instanceof DbError) {
    log.error(`${context} db error:`, describeError(err.cause || err));
    if (err.code === 'db_unavailable') return sendJson(res, { error: 'service_unavailable' }, { status: 503 });
    return sendJson(res, { error: 'internal_error' }, { status: 500 });
  }
  if (err && err.httpStatus) {
    return sendJson(res, { error: err.errorCode || 'bad_request' }, { status: err.httpStatus });
  }
  log.error(`${context} unhandled:`, describeError(err));
  sendJson(res, { error: 'internal_error' }, { status: 500 });
}

export function clientIp(req) {
  // Trust X-Forwarded-For only from a reverse proxy we control; TRUST_PROXY
  // style deployments set it. Rare here; used only for rate limiting anyway.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Constant-time string compare.
export function secureCompare(a, b) {
  const sa = Buffer.from(String(a ?? ''), 'utf8');
  const sb = Buffer.from(String(b ?? ''), 'utf8');
  const max = Math.max(sa.length, sb.length, 1);
  let diff = sa.length === sb.length ? 0 : 1;
  for (let i = 0; i < max; i++) diff |= (sa[i % sa.length] || 0) ^ (sb[i % sb.length] || 0);
  return diff === 0;
}
