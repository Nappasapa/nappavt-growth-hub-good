// Local smoke test for the Growth Hub Pages Functions.
// Requires: `npm run dev` (wrangler pages dev) running on the base URL.
// Usage:   node scripts/dev-smoke.mjs [baseUrl]
// Exits non-zero on any failure. Safe to run repeatedly.

const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const BOT_KEY = process.env.BOT_SYNC_TOKEN || 'test-bot-token-32-bytes-long-xxxxxxx';

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.error('  FAIL -', name, String(extra).slice(0, 300)); }
};

const asOwner = { 'content-type': 'application/json' };
const asAdvisor = email => ({ 'content-type': 'application/json', 'x-dev-identity-email': email });
const asBot = { 'content-type': 'application/json', 'x-nappa-bot-key': BOT_KEY };

async function req(path, opts = {}) {
  const res = await fetch(base + path, opts);
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

(async () => {
  console.log('smoke target:', base);

  // Reset local D1 so the first-login owner claim is deterministic.
  // (Requires wrangler + the repo root as cwd — same as `npm run dev`.)
  if (!process.argv.includes('--no-reset')) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'nappavt-growth-hub', '--local', '--command',
      'DELETE FROM growth_hub_advisor_notes; DELETE FROM growth_hub_members; DELETE FROM growth_hub_invites; DELETE FROM dashboard_state; DELETE FROM hub_meta; DELETE FROM users;'], { stdio: 'pipe' });
    console.log('local D1 reset');
  }

  // health + auth gates
  let r = await req('/api/health');
  t('health ok', r.status === 200 && r.body.ok === true && r.body.d1 === true, JSON.stringify(r.body));

  // owner bootstrap: first identity to resolve access claims the workspace
  r = await req('/api/me');
  const ownerId = r.body.id;
  t('owner claimed workspace', r.status === 200 && r.body.id && r.body.role === 'owner', JSON.stringify(r.body));

  r = await req('/api/me', { headers: { 'x-dev-identity-email': 'nobody-should-exist@x.dev' } });
  t('new user cannot steal claimed workspace', r.status === 200 && r.body.role === 'none' && r.body.owner_user_id === null, JSON.stringify(r.body));

  // state round-trip
  const stateV1 = { fields: { x: '1' }, queue: [{ id: 1, title: 'smoke' }], streams: [], clips: [] };
  r = await req('/api/state', { method: 'PUT', headers: asOwner, body: JSON.stringify({ state: stateV1 }) });
  t('state PUT ok', r.status === 200 && r.body.ok === true && !!r.body.updated_at, JSON.stringify(r.body));
  const rev1 = r.body.updated_at;

  r = await req('/api/state', { headers: asOwner });
  t('state GET round-trip', r.status === 200 && r.body.state && r.body.state.queue?.[0]?.title === 'smoke', JSON.stringify(r.body).slice(0, 200));
  t('state GET same updated_at', r.body.updated_at === rev1, `${r.body.updated_at} vs ${rev1}`);

  r = await req('/api/state?since=' + encodeURIComponent(rev1), { headers: asOwner });
  t('state GET since → unchanged', r.status === 200 && r.body.unchanged === true, JSON.stringify(r.body));

  // optimistic concurrency
  r = await req('/api/state', { method: 'PUT', headers: asOwner, body: JSON.stringify({ state: { fields: { x: '2' } }, base_updated_at: '1999-01-01T00:00:00.000Z' }) });
  t('stale base → 409 conflict + current state', r.status === 409 && r.body.error === 'conflict' && r.body.state?.queue?.[0]?.title === 'smoke', JSON.stringify(r.body).slice(0, 200));

  r = await req('/api/state', { method: 'PUT', headers: asOwner, body: JSON.stringify({ state: stateV1, base_updated_at: rev1 }) });
  t('matching base → write ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  // revision endpoint
  r = await req('/api/state/revision', { headers: asOwner });
  t('revision carries role + markers', r.status === 200 && r.body.role === 'owner' && r.body.state_updated_at.length > 10, JSON.stringify(r.body));

  // invites + advisor claim + notes
  r = await req('/api/invites', { method: 'POST', headers: asOwner, body: JSON.stringify({ email_hint: 'adv@local.dev' }) });
  const token = r.body.token;
  t('invite created', r.status === 200 && typeof token === 'string' && token.length >= 32, JSON.stringify(r.body));

  const advisorHeaders = asAdvisor('adv@local.dev');
  r = await req('/api/invites/claim', { method: 'POST', headers: advisorHeaders, body: JSON.stringify({ token }) });
  t('advisor claims invite', r.status === 200 && r.body.ok === true && r.body.owner_user_id === ownerId, JSON.stringify(r.body));
  let advisorId = null;
  r = await req('/api/me', { headers: advisorHeaders });
  advisorId = r.body.id;
  t('advisor role resolves', r.status === 200 && r.body.role === 'advisor' && r.body.owner_user_id === ownerId, JSON.stringify(r.body));

  r = await req('/api/state', { headers: advisorHeaders });
  t('advisor reads shared state', r.status === 200 && r.body.state?.queue?.[0]?.title === 'smoke', JSON.stringify(r.body).slice(0, 160));
  r = await req('/api/state', { method: 'PUT', headers: advisorHeaders, body: JSON.stringify({ state: {} }) });
  t('advisor cannot write state', r.status === 403, JSON.stringify(r.body));

  r = await req('/api/notes', { method: 'POST', headers: advisorHeaders, body: JSON.stringify({ target_type: 'stream', target_ref: 'jan-1', body: 'Great pacing in hour 2!' }) });
  const noteId = r.body.id;
  t('advisor creates note', r.status === 200 && !!noteId, JSON.stringify(r.body));

  r = await req('/api/notes', { headers: asOwner });
  t('owner reads notes', r.status === 200 && Array.isArray(r.body.notes) && r.body.notes[0]?.body.includes('pacing'), JSON.stringify(r.body).slice(0, 200));

  r = await req('/api/notes/' + noteId, { method: 'PATCH', headers: asOwner, body: JSON.stringify({ resolve: true }) });
  t('owner resolves note', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  r = await req('/api/notes/' + noteId, { method: 'DELETE', headers: advisorHeaders });
  t('author deletes note', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  // members + revoke
  r = await req('/api/members', { headers: asOwner });
  t('owner lists members', r.status === 200 && r.body.members.some(m => m.user_id === advisorId), JSON.stringify(r.body));

  r = await req('/api/members/revoke', { method: 'POST', headers: asOwner, body: JSON.stringify({ target_user_id: advisorId }) });
  t('owner revokes advisor', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  r = await req('/api/access/status', { headers: advisorHeaders });
  t('revoked advisor sees revoked', r.status === 200 && r.body.role === 'revoked', JSON.stringify(r.body));
  r = await req('/api/state', { headers: advisorHeaders });
  t('revoked advisor loses state access', r.status === 403, JSON.stringify(r.body));

  // bot channel
  r = await req('/api/bot/state/revision?user_id=' + ownerId, { headers: asBot });
  t('bot revision', r.status === 200 && r.body.state_updated_at.length > 10, JSON.stringify(r.body));
  r = await req('/api/bot/state?user_id=' + ownerId, { headers: asBot });
  t('bot reads state', r.status === 200 && r.body.state?.fields?.x === '1', JSON.stringify(r.body).slice(0, 160));
  const botState = { fields: { x: '1' }, queue: [], streams: [], clips: [], twitchStatus: { connected: true, login: 'nappavt' } };
  r = await req('/api/bot/state', { method: 'PUT', headers: asBot, body: JSON.stringify({ user_id: ownerId, state: botState }) });
  t('bot writes state', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await req('/api/bot/state', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-nappa-bot-key': 'wrong' }, body: JSON.stringify({ user_id: ownerId, state: {} }) });
  t('bot wrong token rejected', r.status === 401, JSON.stringify(r.body));

  // final owner read sees the bot write
  r = await req('/api/state', { headers: asOwner });
  t('owner sees bot-written state', r.status === 200 && r.body.state?.twitchStatus?.connected === true, JSON.stringify(r.body).slice(0, 200));

  console.log(`\nsmoke: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(err => { console.error('smoke crashed:', err); process.exit(1); });
