// Step 1 of the data migration: export everything the Growth Hub still needs
// out of Supabase into migration-data/export.json.
//
// Required env (never committed, never logged):
//   SUPABASE_URL                e.g. https://oilpvawpfysthoanjcnh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   project service-role key (read-only use here)
//
// The script only reads. It writes masked identifiers to stdout and the full
// export (which contains personal data) into gitignored migration-data/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.');
  process.exit(1);
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
const maskEmail = e => {
  const [n, d] = String(e || '').split('@');
  return d ? `${(n || '').slice(0, 2)}***@${d}` : '(no-email)';
};
const short = id => String(id || '').slice(0, 8) + '…';
const sha256 = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${url.replace(SUPABASE_URL, '<supabase>')} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchTable(name) {
  // PostgREST caps responses; paginate defensively.
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchJson(`${SUPABASE_URL}/rest/v1/${name}?select=*&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchAuthUsers() {
  try {
    const page = await fetchJson(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`);
    const list = Array.isArray(page) ? page : (page.users || []);
    return list.map(u => ({ id: u.id, email: u.email || null, created_at: u.created_at || null }));
  } catch (err) {
    console.warn('  warn: auth admin API not reachable — advisor emails may be incomplete.', err.message);
    return [];
  }
}

async function listStorageObjects(bucket) {
  // Supabase Storage lists one level at a time; crawl root folders.
  const objects = [];
  async function listLevel(prefix) {
    let offset = 0;
    for (;;) {
      const page = await fetchJson(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      if (!Array.isArray(page) || page.length === 0) break;
      for (const item of page) {
        if (item.id === null) {
          await listLevel(prefix ? `${prefix}/${item.name}` : item.name);
        } else {
          objects.push({
            key: prefix ? `${prefix}/${item.name}` : item.name,
            size: item.metadata?.size ?? item.metadata?.contentLength ?? null,
            mimetype: item.metadata?.mimetype || null,
            updated_at: item.updated_at || null,
          });
        }
      }
      if (page.length < 1000) break;
      offset += 1000;
    }
  }
  await listLevel('');
  return objects;
}

function normalizeTs(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

(async () => {
  console.log('Exporting from', SUPABASE_URL.replace(/https:\/\/(.{4}).*/, 'https://$1…'));

  const [authUsers, dashboardState, invites, members, notes] = await Promise.all([
    fetchAuthUsers(),
    fetchTable('dashboard_state'),
    fetchTable('growth_hub_invites'),
    fetchTable('growth_hub_members'),
    fetchTable('growth_hub_advisor_notes'),
  ]);

  // Validate + normalize dashboard_state
  const stateRows = dashboardState.map(row => {
    let state = row.state;
    if (typeof state === 'string') {
      try { state = JSON.parse(state); } catch { throw new Error(`dashboard_state ${short(row.user_id)} has unparseable state JSON`); }
    }
    if (!state || typeof state !== 'object') throw new Error(`dashboard_state ${short(row.user_id)} has empty/invalid state`);
    return {
      user_id: String(row.user_id),
      state,
      updated_at: normalizeTs(row.updated_at),
      state_bytes: JSON.stringify(state).length,
    };
  });

  let storage = [];
  try {
    storage = await listStorageObjects('clips');
  } catch (err) {
    console.warn('  warn: could not list the clips bucket:', err.message);
  }

  const exportDoc = {
    meta: {
      exported_at: new Date().toISOString(),
      counts: {
        auth_users: authUsers.length,
        dashboard_state: stateRows.length,
        growth_hub_invites: invites.length,
        growth_hub_members: members.length,
        growth_hub_advisor_notes: notes.length,
        storage_objects: storage.length,
        storage_bytes: storage.reduce((a, o) => a + (o.size || 0), 0),
      },
    },
    auth_users: authUsers,
    dashboard_state: stateRows,
    growth_hub_invites: invites.map(r => ({
      token: r.token, owner_user_id: r.owner_user_id, email_hint: r.email_hint ?? null,
      expires_at: normalizeTs(r.expires_at), claimed_by_user_id: r.claimed_by_user_id ?? null,
      claimed_at: normalizeTs(r.claimed_at), created_at: normalizeTs(r.created_at),
    })),
    growth_hub_members: members.map(r => ({
      owner_user_id: r.owner_user_id, user_id: r.user_id, email: r.email ?? null,
      role: r.role || 'advisor', created_at: normalizeTs(r.created_at),
      revoked_at: normalizeTs(r.revoked_at ?? r.revokedAt ?? null),
    })),
    growth_hub_advisor_notes: notes.map(r => ({
      id: r.id, owner_user_id: r.owner_user_id, author_user_id: r.author_user_id ?? null,
      author_email: r.author_email ?? null, target_type: r.target_type || 'general',
      target_ref: r.target_ref ?? null, body: r.body || '', created_at: normalizeTs(r.created_at),
      resolved_at: normalizeTs(r.resolved_at),
    })),
    storage_objects: storage,
  };

  mkdirSync('migration-data', { recursive: true });
  writeFileSync('migration-data/export.json', JSON.stringify(exportDoc));

  console.log('\nExport summary:');
  for (const [k, v] of Object.entries(exportDoc.meta.counts)) console.log(`  ${k}: ${v}`);
  for (const row of stateRows) {
    const user = authUsers.find(u => u.id === row.user_id);
    console.log(`  state ${short(row.user_id)} ${maskEmail(user?.email)} · ${(row.state_bytes / 1024).toFixed(1)} KB · updated ${row.updated_at} · sha ${sha256(JSON.stringify(row.state))}`);
  }
  console.log('\nWrote migration-data/export.json (contains personal data — gitignored, do not share).');
})().catch(err => { console.error('EXPORT FAILED:', err.message); process.exit(1); });
