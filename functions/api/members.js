// GET /api/members — owner lists active advisors (replaces growth_hub_members select).
import { json } from '../_lib/http.js';
import { resolveIdentity } from '../_lib/auth.js';
import { resolveAccess } from '../_lib/workspace.js';

export async function onRequestGet(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  if (access.role !== 'owner') return json({ error: 'owner_only' }, { status: 403 });

  const rows = await context.env.DB.prepare(
    `SELECT user_id, email, role, created_at FROM growth_hub_members
     WHERE owner_user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
  ).bind(auth.user.id).all();
  return json({ members: rows.results || [] });
}
