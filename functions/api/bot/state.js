// /api/bot/state — drop-in data channel for Nappa Bot (replaces its direct
// Supabase `dashboard_state` access). Auth: X-Nappa-Bot-Key header or
// Authorization: Bearer <BOT_SYNC_TOKEN>.
//
// GET /api/bot/state?user_id=<owner>&since=<iso> → { state, updated_at } |
//                                                   { unchanged:true, updated_at }
// PUT /api/bot/state  { user_id, state }          → { ok, updated_at } (server timestamp)
//
// The bot should poll /api/bot/state/revision and only download the blob when
// it actually changed — the old read-modify-everything loop is what burned
// Supabase egress.

import { json, readJson, nowIso } from '../../_lib/http.js';
import { botAuth } from '../../_lib/auth.js';

const MAX_STATE_BYTES = 25 * 1024 * 1024;

async function knownOwner(env, userId) {
  if (!userId) return null;
  const row = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  return row ? String(row.id) : null;
}

export async function onRequestGet(context) {
  const gate = botAuth(context.request, context.env);
  if (gate.response) return gate.response;

  const url = new URL(context.request.url);
  const ownerId = await knownOwner(context.env, url.searchParams.get('user_id') || '');
  if (!ownerId) return json({ error: 'unknown_user' }, { status: 400 });

  const since = url.searchParams.get('since') || '';
  const row = await context.env.DB.prepare(
    'SELECT state, updated_at FROM dashboard_state WHERE user_id = ?',
  ).bind(ownerId).first();
  if (!row) return json({ state: null, updated_at: null });
  if (since && String(row.updated_at) <= since) {
    return json({ unchanged: true, updated_at: row.updated_at });
  }
  let state = null;
  try { state = JSON.parse(row.state); } catch { state = null; }
  return json({ state, updated_at: row.updated_at });
}

export async function onRequestPut(context) {
  const gate = botAuth(context.request, context.env);
  if (gate.response) return gate.response;

  const body = await readJson(context.request, MAX_STATE_BYTES + 64 * 1024);
  if (body.response) return body.response;
  const { user_id: userId, state } = body.value || {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return json({ error: 'invalid_state' }, { status: 400 });
  }
  const ownerId = await knownOwner(context.env, String(userId || ''));
  if (!ownerId) return json({ error: 'unknown_user' }, { status: 400 });

  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_STATE_BYTES) return json({ error: 'state_too_large' }, { status: 413 });

  const updatedAt = nowIso();
  await context.env.DB.prepare(
    `INSERT INTO dashboard_state (user_id, state, updated_at, state_bytes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at,
       state_bytes = excluded.state_bytes`,
  ).bind(ownerId, serialized, updatedAt, serialized.length).run();

  console.log('[growth-hub] bot state write for owner', ownerId, '·', serialized.length, 'bytes');
  return json({ ok: true, updated_at: updatedAt });
}
