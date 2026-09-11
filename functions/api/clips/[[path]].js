// /api/clips[/<key...>] — legacy clip objects in R2 (replaces Supabase Storage
// "clips" bucket + createSignedUrl()).
//
// GET    /api/clips            → { count, bytes, truncated, keys[] } (owner)
// GET    /api/clips/<key>      → streams the object (owner, Range supported)
// HEAD   /api/clips/<key>      → object metadata (owner)
// DELETE /api/clips/<key>      → removes the object (owner; legacy cleanup)
//
// The bucket is private. Keys are validated and must start with the caller's
// own owner id (legacy objects are stored under "<owner_user_id>/...").

import { json, sanitizeClipKey } from '../../_lib/http.js';
import { resolveIdentity } from '../../_lib/auth.js';
import { resolveAccess } from '../../_lib/workspace.js';

function clipContentType(key, metadata) {
  if (metadata && metadata.contentType) return metadata.contentType;
  const ext = (key.split('.').pop() || '').toLowerCase();
  return {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    m4v: 'video/x-m4v', mp3: 'audio/mpeg', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  }[ext] || 'application/octet-stream';
}

function baseHeaders(key, object) {
  return {
    'content-type': clipContentType(key, object && object.httpMetadata),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'content-disposition': 'inline',
  };
}

async function ownerOnly(request, env) {
  const auth = await resolveIdentity(request, env);
  if (auth.response) return auth;
  const access = await resolveAccess(env, auth.user);
  if (access.role !== 'owner') return { response: json({ error: 'owner_only' }, { status: 403 }) };
  return auth;
}

function missingBucket() {
  return json({ error: 'storage_not_configured', detail: 'R2 binding CLIPS is not configured.' }, { status: 503 });
}

export async function onRequestGet(context) {
  const auth = await ownerOnly(context.request, context.env);
  if (auth.response) return auth.response;
  if (!context.env.CLIPS) return missingBucket();

  const segments = context.params.path || [];
  // Listing mode: /api/clips
  if (segments.length === 0) {
    const listed = await context.env.CLIPS.list({ limit: 1000 });
    const objects = listed.objects || [];
    return json({
      count: objects.length,
      bytes: objects.reduce((sum, o) => sum + (o.size || 0), 0),
      truncated: Boolean(listed.truncated),
      keys: objects.slice(0, 500).map(o => o.key),
    });
  }

  const key = sanitizeClipKey(segments.join('/'));
  if (!key) return json({ error: 'invalid_key' }, { status: 400 });
  if (key.split('/')[0] !== auth.user.id) return json({ error: 'forbidden_key' }, { status: 403 });

  const rangeHeader = context.request.headers.get('range');
  if (rangeHeader) {
    const head = await context.env.CLIPS.head(key);
    if (!head) return json({ error: 'not_found' }, { status: 404 });
    const size = head.size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start; let end;
      if (m[1] === '') {
        const suffix = Math.min(parseInt(m[2], 10) || 0, size);
        start = size - suffix; end = size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
      }
      if (start <= end && start < size) {
        const ranged = await context.env.CLIPS.get(key, { range: { offset: start, length: end - start + 1 } });
        if (ranged) {
          return new Response(ranged.body, {
            status: 206,
            headers: {
              ...baseHeaders(key, head),
              'content-range': `bytes ${start}-${end}/${size}`,
              'content-length': String(end - start + 1),
            },
          });
        }
      }
    }
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }

  const object = await context.env.CLIPS.get(key);
  if (!object) return json({ error: 'not_found' }, { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: { ...baseHeaders(key, object), 'content-length': String(object.size) },
  });
}

export async function onRequestHead(context) {
  const auth = await ownerOnly(context.request, context.env);
  if (auth.response) return auth.response;
  if (!context.env.CLIPS) return missingBucket();
  const key = sanitizeClipKey((context.params.path || []).join('/'));
  if (!key) return json({ error: 'invalid_key' }, { status: 400 });
  if (key.split('/')[0] !== auth.user.id) return json({ error: 'forbidden_key' }, { status: 403 });
  const head = await context.env.CLIPS.head(key);
  if (!head) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 200,
    headers: { ...baseHeaders(key, head), 'content-length': String(head.size) },
  });
}

export async function onRequestDelete(context) {
  const auth = await ownerOnly(context.request, context.env);
  if (auth.response) return auth.response;
  if (!context.env.CLIPS) return missingBucket();
  const key = sanitizeClipKey((context.params.path || []).join('/'));
  if (!key) return json({ error: 'invalid_key' }, { status: 400 });
  if (key.split('/')[0] !== auth.user.id) return json({ error: 'forbidden_key' }, { status: 403 });
  await context.env.CLIPS.delete(key); // idempotent in R2
  console.log('[growth-hub] clip deleted:', key.split('/').pop());
  return json({ ok: true });
}
