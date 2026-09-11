// GET /api/me — identity bootstrap for the dashboard (replaces sb.auth.getSession).
import { json } from '../_lib/http.js';
import { resolveIdentity } from '../_lib/auth.js';
import { resolveAccess } from '../_lib/workspace.js';

export async function onRequestGet(context) {
  const auth = await resolveIdentity(context.request, context.env, { touchLastSeen: true });
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  return json({
    id: auth.user.id,
    email: auth.user.email,
    role: access.role,
    owner_user_id: access.owner_user_id,
    via: auth.via,
  });
}
