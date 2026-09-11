// POST /api/members/revoke — replaces the Supabase RPC `revoke_growth_hub_advisor`.
// Soft-revokes (sets revoked_at) so the advisor's next status poll locks them out.
import { json, readJson, nowIso } from '../../_lib/http.js';
import { resolveIdentity } from '../../_lib/auth.js';
import { resolveAccess } from '../../_lib/workspace.js';

export async function onRequestPost(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  if (access.role !== 'owner') return json({ error: 'owner_only' }, { status: 403 });

  const body = await readJson(context.request, 4 * 1024);
  if (body.response) return body.response;
  const target = String(body.value?.target_user_id || '').trim();
  if (!target || target.length > 64) return json({ error: 'invalid_target' }, { status: 400 });

  const result = await context.env.DB.prepare(
    'UPDATE growth_hub_members SET revoked_at = ? WHERE owner_user_id = ? AND user_id = ? AND revoked_at IS NULL',
  ).bind(nowIso(), auth.user.id, target).run();

  if (!result.meta || result.meta.changes === 0) return json({ error: 'member_not_found' }, { status: 404 });
  console.log('[growth-hub] advisor revoked by owner', auth.user.id);
  return json({ ok: true });
}
