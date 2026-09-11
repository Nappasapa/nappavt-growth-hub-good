// GET /api/access/status — replaces the Supabase RPC `growth_hub_access_status`.
import { json } from '../../_lib/http.js';
import { resolveIdentity } from '../../_lib/auth.js';
import { resolveAccess } from '../../_lib/workspace.js';

export async function onRequestGet(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  return json({ role: access.role, owner_user_id: access.owner_user_id });
}
