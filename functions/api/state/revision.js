// GET /api/state/revision — the cheap heartbeat the dashboard polls instead of
// downloading the whole state blob. One tiny response carries workspace role
// (revocation detection) plus change markers for state / feedback / members.

import { json } from '../../_lib/http.js';
import { resolveIdentity } from '../../_lib/auth.js';
import { resolveAccess } from '../../_lib/workspace.js';

function latestOf(...values) {
  return values.filter(Boolean).sort().pop() || '';
}

export async function onRequestGet(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);

  const out = {
    role: access.role,
    owner_user_id: access.owner_user_id,
    state_updated_at: '',
    notes_updated_at: '',
    members_updated_at: '',
  };
  if (access.role !== 'owner' && access.role !== 'advisor') {
    // Revoked/unknown users still need to SEE their status so the frontend
    // can lock the session — but no workspace markers.
    return json(out);
  }
  const ownerId = access.role === 'owner' ? auth.user.id : access.owner_user_id;

  const stateRow = await context.env.DB.prepare(
    'SELECT updated_at FROM dashboard_state WHERE user_id = ?',
  ).bind(ownerId).first();
  out.state_updated_at = stateRow && stateRow.updated_at ? String(stateRow.updated_at) : '';

  const notesRow = await context.env.DB.prepare(
    `SELECT MAX(created_at) AS c, MAX(COALESCE(resolved_at, '')) AS r
     FROM growth_hub_advisor_notes WHERE owner_user_id = ?`,
  ).bind(ownerId).first();
  out.notes_updated_at = notesRow ? latestOf(notesRow.c, notesRow.r) : '';

  const membersRow = await context.env.DB.prepare(
    `SELECT MAX(created_at) AS c, MAX(COALESCE(revoked_at, '')) AS r
     FROM growth_hub_members WHERE owner_user_id = ?`,
  ).bind(ownerId).first();
  out.members_updated_at = membersRow ? latestOf(membersRow.c, membersRow.r) : '';

  return json(out);
}
