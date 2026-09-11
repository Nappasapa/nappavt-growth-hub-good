// Cloudflare Access authentication for the Growth Hub.
//
// Production identity: the Cloudflare Access JWT. Validated locally in this
// Function with the team's JWKS (WebCrypto, no external deps):
//   - token from `Cf-Access-Jwt-Assertion` header, else `CF_Authorization` cookie
//   - RS256 signature verified against https://<team>/cdn-cgi/access/certs
//   - issuer = https://<team domain>, audience = ACCESS_AUD, exp honored
//
// Local development identity: DEV_BYPASS_EMAIL (from .dev.vars), honored ONLY
// when ACCESS_TEAM_DOMAIN is unset, so a misconfigured production deployment
// can never silently fall back to the bypass.
//
// Bot identity (separate code path): bearer BOT_SYNC_TOKEN, see botAuth().

import { json, nowIso, newId, secureCompare } from './http.js';

const jwksCache = new Map(); // teamDomain -> { keys: Map<kid, CryptoKey>, fetchedAt: number }
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlJson(input) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

function extractToken(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === 'CF_Authorization') {
      const value = part.slice(eq + 1).trim();
      if (value) return value;
    }
  }
  return null;
}

async function getSigningKey(teamDomain, kid, allowRefresh = true) {
  let entry = jwksCache.get(teamDomain);
  if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS || !entry.keys.has(kid)) {
    if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS || allowRefresh) {
      const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300 } });
      if (!res.ok) throw new Error('jwks_fetch_failed');
      const body = await res.json();
      const keys = new Map();
      for (const jwk of body.keys || []) {
        if (jwk.kty !== 'RSA' || !jwk.kid) continue;
        try {
          const key = await crypto.subtle.importKey(
            'jwk',
            { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          );
          keys.set(jwk.kid, key);
        } catch {
          // skip malformed keys
        }
      }
      entry = { keys, fetchedAt: Date.now() };
      jwksCache.set(teamDomain, entry);
    }
  }
  const key = entry && entry.keys.get(kid);
  if (!key && allowRefresh) {
    jwksCache.delete(teamDomain);
    return getSigningKey(teamDomain, kid, false);
  }
  return key || null;
}

// Verifies a Cloudflare Access JWT. Returns the payload (with .email) or null.
export async function verifyAccessJwt(token, teamDomain, aud) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const header = b64urlJson(parts[0]);
    if (!header || header.alg !== 'RS256' || !header.kid) return null;
    const key = await getSigningKey(teamDomain, header.kid);
    if (!key) return null;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data);
    if (!ok) return null;
    const payload = b64urlJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now - 60 >= payload.exp) return null;
    if (typeof payload.nbf === 'number' && now + 60 < payload.nbf) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (!payload.email || typeof payload.email !== 'string') return null;
    return payload;
  } catch (err) {
    console.warn('[growth-hub] access JWT verification failed:', err && err.message ? err.message : 'invalid');
    return null;
  }
}

// Resolves the authenticated end user for a request.
// Mutates D1: creates the users row on first sight, refreshes last_seen_at.
// Returns { user: {id,email}, via } or { response } (error Response to send).
export async function resolveIdentity(request, env, { touchLastSeen = false } = {}) {
  if (!env.DB) {
    return { response: json({ error: 'missing_binding', detail: 'D1 binding DB is not configured.' }, { status: 503 }) };
  }
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = (env.ACCESS_AUD || '').trim();
  let email = null;

  if (teamDomain && aud) {
    const token = extractToken(request);
    if (!token) return { response: json({ error: 'not_authenticated' }, { status: 401 }) };
    const payload = await verifyAccessJwt(token, teamDomain, aud);
    if (!payload) return { response: json({ error: 'not_authenticated' }, { status: 401 }) };
    email = payload.email;
  } else if ((env.DEV_BYPASS_EMAIL || '').trim()) {
    // Local development only — .dev.vars is never deployed, and this branch is
    // unreachable in production once ACCESS_TEAM_DOMAIN/ACCESS_AUD are set.
    // X-Dev-Identity-Email lets local tests act as different users (advisor flows).
    const asOther = request.headers.get('x-dev-identity-email') || '';
    email = (asOther || env.DEV_BYPASS_EMAIL).trim();
  } else {
    return {
      response: json(
        { error: 'auth_not_configured', detail: 'ACCESS_TEAM_DOMAIN / ACCESS_AUD are not configured on the Pages project.' },
        { status: 503 },
      ),
    };
  }

  email = String(email).trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes('@')) {
    return { response: json({ error: 'invalid_identity' }, { status: 400 }) };
  }

  let user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    const id = newId();
    await env.DB.prepare('INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .bind(id, email, nowIso(), nowIso())
      .run();
    user = { id, email };
    console.log('[growth-hub] new user row created for', maskEmail(email));
  } else if (touchLastSeen) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  }
  return { user: { id: String(user.id), email: String(user.email) }, via: teamDomain && aud ? 'access' : 'dev' };
}

// Bot / server-to-server auth: shared secret bearer token.
export function botAuth(request, env) {
  const configured = (env.BOT_SYNC_TOKEN || '').trim();
  if (!configured) {
    return { response: json({ error: 'bot_not_configured', detail: 'BOT_SYNC_TOKEN secret is not set.' }, { status: 503 }) };
  }
  const header = request.headers.get('x-nappa-bot-key') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  const provided = (header || (bearer && bearer[1]) || '').trim();
  if (!provided || !secureCompare(provided, configured)) {
    return { response: json({ error: 'not_authorized' }, { status: 401 }) };
  }
  return { ok: true };
}

export function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${(name || '').slice(0, 2)}***@${domain}`;
}
