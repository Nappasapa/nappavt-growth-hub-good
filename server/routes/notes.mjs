// /api/notes — advisor feedback notes (replaces growth_hub_advisor_notes).
// GET           → latest 100 notes for the caller's workspace (owner or advisor)
// POST          → create a note (advisor only)
// PATCH /:id    → resolve (owner)
// DELETE /:id   → owner, or the note's own author (advisor)

import crypto from 'node:crypto';
import { sendJson, readJsonBody } from '../http.mjs';
import { query, exec, nowDb, nowIso, isoToDb, rowsIsoDates } from '../db.mjs';
import { requireUser } from '../auth.mjs';
import { resolveAccess } from '../workspace.mjs';

export const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

const ALLOWED_TYPES = new Set(['general', 'stream', 'clip', 'analytics', 'idea']);
const NOTE_DATE_FIELDS = ['created_at', 'resolved_at'];

route('GET', '/api/notes', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  const ownerId = access.role === 'owner' ? auth.user.id
    : access.role === 'advisor' ? access.owner_user_id : null;
  if (!ownerId) return sendJson(res, { error: 'no_access' }, { status: 403 });

  const rows = await query(
    `SELECT id, owner_user_id, author_user_id, author_email, target_type, target_ref, body, created_at, resolved_at
     FROM growth_hub_advisor_notes
     WHERE owner_user_id = ?
     ORDER BY created_at DESC
     LIMIT 100`,
    [ownerId],
  );
  return sendJson(res, { notes: rowsIsoDates(rows, NOTE_DATE_FIELDS) });
});

route('POST', '/api/notes', async ({ req, res }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'advisor' || !access.owner_user_id) {
    return sendJson(res, { error: 'advisor_only' }, { status: 403 });
  }

  const body = await readJsonBody(req, 8 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  const value = body.value || {};
  const targetType = ALLOWED_TYPES.has(value.target_type) ? value.target_type : 'general';
  const targetRef = String(value.target_ref || '').trim().slice(0, 200) || null;
  const noteBody = String(value.body || '').trim().slice(0, 2000);
  if (!noteBody) return sendJson(res, { error: 'empty_body' }, { status: 400 });

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await exec(
    `INSERT INTO growth_hub_advisor_notes
       (id, owner_user_id, author_user_id, author_email, target_type, target_ref, body, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, access.owner_user_id, auth.user.id, String(auth.user.email || '').toLowerCase() || null, targetType, targetRef, noteBody, isoToDb(createdAt)],
  );
  return sendJson(res, { ok: true, id, created_at: createdAt });
});

route('PATCH', '/api/notes/:id', async ({ req, res, params }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  if (access.role !== 'owner') return sendJson(res, { error: 'owner_only' }, { status: 403 });

  const id = String(params.id || '');
  if (!id || id.length > 64) return sendJson(res, { error: 'invalid_id' }, { status: 400 });
  const body = await readJsonBody(req, 4 * 1024);
  if (!body.ok) return sendJson(res, { error: body.error }, { status: body.status });
  if (!body.value?.resolve) return sendJson(res, { error: 'unsupported_patch' }, { status: 400 });

  const result = await exec(
    'UPDATE growth_hub_advisor_notes SET resolved_at = ? WHERE id = ? AND owner_user_id = ?',
    [nowDb(), id, auth.user.id],
  );
  if (!result.affectedRows) return sendJson(res, { error: 'note_not_found' }, { status: 404 });
  return sendJson(res, { ok: true });
});

route('DELETE', '/api/notes/:id', async ({ req, res, params }) => {
  const auth = await requireUser(req, res);
  if (auth.responseSent) return;
  const access = await resolveAccess(auth.user);
  const id = String(params.id || '');
  if (!id || id.length > 64) return sendJson(res, { error: 'invalid_id' }, { status: 400 });

  let result;
  if (access.role === 'owner') {
    result = await exec(
      'DELETE FROM growth_hub_advisor_notes WHERE id = ? AND owner_user_id = ?',
      [id, auth.user.id],
    );
  } else if (access.role === 'advisor' && access.owner_user_id) {
    result = await exec(
      'DELETE FROM growth_hub_advisor_notes WHERE id = ? AND owner_user_id = ? AND author_user_id = ?',
      [id, access.owner_user_id, auth.user.id],
    );
  } else {
    return sendJson(res, { error: 'no_access' }, { status: 403 });
  }
  if (!result.affectedRows) return sendJson(res, { error: 'note_not_found' }, { status: 404 });
  return sendJson(res, { ok: true });
});
