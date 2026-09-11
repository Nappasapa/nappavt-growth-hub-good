// Mock backend for the Growth Hub Pages Functions API (/api/*).
// Implements the real endpoints' contract closely enough for DOM tests:
// state GET/PUT with `since`/optimistic concurrency, revision markers,
// invites/claim, members/revoke, notes CRUD, clip HEAD/DELETE.
// Every state update via PUT is recorded in world.upserts like the old stub.

function makeResp(status, body, extraHeaders = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: h => extraHeaders[h] !== undefined ? extraHeaders[h] : (extraHeaders[String(h).toLowerCase()] !== undefined ? extraHeaders[String(h).toLowerCase()] : null) },
    json: async () => (typeof body === 'string' ? (body ? JSON.parse(body) : null) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeApiStub(world) {
  let revCounter = 1;
  const isoRev = () => `2026-09-10T00:00:${String(revCounter++).padStart(2, '0')}.000Z`;
  const b = world.apiBackend = {
    ownerId: world.ownerId || 'owner-1',
    ownerEmail: world.ownerEmail || 'owner@test.dev',
    storedState: world.seedState !== undefined ? JSON.parse(JSON.stringify(world.seedState)) : null,
    stateUpdatedAt: world.seedState !== undefined ? isoRev() : '',
    notes: (world.seedNotes || []).slice(),
    members: (world.seedMembers || []).slice(),
    invites: [],
    claims: [],
    revokes: [],
    inviteCreates: [],
    clipObjects: new Set((world.clipObjects || [])),
    failNextPut: 0,
  };
  const role = () => world.role || 'owner';
  const notesRev = () => b.notes.map(n => n.resolved_at || n.created_at).sort().pop() || '';

  return async function apiFetchStub(url, opts = {}) {
    const u = String(url);
    if (world.onApiCall) world.onApiCall(opts.method || 'GET', u);
    if (u.startsWith('/api/clips/')) {
      const key = u.slice('/api/clips/'.length).split('/').map(decodeURIComponent).join('/');
      if ((opts.method || 'GET') === 'DELETE') {
        if (world.clipDeleteFails) return makeResp(500, { error: 'storage down' });
        b.clipObjects.delete(key);
        world.removedPaths.push(key);
        return makeResp(200, { ok: true });
      }
      if (opts.method === 'HEAD') {
        return b.clipObjects.has(key)
          ? makeResp(200, null, { 'content-length': '1024', 'content-type': 'video/mp4' })
          : makeResp(404, { error: 'not_found' });
      }
      return b.clipObjects.has(key) ? makeResp(200, 'clip-bytes') : makeResp(404, { error: 'not_found' });
    }
    if (!u.startsWith('/api/')) return null; // not ours — caller chains to next stub

    const path = u.split('?')[0];
    const qs = u.includes('?') ? u.slice(u.indexOf('?') + 1) : '';
    const body = opts.body ? JSON.parse(opts.body) : {};
    const r = role();

    if (path === '/api/me') return makeResp(200, { id: r === 'owner' ? b.ownerId : (world.advisorId || 'advisor-1'), email: r === 'owner' ? b.ownerEmail : (world.advisorEmail || 'advisor@test.dev'), role: r, owner_user_id: b.ownerId, via: 'dev' });
    if (path === '/api/access/status' || path === '/api/state/revision') {
      const base = { role: r, owner_user_id: r === 'none' ? null : b.ownerId };
      if (path.endsWith('/status')) return makeResp(200, base);
      return makeResp(200, { ...base,
        state_updated_at: b.storedState ? b.stateUpdatedAt : '',
        notes_updated_at: notesRev(),
        members_updated_at: b.members.map(m => m.revoked_at || m.created_at).sort().pop() || '',
      });
    }
    if (path === '/api/state' && (opts.method || 'GET') === 'GET') {
      if (r === 'none' || r === 'revoked') return makeResp(403, { error: 'no_access' });
      if (!b.storedState) return makeResp(200, { state: null, updated_at: null });
      const since = /(?:^|&)since=([^&]*)/.exec(qs);
      const sinceVal = since ? decodeURIComponent(since[1]) : '';
      if (sinceVal && b.stateUpdatedAt <= sinceVal) return makeResp(200, { unchanged: true, updated_at: b.stateUpdatedAt });
      return makeResp(200, { state: JSON.parse(JSON.stringify(b.storedState)), updated_at: b.stateUpdatedAt });
    }
    if (path === '/api/state' && opts.method === 'PUT') {
      if (r !== 'owner') return makeResp(403, { error: 'owner_only' });
      if (world.upsertFails || b.failNextPut > 0) { if (b.failNextPut > 0) b.failNextPut--; return makeResp(500, { error: 'd1 down' }); }
      const baseRev = String(body.base_updated_at || '');
      if (baseRev && b.storedState && b.stateUpdatedAt !== baseRev) {
        return makeResp(409, { error: 'conflict', updated_at: b.stateUpdatedAt, state: JSON.parse(JSON.stringify(b.storedState)) });
      }
      const stateCopy = JSON.parse(JSON.stringify(body.state || {}));
      b.storedState = stateCopy;
      b.stateUpdatedAt = body.__updated_at || isoRev();
      world.upserts.push({ user_id: b.ownerId, updated_at: b.stateUpdatedAt, state: { ...stateCopy, queue: (stateCopy.queue || []).map(q => ({ ...q })) } });
      return makeResp(200, { ok: true, updated_at: b.stateUpdatedAt });
    }
    if (path === '/api/invites' && opts.method === 'POST') {
      if (r !== 'owner') return makeResp(403, { error: 'owner_only' });
      const token = 'inv-' + (b.invites.length + 1) + '-' + Date.now().toString(36);
      b.invites.push({ token, email_hint: body.email_hint || null });
      b.inviteCreates.push(body);
      return makeResp(200, { token, expires_at: '2026-09-17T00:00:00Z' });
    }
    if (path === '/api/invites/claim') {
      b.claims.push(body.token);
      return makeResp(200, { ok: true, role: 'advisor', owner_user_id: b.ownerId });
    }
    if (path === '/api/members' && (opts.method || 'GET') === 'GET') {
      if (r !== 'owner') return makeResp(403, { error: 'owner_only' });
      return makeResp(200, { members: b.members.filter(m => !m.revoked_at) });
    }
    if (path === '/api/members/revoke') {
      if (r !== 'owner') return makeResp(403, { error: 'owner_only' });
      b.revokes.push(body.target_user_id);
      const m = b.members.find(x => x.user_id === body.target_user_id);
      if (m) m.revoked_at = isoRev();
      if (m) world.role = 'none';
      return m ? makeResp(200, { ok: true }) : makeResp(404, { error: 'member_not_found' });
    }
    if (path === '/api/notes' && (opts.method || 'GET') === 'GET') {
      if (r === 'none' || r === 'revoked') return makeResp(403, { error: 'no_access' });
      return makeResp(200, { notes: b.notes.slice().sort((a, z) => String(z.created_at).localeCompare(String(a.created_at))) });
    }
    if (path === '/api/notes' && opts.method === 'POST') {
      if (r !== 'advisor') return makeResp(403, { error: 'advisor_only' });
      const note = { id: 'note-' + (b.notes.length + 1), owner_user_id: b.ownerId, author_user_id: world.advisorId || 'advisor-1', author_email: world.advisorEmail || 'advisor@test.dev', target_type: body.target_type || 'general', target_ref: body.target_ref || null, body: String(body.body || ''), created_at: isoRev(), resolved_at: null };
      b.notes.push(note);
      return makeResp(200, { ok: true, id: note.id, created_at: note.created_at });
    }
    const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (noteMatch) {
      const note = b.notes.find(n => n.id === noteMatch[1]);
      if (!note) return makeResp(404, { error: 'note_not_found' });
      if ((opts.method || '') === 'PATCH') {
        if (r !== 'owner') return makeResp(403, { error: 'owner_only' });
        note.resolved_at = isoRev();
        return makeResp(200, { ok: true });
      }
      if ((opts.method || '') === 'DELETE') {
        if (r !== 'owner' && note.author_user_id !== (world.advisorId || 'advisor-1')) return makeResp(403, { error: 'no_access' });
        b.notes = b.notes.filter(n => n !== note);
        return makeResp(200, { ok: true });
      }
    }
    return makeResp(404, { error: 'unknown_endpoint', detail: path });
  };
}

// Chains the API stub ahead of an existing transport stub (Drive fetch):
// /api/* → apiStub; everything else → previous stub.
function chainFetch(underlying) {
  return async function chained(url, opts) {
    if (String(url).startsWith('/api/')) {
      const res = await underlying.api(url, opts);
      if (res) return res;
      throw new Error('api stub returned null for ' + url);
    }
    return underlying.next(url, opts);
  };
}

module.exports = { makeApiStub, chainFetch, makeResp };
