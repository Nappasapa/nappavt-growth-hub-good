// /api/state* — the dashboard state blob. Contract preserved from the previous
// backend: review-gated reads, since-short-circuit, optimistic concurrency.
//
// GET  /api/state?since=<iso>  → { state, updated_at } | { unchanged:true, updated_at }
// PUT  /api/state              → { ok, updated_at } | 409 { error:'conflict', updated_at, state }
// GET  /api/state/revision     → { role, owner_user_id, state_updated_at, notes_updated_at, members_updated_at }

import { sendJson, readJsonBody } from '../http.mjs';
import { queryOne, exec, nowDb, isoToDb, nowIso, dbToIso } from '../db.mjs';
import { config } from '../config.mjs';
import { requireUser } from '../auth.mjs';
import { resolveAccess } from '../workspace.mjs';
import { log } from '../log.mjs';

export const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function latestOf(...values) {
  return values.filter(Boolean).sort().pop() || '';
}

route('GET', '/api/state', async ({ req, res, url }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  const ownerId = access.role === 'owner' ? auth.user.id
    : access.role === 'advisor' ? access.owner_user_id : null;
  if (!ownerId) return sendJson(res, { error: 'no_access' }, { status: 403 });

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

route('PUT', '/api/state', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'owner') return sendJson(res, { error: 'owner_only' }, { status: 403 });

  const body = await readJsonBody(req, config.maxStateBytes + 64 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const { state, base_updated_at: base } = body.value || {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return sendJson(res, { error: 'invalid_state' }, { status: 400 });
  }
  const serialized = JSON.stringify(state);
  if (serialized.length > config.maxStateBytes) {
    return sendJson(res, { error: 'state_too_large' }, { status: 413 });
  }

  if (typeof base === 'string' && base) {
    const current = await queryOne('SELECT state, updated_at FROM dashboard_state WHERE user_id = ?', [auth.user.id]);
    const currentIso = current ? dbToIso(current.updated_at) : null;
    if (current && currentIso !== base) {
      let currentState = null;
      try { currentState = JSON.parse(current.state); } catch { currentState = null; }
      return sendJson(res, { error: 'conflict', updated_at: currentIso, state: currentState }, { status: 409 });
    }
  }

  const updatedAt = nowIso();
  await exec(
    `INSERT INTO dashboard_state (user_id, state, state_bytes, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), state_bytes = VALUES(state_bytes), updated_at = VALUES(updated_at)`,
    [auth.user.id, serialized, serialized.length, isoToDb(updatedAt)],
  );
  return sendJson(res, { ok: true, updated_at: updatedAt });
});

route('GET', '/api/state/revision', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);

  const out = {
    role: access.role,
    owner_user_id: access.owner_user_id,
    state_updated_at: '',
    notes_updated_at: '',
    members_updated_at: '',
  };
  if (access.role !== 'owner' && access.role !== 'advisor') {
    return sendJson(res, out); // revoked/none see their status but no markers
  }
  const ownerId = access.role === 'owner' ? auth.user.id : access.owner_user_id;

  const stateRow = await queryOne('SELECT updated_at FROM dashboard_state WHERE user_id = ?', [ownerId]);
  out.state_updated_at = stateRow && stateRow.updated_at ? String(dbToIso(stateRow.updated_at) || '') : '';

  const notesRow = await queryOne(
    `SELECT MAX(created_at) AS c, MAX(COALESCE(resolved_at, '')) AS r
     FROM growth_hub_advisor_notes WHERE owner_user_id = ?`,
    [ownerId],
  );
  out.notes_updated_at = notesRow ? latestOf(dbToIso(notesRow.c), dbToIso(notesRow.r)) : '';

  const membersRow = await queryOne(
    `SELECT MAX(created_at) AS c, MAX(COALESCE(revoked_at, '')) AS r
     FROM growth_hub_members WHERE owner_user_id = ?`,
    [ownerId],
  );
  out.members_updated_at = membersRow ? latestOf(dbToIso(membersRow.c), dbToIso(membersRow.r)) : '';

  return sendJson(res, out);
});

// POST is intentionally not routed: previous contract exposed only GET/PUT
// here; method_not_allowed handles the rest via the router.
