// Step 3 of the data migration: copy legacy clip objects OUT of Supabase
// Storage ("clips" bucket) INTO this backend's object store — over the bot
// channel, so it works from any machine (local shell or GitHub Action):
//
//   dry run (plan only):
//     GROWTH_HUB_API_BASE=https://hub.example.com BOT_SYNC_TOKEN=… \
//     SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/migrate-clips.mjs
//   apply:
//     same env + --apply
//
// Uploads go through PUT /api/bot/clips/<key> (bot bearer auth, streamed).
// Idempotent/resumable via migration-data/clip-manifest.json. Content-Type
// is inferred server-side from the extension (same table as before).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const API_BASE = (process.env.GROWTH_HUB_API_BASE || '').replace(/\/$/, '');
const BOT_TOKEN = process.env.BOT_SYNC_TOKEN || '';
const APPLY = process.argv.includes('--apply');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (export shell).');
  process.exit(1);
}
if (APPLY && (!API_BASE || !BOT_TOKEN)) {
  console.error('--apply needs GROWTH_HUB_API_BASE (e.g. https://hub.example.com) and BOT_SYNC_TOKEN.');
  process.exit(1);
}

let objects = null;
if (existsSync('migration-data/export.json')) {
  objects = JSON.parse(readFileSync('migration-data/export.json', 'utf8')).storage_objects || [];
}
if (!objects) {
  console.error('migration-data/export.json missing — run scripts/export-supabase.mjs first.');
  process.exit(1);
}

let manifest = { copied: {}, failed: {} };
if (existsSync('migration-data/clip-manifest.json')) {
  manifest = JSON.parse(readFileSync('migration-data/clip-manifest.json', 'utf8'));
}
const saveManifest = () => writeFileSync('migration-data/clip-manifest.json', JSON.stringify(manifest, null, 2));

const dataOrStream = res => {
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  return res.body; // web stream → passed straight into upstream fetch (true streaming)
};

(async () => {
  const totalBytes = objects.reduce((a, o) => a + (o.size || 0), 0);
  console.log(`Plan: ${objects.length} objects, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
  const todo = objects.filter(o => !manifest.copied[o.key]);
  console.log(todo.length
    ? `${todo.length} object(s) still to copy ${APPLY ? '(--apply: uploading now)' : '(dry run — pass --apply)'}`
    : 'nothing left to copy');

  if (!APPLY) {
    todo.slice(0, 25).forEach(o => console.log(`  would copy ${o.key} (${((o.size || 0) / 1024).toFixed(0)} KB)`));
    if (todo.length > 25) console.log(`  … and ${todo.length - 25} more`);
    process.exit(0);
  }

  let ok = 0; let failed = 0;
  for (const obj of todo) {
    try {
      const src = await fetch(
        `${SUPABASE_URL}/storage/v1/object/clips/${obj.key.split('/').map(encodeURIComponent).join('/')}`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      const body = dataOrStream(src);

      const up = await fetch(`${API_BASE}/api/bot/clips/${obj.key.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${BOT_TOKEN}`,
          'content-type': obj.mimetype || 'application/octet-stream',
          ...(obj.size ? { 'content-length': String(obj.size) } : {}),
        },
        body,
        duplex: 'half', // node fetch requires this for streamed bodies
      });
      if (!up.ok) {
        const detail = await up.text().catch(() => '');
        throw new Error(`upload failed: HTTP ${up.status} ${detail.slice(0, 200)}`);
      }

      manifest.copied[obj.key] = { size: obj.size ?? null, copied_at: new Date().toISOString() };
      delete manifest.failed[obj.key];
      ok++;
      console.log(`  copied ${obj.key}`);
    } catch (err) {
      manifest.failed[obj.key] = String(err.message || err).slice(0, 300);
      failed++;
      console.error(`  FAILED ${obj.key}: ${manifest.failed[obj.key]}`);
    }
  }
  saveManifest();
  console.log(`\nClip migration: ${ok} copied, ${failed} failed, ${Object.keys(manifest.copied).length} total recorded.`);
  if (failed) process.exit(1);
})().catch(err => { console.error('CLIP MIGRATION FAILED:', err.message); process.exit(1); });
