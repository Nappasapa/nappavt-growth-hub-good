// Simple in-memory sliding-window rate limiter. Single-process by design —
// document that horizontally scaled deployments need a shared store (or the
// reverse proxy's own limiting). Login throttling lives in auth.mjs.

const buckets = new Map(); // key -> number[] (timestamps)

// Allow at most `max` events per `windowMs` per key.
export function rateLimitCheck(key, { windowMs, max }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let hits = buckets.get(key) || [];
  hits = hits.filter(t => t > cutoff);
  if (hits.length >= max) {
    buckets.set(key, hits);
    const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true };
}

// Periodic sweep so the map doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, hits] of buckets) {
    const live = hits.filter(t => t > cutoff);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
  if (buckets.size > 50000) buckets.clear(); // extreme defensive cap
}, 10 * 60 * 1000).unref();
