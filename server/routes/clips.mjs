// /api/clips — legacy clip objects on the storage driver (local disk by
// default). Same contract as before (was: Supabase Storage, then R2):
//
// GET    /api/clips            → { count, bytes, truncated, keys[] } (owner)
// GET    /api/clips/<key>      → streams the object (owner, Range supported)
// HEAD   /api/clips/<key>      → object metadata (owner)
// DELETE /api/clips/<key>      → removes the object (owner; legacy cleanup)
//
// Keys must start with the caller's own owner id.

import { sendJson, sendEmpty } from '../http.mjs';
import { requireUser } from '../auth.mjs';
import { resolveAccess } from '../workspace.mjs';
import {
  sanitizeClipKey, clipContentType, headClip, streamClip, deleteClip, listClips,
} from '../storage.mjs';
import { log } from '../log.mjs';

export const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function baseHeaders(key, size) {
  return {
    'content-type': clipContentType(key),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'content-disposition': 'inline',
    ...(size !== undefined ? { 'content-length': String(size) } : {}),
  };
}

async function ownerOnly(req, res) {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return null;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'owner') { sendJson(res, { error: 'owner_only' }, { status: 403 }); return null; }
  return auth;
}

function keyFromParams(params) {
  return sanitizeClipKey(String(params.rest || ''));
}

route('GET', '/api/clips', async ({ req, res }) => {
  const auth = await ownerOnly(req, res);
  if (!auth) return;
  const { objects, truncated } = await listClips({ limit: 1000 });
  return sendJson(res, {
    count: objects.length,
    bytes: objects.reduce((sum, o) => sum + (o.size || 0), 0),
    truncated: Boolean(truncated),
    keys: objects.slice(0, 500).map(o => o.key),
  });
});

route('GET', '/api/clips/*', async ({ req, res, params }) => {
  const auth = await ownerOnly(req, res);
  if (!auth) return;
  const key = keyFromParams(params);
  if (!key) return sendJson(res, { error: 'invalid_key' }, { status: 400 });
  if (key.split('/')[0] !== auth.user.id) return sendJson(res, { error: 'forbidden_key' }, { status: 403 });

  const head = await headClip(key);
  if (!head) return sendJson(res, { error: 'not_found' }, { status: 404 });

  const rangeHeader = String(req.headers.range || '').trim();
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const size = head.size;
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start;
      let end;
      if (m[1] === '') {
        const suffix = Math.min(parseInt(m[2], 10) || 0, size);
        start = size - suffix; end = size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
      }
      if (start <= end && start < size) {
        res.writeHead(206, {
          ...baseHeaders(key, end - start + 1),
          'content-range': `bytes ${start}-${end}/${size}`,
        });
        return streamClip(key, { offset: start, length: end - start + 1 }).pipe(res);
      }
    }
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(200, baseHeaders(key, head.size));
  return streamClip(key).pipe(res);
});

route('HEAD', '/api/clips/*', async ({ req, res, params }) => {
  const auth = await ownerOnly(req, res);
  if (!auth) return;
  const key = keyFromParams(params);
  if (!key) return sendJson(res, { error: 'invalid_key' }, { status: 400 });
  if (key.split('/')[0] !== auth.user.id) return sendJson(res, { error: 'forbidden_key' }, { status: 403 });
  const head = await headClip(key);
  if (!head) return sendEmpty(res, 404);
  return sendEmpty(res, 200, baseHeaders(key, head.size));
});

route('DELETE', '/api/clips/*', async ({ req, res, params }) => {
  const auth = await ownerOnly(req, res);
  if (!auth) return;
  const key = keyFromParams(params);
  if (!key) return sendJson(res, { error: 'invalid_key' }, { status: 400 });
  if (key.split('/')[0] !== auth.user.id) return sendJson(res, { error: 'forbidden_key' }, { status: 403 });
  await deleteClip(key); // idempotent
  log.info('clip deleted:', key.split('/').pop());
  return sendJson(res, { ok: true });
});
