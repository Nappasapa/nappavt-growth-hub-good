// Clip storage abstraction. Default driver: local disk (STORAGE_DIR), keys of
// the form "<owner_user_id>/<epoch>_<rand>_<name>.<ext>" (the legacy Supabase
// path format). Files are never loaded whole into memory; reads/writes stream.
// A different driver (S3-compatible) can be slotted behind the same interface
// later WITHOUT touching the routes — MariaDB stays metadata-only regardless.

import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, unlink, readdir, rename } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.mjs';
import { randomBytes } from 'node:crypto';

// Validates an object key built from dashboard clip paths. Same rules as the
// old Worker version: length cap, no traversal, no empty segments, ASCII.
export function sanitizeClipKey(raw) {
  const key = String(raw || '').replace(/\\/g, '/');
  if (!key || key.length > 600) return null;
  if (key.startsWith('/') || key.endsWith('/')) return null;
  if (key.split('/').some(seg => !seg || seg === '.' || seg === '..')) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return null;
  return key;
}

export function clipContentType(key) {
  const ext = (String(key).split('.').pop() || '').toLowerCase();
  return {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    m4v: 'video/x-m4v', mp3: 'audio/mpeg', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  }[ext] || 'application/octet-stream';
}

function resolveClipPath(key) {
  // sanitizeClipKey already guarantees no '.'/'..' segments and no leading
  // slash; normalize + prefix-check anyway (defense in depth).
  const root = normalize(config.storageDir);
  const full = normalize(join(root, ...key.split('/')));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export async function ensureStorageRoot() {
  await mkdir(config.storageDir, { recursive: true });
}

export async function headClip(key) {
  const safe = sanitizeClipKey(key);
  if (!safe) return null;
  const full = resolveClipPath(safe);
  if (!full) return null;
  try {
    const st = await stat(full);
    if (!st.isFile()) return null;
    return { key: safe, size: st.size, contentType: clipContentType(safe) };
  } catch {
    return null;
  }
}

export function streamClip(key, { offset = 0, length } = {}) {
  const full = resolveClipPath(sanitizeClipKey(key) || '');
  if (!full) throw Object.assign(new Error('invalid_key'), { httpStatus: 400, errorCode: 'invalid_key' });
  const opts = {};
  if (offset > 0) opts.start = offset;
  if (length !== undefined && length !== null) opts.end = offset + length - 1;
  return createReadStream(full, opts);
}

export async function deleteClip(key) {
  const safe = sanitizeClipKey(key);
  if (!safe) return { ok: false, error: 'invalid_key' };
  const full = resolveClipPath(safe);
  if (!full) return { ok: false, error: 'invalid_key' };
  try {
    await unlink(full);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err; // idempotent
  }
  return { ok: true };
}

// List all objects (key,size) under the storage root, lexicographically
// sorted. Capped at `limit` objects; returns { objects, truncated }.
export async function listClips({ limit = 1000 } = {}) {
  const objects = [];
  async function walk(dir, prefix) {
    if (objects.length >= limit) return true;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false; // root doesn't exist yet → empty list
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (objects.length >= limit) return true;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full, rel)) return true;
      } else if (entry.isFile()) {
        const st = await stat(full);
        // Exposed keys must follow the path format (skip temp files).
        const safe = sanitizeClipKey(rel);
        if (safe) objects.push({ key: safe, size: st.size });
        else if (rel.endsWith('.part')) { /* ignore streams in flight */ }
      }
    }
    return false;
  }
  const truncated = await walk(config.storageDir, '');
  return { objects, truncated };
}

// Stream an incoming request body to disk via a .part temp file + atomic
// rename. Returns { key, size } or throws a carryable HttpError.
export async function ingestClipStream(key, bodyStream, { maxBytes }) {
  const safe = sanitizeClipKey(key);
  if (!safe) throw Object.assign(new Error('invalid_key'), { httpStatus: 400, errorCode: 'invalid_key' });
  const full = resolveClipPath(safe);
  if (!full) throw Object.assign(new Error('invalid_key'), { httpStatus: 400, errorCode: 'invalid_key' });
  await mkdir(join(config.storageDir, ...safe.split('/').slice(0, -1)), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString('hex')}.part`;
  let size = 0;
  const out = createWriteStream(tmp);
  try {
    const counter = async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > maxBytes) {
          const err = new Error('clip_too_large');
          err.httpStatus = 413;
          err.errorCode = 'clip_too_large';
          throw err;
        }
        yield chunk;
      }
    };
    await pipeline(counter(bodyStream), out);
    await rename(tmp, full);
    return { key: safe, size };
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}
