// /api/* middleware: uniform error envelope + security headers.
import { json } from '../_lib/http.js';

export async function onRequest(context) {
  try {
    const response = await context.next();
    const headers = new Headers(response.headers);
    if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
    if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'no-referrer');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (err) {
    // Never leak internals, tokens or stack traces to the client.
    console.error('[growth-hub api] unhandled error:', err && err.message ? err.message : 'unknown');
    return json({ error: 'internal_error' }, { status: 500 });
  }
}
