// Step 4 of the data migration: verification. Compares what is still in
// Supabase against what now lives in MariaDB (and, for clips, against the
// clip-manifest from scripts/migrate-clips.mjs).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…  (+ DB_* env for MariaDB)
//   node scripts/verify-mariadb.mjs
//
// Exits non-zero on any mismatch. Prints the checklist table for the runbook.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { query, queryOne, closePool, dbToIso, withIsoDates } from '../server/db.mjs';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.');
  process.exit(1);
}
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

(async () => {
  console.log('Verifying migration against MariaDB…');

  const [sbState, sbInvites, sbMembers, sbNotes] = await Promise.all([
    sbTable('dashboard_state'),
    sbTable('growth_hub_invites'),
    sbTable('growth_hub_members'),
    sbTable('growth_hub_advisor_notes'),
  ]);

  const tables = [
    ['dashboard_state', sbState.length],
    ['growth_hub_invites', sbInvites.length],
    ['growth_hub_members', sbMembers.length],
    ['growth_hub_advisor_notes', sbNotes.length],
  ];
  for (const [name, sbCount] of tables) {
    const row = await queryOne(`SELECT COUNT(*) AS n FROM ${name}`);
    const mariaCount = Number(row?.n ?? -1);
    t(`${name}: row counts match`, mariaCount === sbCount, `supabase=${sbCount} mariadb=${mariaCount}`);
  }

  const dbRows = await query('SELECT user_id, state, updated_at FROM dashboard_state');
  const dbByUser = new Map(dbRows.map(r => [String(r.user_id), r]));
  const missing = [...sbState.map(r => String(r.user_id))].filter(id => !dbByUser.has(id));
  t('dashboard_state: same user set', missing.length === 0, missing.join(','));

  let blobMismatches = 0;
  let tsMismatches = 0;
  for (const row of sbState) {
    const db = dbByUser.get(String(row.user_id));
    if (!db) { blobMismatches++; continue; }
    let sbStateObj = row.state;
    if (typeof sbStateObj === 'string') { try { sbStateObj = JSON.parse(sbStateObj); } catch {} }
    let dbStateObj = db.state;
    if (typeof dbStateObj === 'string') { try { dbStateObj = JSON.parse(dbStateObj); } catch {} }
    if (sha(canonical(sbStateObj)) !== sha(canonical(dbStateObj))) blobMismatches++;
    const sbTs = iso(row.updated_at);
    const dbTs = dbToIso(db.updated_at);
    if (sbTs && dbTs !== sbTs) tsMismatches++;
  }
  t('dashboard_state: blob contents identical (canonical)', blobMismatches === 0, `${blobMismatches} mismatching rows`);
  t('dashboard_state: updated_at preserved', tsMismatches === 0, `${tsMismatches} mismatching timestamps`);

  const dbNotes = await query('SELECT id FROM growth_hub_advisor_notes');
  const dbNoteIds = new Set(dbNotes.map(n => String(n.id)));
  const missingNotes = sbNotes.filter(n => !dbNoteIds.has(String(n.id)));
  t('advisor notes: all ids present', missingNotes.length === 0, missingNotes.map(n => n.id).join(','));

  const meta = await queryOne("SELECT meta_value FROM hub_meta WHERE meta_key='owner_user_id'");
  t('hub_meta.owner_user_id set', Boolean(meta && meta.meta_value), JSON.stringify(meta));

  if (existsSync('migration-data/clip-manifest.json')) {
    const manifest = JSON.parse(readFileSync('migration-data/clip-manifest.json', 'utf8'));
    const doc = JSON.parse(readFileSync('migration-data/export.json', 'utf8'));
    const planned = (doc.storage_objects || []).map(o => o.key);
    const copied = new Set(Object.keys(manifest.copied || {}));
    const missingClips = planned.filter(k => !copied.has(k));
    t(`legacy clips: ${copied.size}/${planned.length} objects uploaded`, missingClips.length === 0, missingClips.slice(0, 5).join(', '));
    const failed = Object.keys(manifest.failed || {});
    t('legacy clips: no recorded failures', failed.length === 0, failed.join(','));
  } else {
    console.log('  skip - clip manifest not found (run scripts/migrate-clips.mjs first if legacy clips exist)');
  }

  // Imported users must NOT have passwords (no credentials ever migrate).
  const pwRow = await queryOne('SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL');
  console.log(`  info - users with a password set: ${Number(pwRow?.n ?? 0)} (set owner password via npm run user:password)`);

  await closePool();
  console.log(`\nverify: ${pass} passed, ${fail} failed (MariaDB)`);
  if (fail) process.exit(1);
})().catch(async err => {
  console.error('VERIFY FAILED:', err.message);
  try { await closePool(); } catch {}
  process.exit(1);
});
