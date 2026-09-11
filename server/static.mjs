// Static file serving for the SPA. The backend IS the frontend host: a single
// origin serves the dashboard and the API, so session cookies stay first-party
// everywhere. Only explicit allowlisted paths are served from disk.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { config, ROOT_DIR } from './config.mjs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// path (normalized URL pathname) -> file relative to repo root
const ALLOWED = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/privacy', 'privacy/index.html'],
  ['/privacy/', 'privacy/index.html'],
  ['/privacy/index.html', 'privacy/index.html'],
  ['/terms', 'terms/index.html'],
  ['/terms/', 'terms/index.html'],
  ['/terms/index.html', 'terms/index.html'],
  ['/tiktokbSoGYzHe5aeNCnsrhIKFW8BguLbCIJxy.txt', 'tiktokbSoGYzHe5aeNCnsrhIKFW8BguLbCIJxy.txt'],
]);

export async function serveStatic(req, res, pathname) {
  const rel = ALLOWED.get(pathname);
  if (!rel) return false;
  const root = normalize(ROOT_DIR);
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return false;
  let st;
  try {
    st = await stat(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = '.' + (full.split('.').pop() || '').toLowerCase();
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'content-length': String(st.size),
    // HTML always revalidates (auth is client-side driven).
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
  return true;
}
