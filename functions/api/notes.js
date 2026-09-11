// /api/notes — advisor feedback notes (replaces growth_hub_advisor_notes).
// GET  → latest 100 notes for the caller's workspace (owner or advisor)
// POST → create a note (advisors only, exactly like the previous RLS policy)
import { json, readJson, nowIso, newId } from '../_lib/http.js';
import { resolveIdentity } from '../_lib/auth.js';
import { resolveAccess } from '../_lib/workspace.js';

const ALLOWED_TYPES = new Set(['general', 'stream', 'clip', 'analytics', 'idea']);

async function workspaceForRead(env, user) {
  const access = await resolveAccess(env, user);
  if (access.role === 'owner') return { access, ownerId: user.id };
  if (access.role === 'advisor') return { access, ownerId: access.owner_user_id };
  return { access, ownerId: null };
}

export async function onRequestGet(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const { ownerId } = await workspaceForRead(context.env, auth.user);
  if (!ownerId) return json({ error: 'no_access' }, { status: 403 });

  const rows = await context.env.DB.prepare(
    `SELECT id, owner_user_id, author_user_id, author_email, target_type, target_ref, body, created_at, resolved_at
     FROM growth_hub_advisor_notes
     WHERE owner_user_id = ?
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(ownerId).all();
  return json({ notes: rows.results || [] });
}

export async function onRequestPost(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  if (access.role !== 'advisor' || !access.owner_user_id) {
    return json({ error: 'advisor_only' }, { status: 403 });
  }

  const body = await readJson(context.request, 8 * 1024);
  if (body.response) return body.response;
  const value = body.value || {};
  const targetType = ALLOWED_TYPES.has(value.target_type) ? value.target_type : 'general';
  const targetRef = String(value.target_ref || '').trim().slice(0, 200) || null;
  const noteBody = String(value.body || '').trim().slice(0, 2000);
  if (!noteBody) return json({ error: 'empty_body' }, { status: 400 });

  const id = newId();
  const createdAt = nowIso();
  await context.env.DB.prepare(
    `INSERT INTO growth_hub_advisor_notes
       (id, owner_user_id, author_user_id, author_email, target_type, target_ref, body, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(id, access.owner_user_id, auth.user.id, auth.user.email, targetType, targetRef, noteBody, createdAt).run();

  return json({ ok: true, id, created_at: createdAt });
}
