// Step 4 of the data migration: verification. Compares what is still in
// Supabase against what now lives in D1 (and, for clips, against the
// clip-manifest written by scripts/migrate-clips.mjs).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-migration.mjs [--local]
//
// Exits non-zero if anything important is missing or different. Prints a
// table the migration checklist can record.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.');
  process.exit(1);
}
const LOCAL = process.argv.includes('--local');
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  -', name); }
  else { fail++; console.error('  FAIL -', name, String(extra).slice(0, 400)); }
};

const iso = v => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// canonical JSON stringify (sorted keys) for blob comparison
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const sha = s => createHash('sha256').update(s).digest('hex');

async function sbTable(name) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?select=*`, { headers: H });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

function d1Query(sql) {
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'nappavt-growth-hub', LOCAL ? '--local' : '--remote',
    '--json', '--command', sql,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return (parsed && parsed[0] && parsed[0].results) || [];
}

(async () => {
  console.log(`Verifying migration against ${LOCAL ? 'LOCAL' : 'remote'} D1…`);

  const [sbState, sbInvites, sbMembers, sbNotes, sbUsersRes] = await Promise.all([
    sbTable('dashboard_state'),
    sbTable('growth_hub_invites'),
    sbTable('growth_hub_members'),
    sbTable('growth_hub_advisor_notes'),
    sbTable('growth_hub_members').then(() => null).catch(() => null),
  ]);

  // --- table counts
  const tables = [
    ['dashboard_state', sbState.length],
    ['growth_hub_invites', sbInvites.length],
    ['growth_hub_members', sbMembers.length],
    ['growth_hub_advisor_notes', sbNotes.length],
  ];
  for (const [name, sbCount] of tables) {
    const d1Count = Number(d1Query(`SELECT COUNT(*) AS n FROM ${name}`)[0]?.n ?? -1);
    t(`${name}: row counts match`, d1Count === sbCount, `supabase=${sbCount} d1=${d1Count}`);
  }

  // --- per-user state identity + content
  const d1Rows = d1Query('SELECT user_id, state, updated_at FROM dashboard_state');
  const d1ByUser = new Map(d1Rows.map(r => [String(r.user_id), r]));
  t('dashboard_state: same user set', (() => {
    const a = new Set(sbState.map(r => String(r.user_id)));
    const wanted = [...a].filter(id => d1ByUser.has(id));
    return wanted.length === a.size;
  })(), [...sbState.map(r => String(r.user_id))].filter(id => !d1ByUser.has(id)).join(','));

  let blobMismatches = 0;
  let tsMismatches = 0;
  for (const row of sbState) {
    const d1 = d1ByUser.get(String(row.user_id));
    if (!d1) { blobMismatches++; continue; }
    let sbStateObj = row.state;
    if (typeof sbStateObj === 'string') { try { sbStateObj = JSON.parse(sbStateObj); } catch {} }
    let d1StateObj = d1.state;
    if (typeof d1StateObj === 'string') { try { d1StateObj = JSON.parse(d1StateObj); } catch {} }
    if (sha(canonical(sbStateObj)) !== sha(canonical(d1StateObj))) blobMismatches++;
    const sbTs = iso(row.updated_at);
    if (sbTs && String(d1.updated_at) !== sbTs) tsMismatches++;
  }
  t('dashboard_state: blob contents identical (canonical)', blobMismatches === 0, `${blobMismatches} mismatching rows`);
  t('dashboard_state: updated_at preserved', tsMismatches === 0, `${tsMismatches} mismatching timestamps`);

  // --- notes field spot-check
  const d1Notes = d1Query('SELECT id, author_email, created_at, resolved_at FROM growth_hub_advisor_notes');
  const d1NoteIds = new Set(d1Notes.map(n => String(n.id)));
  const missingNotes = sbNotes.filter(n => !d1NoteIds.has(String(n.id)));
  t('advisor notes: all ids present', missingNotes.length === 0, missingNotes.map(n => n.id).join(','));

  // --- owner meta present
  const meta = d1Query("SELECT value FROM hub_meta WHERE key='owner_user_id'");
  t('hub_meta.owner_user_id set', Boolean(meta[0] && meta[0].value), JSON.stringify(meta));

  // --- clips
  if (existsSync('migration-data/clip-manifest.json')) {
    const manifest = JSON.parse(readFileSync('migration-data/clip-manifest.json', 'utf8'));
    const doc = JSON.parse(readFileSync('migration-data/export.json', 'utf8'));
    const planned = (doc.storage_objects || []).map(o => o.key);
    const copied = new Set(Object.keys(manifest.copied || {}));
    const missing = planned.filter(k => !copied.has(k));
    t(`legacy clips: ${copied.size}/${planned.length} objects copied to R2`, missing.length === 0, missing.slice(0, 5).join(', '));
    const failed = Object.keys(manifest.failed || {});
    t('legacy clips: no recorded failures', failed.length === 0, failed.join(','));
  } else {
    console.log('  skip - clip manifest not found (run scripts/migrate-clips.mjs first if legacy clips exist)');
  }

  console.log(`\nverify: ${pass} passed, ${fail} failed (${LOCAL ? 'local' : 'remote'} D1)`);
  if (fail) process.exit(1);
})().catch(err => { console.error('VERIFY FAILED:', err.message); process.exit(1); });
