// POST /api/invites/claim — replaces the Supabase RPC `claim_growth_hub_invite`.
// Idempotent: re-claiming your own consumed invite succeeds; claiming an
// invite consumed by someone else fails. Claiming also clears a prior
// revocation for this owner (a fresh invite re-admits an advisor).
import { json, readJson, nowIso } from '../../_lib/http.js';
import { resolveIdentity } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const { user } = auth;

  const body = await readJson(context.request, 4 * 1024);
  if (body.response) return body.response;
  const token = String(body.value?.token || '').trim();
  if (!token || token.length > 128) return json({ error: 'invalid_token' }, { status: 400 });

  const invite = await context.env.DB.prepare(
    'SELECT token, owner_user_id, expires_at, claimed_by_user_id FROM growth_hub_invites WHERE token = ?',
  ).bind(token).first();

  if (!invite) return json({ error: 'invite_not_found' }, { status: 404 });
  if (invite.claimed_by_user_id && invite.claimed_by_user_id !== user.id) {
    return json({ error: 'invite_already_claimed' }, { status: 409 });
  }
  if (String(invite.expires_at) <= nowIso()) return json({ error: 'invite_expired' }, { status: 410 });

  const ownerId = String(invite.owner_user_id);
  if (ownerId === user.id) {
    // The owner claiming their own invite adds nothing; treat as success so
    // the UI flow stays simple.
    return json({ ok: true, role: 'owner', owner_user_id: ownerId });
  }

  const now = nowIso();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO growth_hub_members (owner_user_id, user_id, email, role, created_at, revoked_at)
       VALUES (?, ?, ?, 'advisor', ?, NULL)
       ON CONFLICT(owner_user_id, user_id) DO UPDATE SET
         revoked_at = NULL, email = excluded.email`,
    ).bind(ownerId, user.id, user.email, now),
    context.env.DB.prepare(
      'UPDATE growth_hub_invites SET claimed_by_user_id = ?, claimed_at = ? WHERE token = ?',
    ).bind(user.id, now, token),
  ]);
  console.log('[growth-hub] advisor invite claimed for owner', ownerId);
  return json({ ok: true, role: 'advisor', owner_user_id: ownerId });
}
