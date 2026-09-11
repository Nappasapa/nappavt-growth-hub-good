// /api/state — the dashboard state blob (replaces the `dashboard_state` table
// reads/upserts the frontend did through supabase-js).
//
// GET  /api/state?since=<iso>  → { state, updated_at } or { unchanged:true, updated_at }
// PUT  /api/state              → { ok, updated_at } (owner only; optimistic
//                                 concurrency via base_updated_at → 409 on conflict)
//
// `since` is the polymark dance that saves the egress: unchanged polls and
// save-preflights return ~40 bytes instead of the whole dashboard blob.

import { json, readJson, nowIso } from '../_lib/http.js';
import { resolveIdentity } from '../_lib/auth.js';
import { resolveAccess } from '../_lib/workspace.js';

const MAX_STATE_BYTES = 25 * 1024 * 1024;

async function workspaceForWrite(env, user) {
  const access = await resolveAccess(env, user);
  return access.role === 'owner' ? user.id : null;
}

async function workspaceForRead(env, user) {
  const access = await resolveAccess(env, user);
  if (access.role === 'owner') return user.id;
  if (access.role === 'advisor') return access.owner_user_id;
  return null;
}

export async function onRequestGet(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const ownerId = await workspaceForRead(context.env, auth.user);
  if (!ownerId) return json({ error: 'no_access' }, { status: 403 });

  const since = new URL(context.request.url).searchParams.get('since') || '';
  const row = await context.env.DB.prepare(
    'SELECT state, updated_at FROM dashboard_state WHERE user_id = ?',
  ).bind(ownerId).first();

  if (!row) return json({ state: null, updated_at: null });
  // ISO-8601 UTC strings compare lexicographically.
  if (since && String(row.updated_at) <= since) {
    return json({ unchanged: true, updated_at: row.updated_at });
  }
  let state = null;
  try { state = JSON.parse(row.state); } catch { state = null; }
  return json({ state, updated_at: row.updated_at });
}

export async function onRequestPut(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const ownerId = await workspaceForWrite(context.env, auth.user);
  if (!ownerId) return json({ error: 'owner_only' }, { status: 403 });

  const body = await readJson(context.request, MAX_STATE_BYTES + 64 * 1024);
  if (body.response) return body.response;
  const { state, base_updated_at: base } = body.value || {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return json({ error: 'invalid_state' }, { status: 400 });
  }
  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_STATE_BYTES) {
    return json({ error: 'state_too_large' }, { status: 413 });
  }

  // Optimistic concurrency: if the caller names the revision they based their
  // edit on and the stored row has moved, refuse with the current value so the
  // client can merge bot-controlled fields and retry (mirrors the previous
  // client-side preflight, now enforced server-side).
  if (typeof base === 'string' && base) {
    const current = await context.env.DB.prepare(
      'SELECT state, updated_at FROM dashboard_state WHERE user_id = ?',
    ).bind(ownerId).first();
    if (current && String(current.updated_at) !== base) {
      let currentState = null;
      try { currentState = JSON.parse(current.state); } catch { currentState = null; }
      return json({ error: 'conflict', updated_at: current.updated_at, state: currentState }, { status: 409 });
    }
  }

  const updatedAt = nowIso();
  await context.env.DB.prepare(
    `INSERT INTO dashboard_state (user_id, state, updated_at, state_bytes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at,
       state_bytes = excluded.state_bytes`,
  ).bind(ownerId, serialized, updatedAt, serialized.length).run();

  return json({ ok: true, updated_at: updatedAt });
}
