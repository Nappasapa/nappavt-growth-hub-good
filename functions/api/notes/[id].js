// /api/notes/:id — PATCH (owner resolves) / DELETE (owner, or the note author)
import { json, readJson, nowIso } from '../../_lib/http.js';
import { resolveIdentity } from '../../_lib/auth.js';
import { resolveAccess } from '../../_lib/workspace.js';

export async function onRequestPatch(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  if (access.role !== 'owner') return json({ error: 'owner_only' }, { status: 403 });

  const id = String(context.params.id || '');
  if (!id || id.length > 64) return json({ error: 'invalid_id' }, { status: 400 });
  const body = await readJson(context.request, 4 * 1024);
  if (body.response) return body.response;
  if (!body.value?.resolve) return json({ error: 'unsupported_patch' }, { status: 400 });

  const result = await context.env.DB.prepare(
    'UPDATE growth_hub_advisor_notes SET resolved_at = ? WHERE id = ? AND owner_user_id = ?',
  ).bind(nowIso(), id, auth.user.id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: 'note_not_found' }, { status: 404 });
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const auth = await resolveIdentity(context.request, context.env);
  if (auth.response) return auth.response;
  const access = await resolveAccess(context.env, auth.user);
  const id = String(context.params.id || '');
  if (!id || id.length > 64) return json({ error: 'invalid_id' }, { status: 400 });

  let result;
  if (access.role === 'owner') {
    result = await context.env.DB.prepare(
      'DELETE FROM growth_hub_advisor_notes WHERE id = ? AND owner_user_id = ?',
    ).bind(id, auth.user.id).run();
  } else if (access.role === 'advisor' && access.owner_user_id) {
    result = await context.env.DB.prepare(
      'DELETE FROM growth_hub_advisor_notes WHERE id = ? AND owner_user_id = ? AND author_user_id = ?',
    ).bind(id, access.owner_user_id, auth.user.id).run();
  } else {
    return json({ error: 'no_access' }, { status: 403 });
  }
  if (!result.meta || result.meta.changes === 0) return json({ error: 'note_not_found' }, { status: 404 });
  return json({ ok: true });
}
