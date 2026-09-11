// GET /api/bot/clips — list legacy clip objects (key + size) for the bot's
// cleanup/verification jobs. Auth: bot bearer token.
import { json } from '../../_lib/http.js';
import { botAuth } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const gate = botAuth(context.request, context.env);
  if (gate.response) return gate.response;
  if (!context.env.CLIPS) {
    return json({ error: 'storage_not_configured', detail: 'R2 binding CLIPS is not configured.' }, { status: 503 });
  }
  const listed = await context.env.CLIPS.list({ limit: 1000 });
  const objects = listed.objects || [];
  return json({
    count: objects.length,
    bytes: objects.reduce((sum, o) => sum + (o.size || 0), 0),
    truncated: Boolean(listed.truncated),
    keys: objects.map(o => ({ key: o.key, size: o.size || 0 })),
  });
}
