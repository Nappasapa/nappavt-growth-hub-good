// Member + invite routes (contract carried over from the previous backend):
//  POST /api/invites        create 7-day advisor invite (owner)
//  POST /api/invites/claim  claim an invite (signed-in advisor)
//  GET  /api/members        list active advisors (owner)
//  POST /api/members/revoke soft-revoke an advisor (owner)

import crypto from 'node:crypto';
import { sendJson, readJsonBody } from '../http.mjs';
import { query, queryOne, exec, inTransaction, nowDb, nowIso, isoToDb, dbToIso, rowsIsoDates } from '../db.mjs';
import { requireUser } from '../auth.mjs';
import { resolveAccess } from '../workspace.mjs';
import { log, maskEmail } from '../log.mjs';

export const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

route('POST', '/api/invites', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'owner') return sendJson(res, { error: 'owner_only' }, { status: 403 });

  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const emailHint = String(body.value?.email_hint || '').trim().slice(0, 254) || null;

  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await exec(
    'INSERT INTO growth_hub_invites (token, owner_user_id, email_hint, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [token, auth.user.id, emailHint, isoToDb(expiresAt), nowDb()],
  );
  return sendJson(res, { token, expires_at: expiresAt });
});

route('POST', '/api/invites/claim', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const { user } = auth;

  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const token = String(body.value?.token || '').trim();
  if (!token || token.length > 128) return sendJson(res, { error: 'invalid_token' }, { status: 400 });

  const invite = await queryOne(
    'SELECT token, owner_user_id, expires_at, claimed_by_user_id FROM growth_hub_invites WHERE token = ?',
    [token],
  );
  if (!invite) return sendJson(res, { error: 'invite_not_found' }, { status: 404 });
  if (invite.claimed_by_user_id && String(invite.claimed_by_user_id) !== user.id) {
    return sendJson(res, { error: 'invite_already_claimed' }, { status: 409 });
  }
  const expiresIso = dbToIso(invite.expires_at);
  if (expiresIso && expiresIso <= nowIso()) return sendJson(res, { error: 'invite_expired' }, { status: 410 });

  const ownerId = String(invite.owner_user_id);
  if (ownerId === user.id) {
    // Owner claiming their own invite adds nothing; keep UI flow simple.
    return sendJson(res, { ok: true, role: 'owner', owner_user_id: ownerId });
  }

  // Idempotent + atomic: insert/update member row AND mark invite claimed.
  await inTransaction(async (tx) => {
    const now = nowDb();
    await tx.exec(
      `INSERT INTO growth_hub_members (owner_user_id, user_id, email, role, created_at, revoked_at)
       VALUES (?, ?, ?, 'advisor', ?, NULL)
       ON DUPLICATE KEY UPDATE revoked_at = NULL, email = VALUES(email)`,
      [ownerId, user.id, String(user.email || '').toLowerCase() || null, now],
    );
    await tx.exec('UPDATE growth_hub_invites SET claimed_by_user_id = ?, claimed_at = ? WHERE token = ?', [
      user.id, now, token,
    ]);
  });
  log.info('advisor invite claimed for owner', ownerId, 'by', maskEmail(user.email));
  return sendJson(res, { ok: true, role: 'advisor', owner_user_id: ownerId });
});

route('GET', '/api/members', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'owner') return sendJson(res, { error: 'owner_only' }, { status: 403 });

  const rows = await query(
    `SELECT user_id, email, role, created_at FROM growth_hub_members
     WHERE owner_user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [auth.user.id],
  );
  return sendJson(res, { members: rowsIsoDates(rows, ['created_at']) });
});

route('POST', '/api/members/revoke', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'owner') return sendJson(res, { error: 'owner_only' }, { status: 403 });

  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const target = String(body.value?.target_user_id || '').trim();
  if (!target || target.length > 64) return sendJson(res, { error: 'invalid_target' }, { status: 400 });

  const result = await exec(
    'UPDATE growth_hub_members SET revoked_at = ? WHERE owner_user_id = ? AND user_id = ? AND revoked_at IS NULL',
    [nowDb(), auth.user.id, target],
  );
  if (!result.affectedRows) return sendJson(res, { error: 'member_not_found' }, { status: 404 });
  log.info('advisor revoked by owner', auth.user.id);
  return sendJson(res, { ok: true });
});
