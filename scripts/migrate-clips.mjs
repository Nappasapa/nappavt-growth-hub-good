// Step 3 of the data migration: copy legacy clip objects from Supabase Storage
// (bucket "clips") into the R2 bucket "nappavt-growth-hub-clips".
//
//   DRY RUN (default — only plans):
//     SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/migrate-clips.mjs
//   APPLY:
//     SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/migrate-clips.mjs --apply
//
// Uploads go through `wrangler r2 object put`, which uses your own wrangler
// login — no R2 API credentials are needed or stored anywhere. Re-running is
// safe: objects are put under their original keys (R2 put overwrites), and a
// clip-manifest.json in migration-data/ tracks what succeeded.
//
// Reads the object list from migration-data/export.json (run export first), or
// re-lists the bucket when absent.

import { readFileSync, writeFileSync, existsSync, createWriteStream, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APPLY = process.argv.includes('--apply');
const LOCAL = process.argv.includes('--local'); // rehearsal against local R2
const BUCKET = process.env.CLIPS_BUCKET || 'nappavt-growth-hub-clips';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.');
  process.exit(1);
}

let objects = null;
if (existsSync('migration-data/export.json')) {
  const doc = JSON.parse(readFileSync('migration-data/export.json', 'utf8'));
  objects = doc.storage_objects || [];
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

(async () => {
  const totalBytes = objects.reduce((a, o) => a + (o.size || 0), 0);
  console.log(`Plan: ${objects.length} objects, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
  const todo = objects.filter(o => !manifest.copied[o.key]);
  console.log(todo.length
    ? `${todo.length} object(s) still to copy ${APPLY ? '(--apply: copying now)' : '(dry run — pass --apply to copy)'}`
    : 'nothing left to copy');

  if (!APPLY) {
    todo.slice(0, 25).forEach(o => console.log(`  would copy ${o.key} (${((o.size || 0) / 1024).toFixed(0)} KB)`));
    if (todo.length > 25) console.log(`  … and ${todo.length - 25} more`);
    process.exit(0);
  }

  let ok = 0; let failed = 0;
  for (const obj of todo) {
    const tmp = `migration-data/.tmp-${createHash('sha1').update(obj.key).digest('hex')}`;
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/clips/${obj.key.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      await pipeline(res.body, createWriteStream(tmp));

      execFileSync('npx', [
        'wrangler', 'r2', 'object', 'put', `${BUCKET}/${obj.key}`,
        '--file', tmp, LOCAL ? '--local' : '--remote',
        ...(obj.mimetype ? ['--content-type', obj.mimetype] : []),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      manifest.copied[obj.key] = { size: obj.size ?? null, copied_at: new Date().toISOString() };
      delete manifest.failed[obj.key];
      ok++;
      console.log(`  copied ${obj.key}`);
    } catch (err) {
      manifest.failed[obj.key] = String(err.message || err).slice(0, 300);
      failed++;
      console.error(`  FAILED ${obj.key}: ${manifest.failed[obj.key]}`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }
  saveManifest();
  console.log(`\nClip migration: ${ok} copied, ${failed} failed, ${Object.keys(manifest.copied).length} total recorded.`);
  if (failed) process.exit(1);
})().catch(err => { console.error('CLIP MIGRATION FAILED:', err.message); process.exit(1); });
