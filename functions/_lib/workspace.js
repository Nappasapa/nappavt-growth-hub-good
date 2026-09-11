// Workspace access resolution: maps an authenticated user to their Growth Hub
// role (owner / advisor / revoked / none) and the workspace owner id.
// Replaces the Supabase RPC functions `growth_hub_access_status`,
// `claim_growth_hub_invite` and `revoke_growth_hub_advisor`.

import { nowIso } from './http.js';
import { maskEmail } from './auth.js';

const OWNER_META_KEY = 'owner_user_id';

export async function getOwnerUserId(env) {
  const row = await env.DB.prepare('SELECT value FROM hub_meta WHERE key = ?').bind(OWNER_META_KEY).first();
  return row && row.value ? String(row.value) : null;
}

async function setOwnerUserId(env, userId) {
  await env.DB.prepare(
    'INSERT INTO hub_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(OWNER_META_KEY, String(userId)).run();
}

// Returns { role: 'owner'|'advisor'|'revoked'|'none', owner_user_id }.
// Owner determination order:
//   1. OWNER_EMAIL env var matches this user → owner (also repairs hub_meta).
//   2. hub_meta.owner_user_id === this user → owner.
//   3. hub_meta unset and (no OWNER_EMAIL configured) → first caller claims
//      owner (Access already restricts who can reach the app at all).
//   4. growth_hub_members (non-revoked) → advisor.
//   5. growth_hub_members (all revoked) → revoked.
//   6. otherwise → none.
export async function resolveAccess(env, user) {
  const ownerEmail = (env.OWNER_EMAIL || '').trim().toLowerCase();
  let ownerId = await getOwnerUserId(env);

  if (ownerEmail && user.email.toLowerCase() === ownerEmail) {
    if (ownerId !== user.id) {
      if (ownerId) console.warn('[growth-hub] owner id corrected via OWNER_EMAIL for', maskEmail(user.email));
      await setOwnerUserId(env, user.id);
      ownerId = user.id;
    }
    return { role: 'owner', owner_user_id: ownerId };
  }

  if (!ownerId) {
    // First login ever claims the workspace (Access is the gatekeeper).
    await setOwnerUserId(env, user.id);
    console.log('[growth-hub] workspace owner claimed by', maskEmail(user.email));
    return { role: 'owner', owner_user_id: user.id };
  }

  if (ownerId === user.id) return { role: 'owner', owner_user_id: ownerId };

  const members = await env.DB.prepare(
    'SELECT owner_user_id, revoked_at FROM growth_hub_members WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(user.id).all();
  let rows = members.results || [];

  // Self-healing for migrated memberships: a member row may reference an old
  // (Supabase-era) user id while the person's verified Access email matches.
  // Re-bind the row to their live user id once, transparently.
  if (!rows.length && user.email) {
    const byEmail = await env.DB.prepare(
      'SELECT owner_user_id, user_id, revoked_at FROM growth_hub_members WHERE email = ? ORDER BY created_at DESC',
    ).bind(user.email).all();
    const found = byEmail.results || [];
    for (const row of found) {
      await env.DB.prepare(
        'UPDATE growth_hub_members SET user_id = ? WHERE owner_user_id = ? AND user_id = ?',
      ).bind(user.id, String(row.owner_user_id), String(row.user_id)).run();
    }
    if (found.length) {
      console.log('[growth-hub] membership re-bound by email for', maskEmail(user.email));
      rows = found.map(r => ({ owner_user_id: r.owner_user_id, revoked_at: r.revoked_at }));
    }
  }

  const active = rows.find(r => !r.revoked_at);
  if (active) return { role: 'advisor', owner_user_id: String(active.owner_user_id) };
  if (rows.length) return { role: 'revoked', owner_user_id: String(rows[0].owner_user_id) };
  return { role: 'none', owner_user_id: null };
}

// The workspace whose data a caller may read: owner → own id, advisor →
// their owner's id. Returns null for revoked/none.
export async function readableWorkspaceOwnerId(env, user) {
  const access = await resolveAccess(env, user);
  if (access.role === 'owner') return user.id;
  if (access.role === 'advisor') return access.owner_user_id;
  return null;
}

export { nowIso };
