// /api/bot/* — the Nappa Bot's data channel. Contract preserved so the bot's
// client code keeps working against any deployment, old or new:
//
// GET /api/bot/state/revision?user_id=<owner>      → { user_id, state_updated_at }
// GET /api/bot/state?user_id=<owner>&since=<iso>   → { state, updated_at } | { unchanged:true, updated_at }
// PUT /api/bot/state  { user_id, state }           → { ok, updated_at } (server timestamp)
// GET /api/bot/clips                               → { count, bytes, truncated, keys:[{key,size}] }
// GET /api/bot/clips/<key>                         → object bytes (no-store)
// DELETE /api/bot/clips/<key>                      → { ok:true } (idempotent)
// PUT /api/bot/clips/<key>                         → { ok:true, key, size } (migration/backup upload)
//
// Auth: X-Nappa-Bot-Key header or Authorization: Bearer <BOT_SYNC_TOKEN>.

import { sendJson, readJsonBody, secureCompare } from '../http.mjs';
import { config } from '../config.mjs';
import { queryOne, exec, nowIso, isoToDb, dbToIso } from '../db.mjs';
import {
  sanitizeClipKey, clipContentType, headClip, streamClip, deleteClip, listClips, ingestClipStream,
} from '../storage.mjs';
import { rateLimitCheck } from '../ratelimit.mjs';
import { clientIp } from '../http.mjs';
import { log } from '../log.mjs';

export const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// Gate every bot request. Returns true if the response was already sent.
function botGate(req, res) {
  const configured = config.botSyncToken;
  if (!configured) {
    sendJson(res, { error: 'bot_not_configured', detail: 'BOT_SYNC_TOKEN is not set on the server.' }, { status: 503 });
    return true;
  }
  const header = String(req.headers['x-nappa-bot-key'] || '').trim();
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = (header || (bearer && bearer[1]) || '').trim();
  if (!provided || !secureCompare(provided, configured)) {
    sendJson(res, { error: 'not_authorized' }, { status: 401 });
    return true;
  }
  const limit = rateLimitCheck(`bot:${clientIp(req)}`, {
    windowMs: config.rateLimit.botWindowMs, max: config.rateLimit.botMax,
  });
  if (!limit.allowed) {
    sendJson(res, { error: 'rate_limited', retry_after_seconds: limit.retryAfterSeconds }, { status: 429 });
    return true;
  }
  return false;
}

async function knownOwner(userId) {
  if (!userId) return null;
  const row = await queryOne('SELECT id FROM users WHERE id = ?', [String(userId)]);
  return row ? String(row.id) : null;
}

route('GET', '/api/bot/state/revision', async ({ req, res, url }) => {
  if (botGate(req, res)) return;
  const userId = url.searchParams.get('user_id') || '';
  const row = await queryOne('SELECT updated_at FROM dashboard_state WHERE user_id = ?', [String(userId)]);
  return sendJson(res, {
    user_id: userId || null,
    state_updated_at: row && row.updated_at ? String(dbToIso(row.updated_at) || '') : '',
  });
});

route('GET', '/api/bot/state', async ({ req, res, url }) => {
  if (botGate(req, res)) return;
  const ownerId = await knownOwner(url.searchParams.get('user_id') || '');
  if (!ownerId) return sendJson(res, { error: 'unknown_user' }, { status: 400 });

  const since = url.searchParams.get('since') || '';
  const row = await queryOne('SELECT state, updated_at FROM dashboard_state WHERE user_id = ?', [ownerId]);
  if (!row) return sendJson(res, { state: null, updated_at: null });
  const updatedIso = dbToIso(row.updated_at);
  if (since && updatedIso && updatedIso <= since) {
    return sendJson(res, { unchanged: true, updated_at: updatedIso });
  }
  let state = null;
  try { state = JSON.parse(row.state); } catch { state = null; }
  return sendJson(res, { state, updated_at: updatedIso });
});

route('PUT', '/api/bot/state', async ({ req, res }) => {
  if (botGate(req, res)) return;
  const body = await readJsonBody(req, config.maxStateBytes + 64 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const { user_id: userId, state } = body.value || {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return sendJson(res, { error: 'invalid_state' }, { status: 400 });
  }
  const ownerId = await knownOwner(String(userId || ''));
  if (!ownerId) return sendJson(res, { error: 'unknown_user' }, { status: 400 });

  const serialized = JSON.stringify(state);
  if (serialized.length > config.maxStateBytes) return sendJson(res, { error: 'state_too_large' }, { status: 413 });

  const updatedAt = nowIso();
  await exec(
    `INSERT INTO dashboard_state (user_id, state, state_bytes, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), state_bytes = VALUES(state_bytes), updated_at = VALUES(updated_at)`,
    [ownerId, serialized, serialized.length, isoToDb(updatedAt)],
  );
  log.info('bot state write for owner', ownerId, '·', serialized.length, 'bytes');
  return sendJson(res, { ok: true, updated_at: updatedAt });
});

route('GET', '/api/bot/clips', async ({ req, res }) => {
  if (botGate(req, res)) return;
  const { objects, truncated } = await listClips({ limit: 1000 });
  return sendJson(res, {
    count: objects.length,
    bytes: objects.reduce((sum, o) => sum + (o.size || 0), 0),
    truncated: Boolean(truncated),
    keys: objects.map(o => ({ key: o.key, size: o.size || 0 })),
  });
});

route('GET', '/api/bot/clips/*', async ({ req, res, params }) => {
  if (botGate(req, res)) return;
  const key = sanitizeClipKey(String(params.rest || ''));
  if (!key) return sendJson(res, { error: 'invalid_key' }, { status: 400 });
  const head = await headClip(key);
  if (!head) return sendJson(res, { error: 'not_found' }, { status: 404 });
  res.writeHead(200, {
    'content-type': clipContentType(key),
    'content-length': String(head.size),
    'cache-control': 'private, no-store',
  });
  return streamClip(key).pipe(res);
});

route('PUT', '/api/bot/clips/*', async ({ req, res, params }) => {
  if (botGate(req, res)) return;
  const key = sanitizeClipKey(String(params.rest || ''));
  if (!key) return sendJson(res, { error: 'invalid_key' }, { status: 400 });
  const result = await ingestClipStream(key, req, { maxBytes: config.maxUploadBytes });
  log.info('bot clip upload:', key.split('/').pop(), '·', result.size, 'bytes');
  return sendJson(res, { ok: true, key: result.key, size: result.size });
});

route('DELETE', '/api/bot/clips/*', async ({ req, res, params }) => {
  if (botGate(req, res)) return;
  const key = sanitizeClipKey(String(params.rest || ''));
  if (!key) return sendJson(res, { error: 'invalid_key' }, { status: 400 });
  await deleteClip(key);
  log.info('bot deleted clip:', key.split('/').pop());
  return sendJson(res, { ok: true });
});
