// POST /api/invites — owner creates a 7-day advisor invite
// (replaces the `growth_hub_invites` table insert).
import { json, readJson, nowIso, randomToken } from '../_lib/http.js';
import { resolveIdentity } from '../_lib/auth.js';
import { resolveAccess } from '../_lib/workspace.js';

export async function onRequestPost(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  if (access.role !== 'owner') return json({ error: 'owner_only' }, { status: 403 });

  const body = await readJson(context.request, 4 * 1024);
  if (body.response) return body.response;
  const emailHint = String(body.value?.email_hint || '').trim().slice(0, 254) || null;

  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await context.env.DB.prepare(
    'INSERT INTO growth_hub_invites (token, owner_user_id, email_hint, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(token, auth.user.id, emailHint, expiresAt, nowIso()).run();

  return json({ token, expires_at: expiresAt });
}
