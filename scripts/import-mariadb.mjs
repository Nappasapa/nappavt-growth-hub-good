// Step 2 of the data migration: import migration-data/export.json (produced by
// scripts/export-supabase.mjs) into MariaDB. Replaces the old D1 path.
//
//   node scripts/import-mariadb.mjs [--owner-id <uuid>]
//
// Guarantees (same as before):
//   - preserves user ids, note ids, timestamps, relationships
//   - normalizes every timestamp to UTC DATETIME(3) (API emits ISO-8601 Z)
//   - infers the workspace owner (hub_meta.owner_user_id) — flag wins, then
//     majority of members/invites rows, then the sole state row
//   - creates placeholder user rows for ids referenced without a known email
//   - idempotent: INSERT … ON DUPLICATE KEY UPDATE everywhere (safe to re-run)
//   - applies pending schema migrations first (CREATE DATABASE + tables)
//
// After importing, the owner has NO password yet (imported rows never carry
// credentials). Set it with:
//   OWNER_EMAIL=<their-email> OWNER_PASSWORD='<new>' npm run user:password

import { readFileSync, writeFileSync } from 'node:fs';
import { query, queryOne, exec, inTransaction, isoToDb, nowDb, closePool } from '../server/db.mjs';
import { runUp } from '../server/migrate.mjs';
import { config } from '../server/config.mjs';

const args = process.argv.slice(2);
const ownerIdFlag = (idx => (idx >= 0 ? args[idx + 1] : null))(args.indexOf('--owner-id'));

if (!readFileSync && false) console.log('never');
let doc;
try {
  doc = JSON.parse(readFileSync('migration-data/export.json', 'utf8'));
} catch (err) {
  console.error('migration-data/export.json missing — run scripts/export-supabase.mjs first.');
  process.exit(1);
}
const nowIso = new Date().toISOString();
const iso = value => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// ---- owner inference (identical to the prior importer) ---------------------
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
if (!ownerId && (doc.dashboard_state || []).length === 1) {
  ownerId = doc.dashboard_state[0].user_id;
  ownerSource = 'only dashboard_state row';
}
if (!ownerId) {
  console.error('Could not infer the workspace owner. Re-run with --owner-id <uuid>.');
  process.exit(1);
}

// ---- users -----------------------------------------------------------------
const emailsById = new Map();
for (const u of doc.auth_users || []) emailsById.set(String(u.id), u.email ? String(u.email).toLowerCase() : null);
for (const m of doc.growth_hub_members || []) {
  if (m.email && !emailsById.get(String(m.user_id))) {
    emailsById.set(String(m.user_id), String(m.email).toLowerCase());
  }
}
const referencedIds = new Set();
(doc.dashboard_state || []).forEach(r => referencedIds.add(String(r.user_id)));
(doc.growth_hub_invites || []).forEach(r => {
  referencedIds.add(String(r.owner_user_id));
  if (r.claimed_by_user_id) referencedIds.add(String(r.claimed_by_user_id));
});
(doc.growth_hub_members || []).forEach(r => { referencedIds.add(String(r.owner_user_id)); referencedIds.add(String(r.user_id)); });
(doc.growth_hub_advisor_notes || []).forEach(r => {
  referencedIds.add(String(r.owner_user_id));
  referencedIds.add(String(r.author_user_id)); // FK target — caught thanks to real constraints
});
referencedIds.add(ownerId);

const placeholderUsers = [];
for (const id of referencedIds) {
  if (!emailsById.has(id)) {
    emailsById.set(id, null);
    placeholderUsers.push(id);
  }
}

// ---- import ----------------------------------------------------------------
console.log(`Importing into MariaDB ${config.db.name} @ ${config.db.host}:${config.db.port}…`);
await runUp({ quiet: true });

const counts = { users: 0, states: 0, invites: 0, members: 0, notes: 0 };
await inTransaction(async (tx) => {
  for (const [id, email] of emailsById) {
    const created = iso((doc.auth_users || []).find(u => String(u.id) === id)?.created_at) || nowIso;
    await tx.exec(
      `INSERT INTO users (id, email, password_hash, created_at, last_seen_at) VALUES (?, ?, NULL, ?, NULL)
       ON DUPLICATE KEY UPDATE email = COALESCE(users.email, VALUES(email))`,
      [id, email, isoToDb(created)],
    );
    counts.users++;
  }

  await tx.exec(
    `INSERT INTO hub_meta (meta_key, meta_value) VALUES ('owner_user_id', ?)
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
    [ownerId],
  );

  const seenStateUsers = new Set();
  for (const row of doc.dashboard_state || []) {
    const uid = String(row.user_id);
    if (seenStateUsers.has(uid)) { console.warn(`  warn: duplicate dashboard_state row for ${uid.slice(0, 8)}… skipped`); continue; }
    seenStateUsers.add(uid);
    const stateJson = typeof row.state === 'string' ? row.state : JSON.stringify(row.state);
    JSON.parse(stateJson); // fail loudly on broken state instead of importing garbage
    const updatedAt = iso(row.updated_at) || nowIso;
    await tx.exec(
      `INSERT INTO dashboard_state (user_id, state, state_bytes, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE state = VALUES(state), state_bytes = VALUES(state_bytes), updated_at = VALUES(updated_at)`,
      [uid, stateJson, stateJson.length, isoToDb(updatedAt)],
    );
    counts.states++;
  }

  for (const r of doc.growth_hub_invites || []) {
    await tx.exec(
      `INSERT INTO growth_hub_invites (token, owner_user_id, email_hint, expires_at, claimed_by_user_id, claimed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email_hint = VALUES(email_hint), expires_at = VALUES(expires_at),
         claimed_by_user_id = VALUES(claimed_by_user_id), claimed_at = VALUES(claimed_at)`,
      [
        String(r.token), String(r.owner_user_id), r.email_hint ?? null,
        isoToDb(iso(r.expires_at) || nowIso),
        r.claimed_by_user_id ? String(r.claimed_by_user_id) : null,
        isoToDb(iso(r.claimed_at)), isoToDb(iso(r.created_at) || nowIso),
      ],
    );
    counts.invites++;
  }

  for (const r of doc.growth_hub_members || []) {
    await tx.exec(
      `INSERT INTO growth_hub_members (owner_user_id, user_id, email, role, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email = VALUES(email), role = VALUES(role), revoked_at = VALUES(revoked_at)`,
      [
        String(r.owner_user_id), String(r.user_id),
        r.email ? String(r.email).toLowerCase() : null,
        String(r.role || 'advisor'),
        isoToDb(iso(r.created_at) || nowIso),
        isoToDb(iso(r.revoked_at)),
      ],
    );
    counts.members++;
  }

  for (const r of doc.growth_hub_advisor_notes || []) {
    await tx.exec(
      `INSERT INTO growth_hub_advisor_notes (id, owner_user_id, author_user_id, author_email, target_type, target_ref, body, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE body = VALUES(body), resolved_at = VALUES(resolved_at)`,
      [
        String(r.id), String(r.owner_user_id), String(r.author_user_id),
        r.author_email ? String(r.author_email).toLowerCase() : null,
        String(r.target_type || 'general'),
        r.target_ref ?? null,
        String(r.body ?? ''),
        isoToDb(iso(r.created_at) || nowIso),
        isoToDb(iso(r.resolved_at)),
      ],
    );
    counts.notes++;
  }
});

const report = {
  generated_at: nowIso,
  owner_user_id: ownerId,
  owner_source: ownerSource,
  users: counts.users,
  placeholder_users_without_email: placeholderUsers,
  dashboard_state_rows: counts.states,
  invites: counts.invites,
  members: counts.members,
  notes: counts.notes,
  storage_objects_planned: doc.meta?.counts?.storage_objects ?? (doc.storage_objects || []).length,
};
writeFileSync('migration-data/import-report.json', JSON.stringify(report, null, 2));

console.log('Import complete.');
console.log(`  owner: ${ownerId} (${ownerSource})`);
console.log(`  users: ${counts.users} (${placeholderUsers.length} placeholder without email)`);
console.log(`  states: ${counts.states} · invites: ${counts.invites} · members: ${counts.members} · notes: ${counts.notes}`);
if (placeholderUsers.length) {
  console.warn('  warn: some user ids had no known email — placeholder rows created;');
  console.warn('        memberships re-bind automatically on first login.');
}
const ownerEmail = emailsById.get(ownerId) || '(unknown email)';
console.log('\nNext steps:');
console.log('  1. set the owner password (imported users have none):');
console.log(`     OWNER_EMAIL=${ownerEmail} OWNER_PASSWORD='<pick-a-long-unique-one>' npm run user:password`);
console.log('  2. migrate legacy clips: node scripts/migrate-clips.mjs --apply');
console.log('  3. verify everything:  npm run verify');

await closePool();
