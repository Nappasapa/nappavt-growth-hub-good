// Workspace access resolution: maps an authenticated user to their Growth Hub
// role (owner / advisor / revoked / none) and the workspace owner id.
// Replaces the Supabase RPCs `growth_hub_access_status`,
// `claim_growth_hub_invite` and `revoke_growth_hub_advisor`.

import { query, queryOne, exec } from './db.mjs';
import { config } from './config.mjs';
import { log, maskEmail } from './log.mjs';
import { withIsoDates, rowsIsoDates } from './db.mjs';

const OWNER_META_KEY = 'owner_user_id';

export async function getOwnerUserId() {
  const row = await queryOne('SELECT meta_value FROM hub_meta WHERE meta_key = ?', [OWNER_META_KEY]);
  return row && row.meta_value ? String(row.meta_value) : null;
}

async function setOwnerUserId(userId) {
  await exec(
    `INSERT INTO hub_meta (meta_key, meta_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
    [OWNER_META_KEY, String(userId)],
  );
}

// Returns { role: 'owner'|'advisor'|'revoked'|'none', owner_user_id }.
// Owner determination order:
//   1. OWNER_EMAIL matches this user → owner (also repairs hub_meta).
//   2. hub_meta.owner_user_id === this user → owner.
//   3. hub_meta unset (and no OWNER_EMAIL configured) → first caller claims it.
//   4. growth_hub_members (non-revoked) → advisor.
//   5. growth_hub_members (all revoked) → revoked.
//   6. otherwise → none.
export async function resolveAccess(user) {
  const ownerEmail = (config.ownerEmail || '').trim().toLowerCase();
  let ownerId = await getOwnerUserId();
  const email = String(user.email || '').toLowerCase();

  if (ownerEmail && email === ownerEmail) {
    if (ownerId !== user.id) {
      if (ownerId) log.warn('owner id corrected via OWNER_EMAIL for', maskEmail(email));
      await setOwnerUserId(user.id);
      ownerId = user.id;
    }
    return { role: 'owner', owner_user_id: ownerId };
  }

  if (!ownerId) {
    // First login ever claims the workspace (login itself is the gate).
    await setOwnerUserId(user.id);
    log.info('workspace owner claimed by', maskEmail(email));
    return { role: 'owner', owner_user_id: user.id };
  }

  if (ownerId === user.id) return { role: 'owner', owner_user_id: ownerId };

  let rows = await query(
    'SELECT owner_user_id, revoked_at FROM growth_hub_members WHERE user_id = ? ORDER BY created_at DESC',
    [user.id],
  );

  // Self-healing for migrated memberships: a member row may reference an old
  // (Supabase-era) user id while the person's email matches. Re-bind once,
  // transparently.
  if (!rows.length && email) {
    const found = await query(
      'SELECT owner_user_id, user_id, revoked_at, email FROM growth_hub_members WHERE email = ? ORDER BY created_at DESC',
      [email],
    );
    for (const row of found) {
      await exec(
        'UPDATE growth_hub_members SET user_id = ? WHERE owner_user_id = ? AND user_id = ?',
        [user.id, String(row.owner_user_id), String(row.user_id)],
      );
    }
    if (found.length) {
      log.info('membership re-bound by email for', maskEmail(email));
      rows = found.map(r => ({ owner_user_id: r.owner_user_id, revoked_at: r.revoked_at }));
    }
  }

  rows = rowsIsoDates(rows, ['revoked_at']);
  const active = rows.find(r => !r.revoked_at);
  if (active) return { role: 'advisor', owner_user_id: String(active.owner_user_id) };
  if (rows.length) return { role: 'revoked', owner_user_id: String(rows[0].owner_user_id) };
  return { role: 'none', owner_user_id: null };
}

// The workspace whose data a caller may read: owner → own id, advisor →
// their owner's id. Returns null for revoked/none.
export async function readableWorkspaceOwnerId(user, access) {
  const a = access || await resolveAccess(user);
  if (a.role === 'owner') return user.id;
  if (a.role === 'advisor') return a.owner_user_id;
  return null;
}
export async function writableWorkspaceOwnerId(user, access) {
  const a = access || await resolveAccess(user);
  return a.role === 'owner' ? user.id : null;
}
