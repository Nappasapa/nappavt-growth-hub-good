// Shared HTTP helpers for the Growth Hub Pages Functions.
// No external dependencies — runs on the Workers runtime.

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  // Private API responses must never be shared-cached.
  if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function randomToken(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// Reads and parses a JSON request body with a hard size cap.
// Returns {ok:true,value} or {ok:false,response}.
export async function readJson(request, limitBytes = 256 * 1024) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > limitBytes) {
    return { ok: false, response: json({ error: 'payload_too_large' }, { status: 413 }) };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ error: 'invalid_body' }, { status: 400 }) };
  }
  if (text.length > limitBytes * 2) {
    return { ok: false, response: json({ error: 'payload_too_large' }, { status: 413 }) };
  }
  try {
    return { ok: true, value: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, response: json({ error: 'invalid_json' }, { status: 400 }) };
  }
}

// Constant-time string comparison (works on Workers and Node).
export function secureCompare(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const ea = new TextEncoder().encode(sa);
  const eb = new TextEncoder().encode(sb);
  const max = Math.max(ea.length, eb.length, 1);
  let diff = ea.length === eb.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    diff |= (ea[i % ea.length] || 0) ^ (eb[i % eb.length] || 0);
  }
  return diff === 0 && sa === sb;
}

// Validates an R2 object key built from dashboard clip paths.
// Legacy format: "<userId>/<epoch>_<rand>_<sanitized-name>.<ext>".
export function sanitizeClipKey(raw) {
  const key = String(raw || '').replace(/\\/g, '/');
  if (!key || key.length > 600) return null;
  if (key.startsWith('/') || key.endsWith('/')) return null;
  if (key.split('/').some(seg => !seg || seg === '.' || seg === '..')) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return null;
  return key;
}

export function methodNotAllowed() {
  return json({ error: 'method_not_allowed' }, { status: 405 });
}
