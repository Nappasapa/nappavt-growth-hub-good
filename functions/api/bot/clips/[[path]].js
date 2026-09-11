// /api/bot/clips/<key...> — the bot's replacement for its Supabase Storage
// access (downloads for the posting pipeline, deletes for auto-cleanup).
// Auth: bot bearer token. Key format still validated, but the bot may act on
// any object (it used the service-role key before).

import { json, sanitizeClipKey } from '../../../_lib/http.js';
import { botAuth } from '../../../_lib/auth.js';

function unauthorizedStorage() {
  return json({ error: 'storage_not_configured', detail: 'R2 binding CLIPS is not configured.' }, { status: 503 });
}

export async function onRequestGet(context) {
  const gate = botAuth(context.request, context.env);
  if (gate.response) return gate.response;
  if (!context.env.CLIPS) return unauthorizedStorage();
  const key = sanitizeClipKey((context.params.path || []).join('/'));
  if (!key) return json({ error: 'invalid_key' }, { status: 400 });
  const object = await context.env.CLIPS.get(key);
  if (!object) return json({ error: 'not_found' }, { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': (object.httpMetadata && object.httpMetadata.contentType) || 'application/octet-stream',
      'content-length': String(object.size),
      'cache-control': 'private, no-store',
    },
  });
}

export async function onRequestDelete(context) {
  const gate = botAuth(context.request, context.env);
  if (gate.response) return gate.response;
  if (!context.env.CLIPS) return unauthorizedStorage();
  const key = sanitizeClipKey((context.params.path || []).join('/'));
  if (!key) return json({ error: 'invalid_key' }, { status: 400 });
  await context.env.CLIPS.delete(key);
  console.log('[growth-hub] bot deleted clip:', key.split('/').pop());
  return json({ ok: true });
}
