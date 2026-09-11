// Step 2 of the data migration: transform migration-data/export.json into a
// D1-ready SQL file (migration-data/d1-import.sql) and an import report.
//
// Guarantees:
//   - preserves user ids, note ids, timestamps, relationships
//   - normalizes every timestamp to ISO-8601 Z (what the Functions emit)
//   - infers the workspace owner (hub_meta.owner_user_id):
//       --owner-id <uuid>   wins if given
//       else: majority owner_user_id in members/invites, else sole state row
//   - creates placeholder users rows for ids referenced without a known email
//   - idempotent: INSERT OR REPLACE everywhere — safe to re-run
//
// Apply with:  npx wrangler d1 execute nappavt-growth-hub --remote --file=migration-data/d1-import.sql
// (use --local first to rehearse against the dev database)

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const ownerIdFlag = (idx => (idx >= 0 ? args[idx + 1] : null))(args.indexOf('--owner-id'));

const doc = JSON.parse(readFileSync('migration-data/export.json', 'utf8'));
const now = new Date().toISOString();

const q = value => {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
};
const iso = value => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// ---- owner inference ------------------------------------------------------
const ownerVotes = new Map();
const vote = id => id && ownerVotes.set(String(id), (ownerVotes.get(String(id)) || 0) + 1);
(doc.growth_hub_members || []).forEach(m => vote(m.owner_user_id));
(doc.growth_hub_invites || []).forEach(i => vote(i.owner_user_id));
let ownerId = ownerIdFlag ? String(ownerIdFlag) : null;
let ownerSource = ownerIdFlag ? '--owner-id flag' : null;
if (!ownerId && ownerVotes.size) {
  ownerId = [...ownerVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  ownerSource = 'majority of invites/members rows';
}
if (!ownerId && doc.dashboard_state.length === 1) {
  ownerId = doc.dashboard_state[0].user_id;
  ownerSource = 'only dashboard_state row';
}
if (!ownerId) {
  console.error('Could not infer the workspace owner. Re-run with --owner-id <uuid> (the Supabase auth user id of the owner).');
  process.exit(1);
}

// ---- users ----------------------------------------------------------------
const emailsById = new Map();
for (const u of doc.auth_users || []) emailsById.set(String(u.id), u.email ? String(u.email).toLowerCase() : null);
for (const m of doc.growth_hub_members || []) {
  if (m.email && emailsById.get(String(m.user_id)) !== undefined && !emailsById.get(String(m.user_id))) {
    emailsById.set(String(m.user_id), String(m.email).toLowerCase());
  } else if (m.email && !emailsById.has(String(m.user_id))) {
    emailsById.set(String(m.user_id), String(m.email).toLowerCase());
  }
}
const referencedIds = new Set();
(doc.dashboard_state || []).forEach(r => referencedIds.add(String(r.user_id)));
(doc.growth_hub_invites || []).forEach(r => { referencedIds.add(String(r.owner_user_id)); if (r.claimed_by_user_id) referencedIds.add(String(r.claimed_by_user_id)); });
(doc.growth_hub_members || []).forEach(r => { referencedIds.add(String(r.owner_user_id)); referencedIds.add(String(r.user_id)); });
(doc.growth_hub_advisor_notes || []).forEach(r => referencedIds.add(String(r.owner_user_id)));
referencedIds.add(ownerId);

const placeholderUsers = [];
for (const id of referencedIds) {
  if (!emailsById.has(id)) {
    emailsById.set(id, null);
    placeholderUsers.push(id);
  }
}

// ---- statements -----------------------------------------------------------
const stmts = [];
stmts.push('-- NappaVT Growth Hub Supabase → D1 import');
stmts.push(`-- generated ${now} · owner ${ownerId} (${ownerSource})`);
stmts.push('PRAGMA defer_foreign_keys = ON;');

for (const [id, email] of emailsById) {
  const created = iso((doc.auth_users || []).find(u => String(u.id) === id)?.created_at) || now;
  stmts.push(
    `INSERT OR REPLACE INTO users (id, email, created_at, last_seen_at) VALUES (${q(id)}, ${q(email)}, ${q(created)}, NULL);`,
  );
}

stmts.push(
  `INSERT INTO hub_meta (key, value) VALUES ('owner_user_id', ${q(ownerId)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
);

const seenStateUsers = new Set();
let stateRowsWritten = 0;
for (const row of doc.dashboard_state || []) {
  const uid = String(row.user_id);
  if (seenStateUsers.has(uid)) { console.warn(`  warn: duplicate dashboard_state row for ${uid.slice(0, 8)}… skipped`); continue; }
  seenStateUsers.add(uid);
  const stateJson = JSON.stringify(row.state);
  const updatedAt = iso(row.updated_at) || now;
  stmts.push(
    `INSERT OR REPLACE INTO dashboard_state (user_id, state, updated_at, state_bytes) VALUES (${q(uid)}, ${q(stateJson)}, ${q(updatedAt)}, ${stateJson.length});`,
  );
  stateRowsWritten++;
}

for (const r of doc.growth_hub_invites || []) {
  stmts.push(
    `INSERT OR REPLACE INTO growth_hub_invites (token, owner_user_id, email_hint, expires_at, claimed_by_user_id, claimed_at, created_at)
     VALUES (${q(r.token)}, ${q(r.owner_user_id)}, ${q(r.email_hint)}, ${q(iso(r.expires_at) || now)}, ${q(r.claimed_by_user_id)}, ${q(iso(r.claimed_at))}, ${q(iso(r.created_at) || now)});`,
  );
}

for (const r of doc.growth_hub_members || []) {
  stmts.push(
    `INSERT OR REPLACE INTO growth_hub_members (owner_user_id, user_id, email, role, created_at, revoked_at)
     VALUES (${q(r.owner_user_id)}, ${q(r.user_id)}, ${q(r.email ? String(r.email).toLowerCase() : null)}, ${q(r.role || 'advisor')}, ${q(iso(r.created_at) || now)}, ${q(iso(r.revoked_at))});`,
  );
}

for (const r of doc.growth_hub_advisor_notes || []) {
  stmts.push(
    `INSERT OR REPLACE INTO growth_hub_advisor_notes (id, owner_user_id, author_user_id, author_email, target_type, target_ref, body, created_at, resolved_at)
     VALUES (${q(r.id)}, ${q(r.owner_user_id)}, ${q(r.author_user_id)}, ${q(r.author_email)}, ${q(r.target_type || 'general')}, ${q(r.target_ref)}, ${q(r.body || '')}, ${q(iso(r.created_at) || now)}, ${q(iso(r.resolved_at))});`,
  );
}

writeFileSync('migration-data/d1-import.sql', stmts.join('\n') + '\n');

const report = {
  generated_at: now,
  owner_user_id: ownerId,
  owner_source: ownerSource,
  users: emailsById.size,
  placeholder_users_without_email: placeholderUsers,
  dashboard_state_rows: stateRowsWritten,
  invites: doc.growth_hub_invites.length,
  members: doc.growth_hub_members.length,
  notes: doc.growth_hub_advisor_notes.length,
  storage_objects_planned: doc.meta?.counts?.storage_objects ?? (doc.storage_objects || []).length,
};
writeFileSync('migration-data/import-report.json', JSON.stringify(report, null, 2));

console.log('Import SQL written: migration-data/d1-import.sql');
console.log(`  owner: ${ownerId} (${ownerSource})`);
console.log(`  users: ${emailsById.size} (${placeholderUsers.length} placeholder without email)`);
console.log(`  states: ${stateRowsWritten} · invites: ${report.invites} · members: ${report.members} · notes: ${report.notes}`);
if (placeholderUsers.length) {
  console.warn('  warn: some user ids had no known email — they get placeholder rows and');
  console.warn('        re-bind automatically on first login (only affects advisor accounts).');
}
console.log('\nApply with:');
console.log('  rehearsal:  npx wrangler d1 execute nappavt-growth-hub --local --file=migration-data/d1-import.sql');
console.log('  production: npx wrangler d1 execute nappavt-growth-hub --remote --file=migration-data/d1-import.sql');
