// GET /api/bot/state/revision?user_id=<owner>
// Tiny change marker so the bot can poll cheaply instead of re-reading the
// entire dashboard blob on every check.
import { json } from '../../../_lib/http.js';
import { botAuth } from '../../../_lib/auth.js';

export async function onRequestGet(context) {
  const gate = botAuth(context.request, context.env);
  if (gate.response) return gate.response;

  const userId = new URL(context.request.url).searchParams.get('user_id') || '';
  const row = await context.env.DB.prepare(
    'SELECT updated_at FROM dashboard_state WHERE user_id = ?',
  ).bind(String(userId)).first();
  return json({ user_id: userId || null, state_updated_at: row && row.updated_at ? String(row.updated_at) : '' });
}
