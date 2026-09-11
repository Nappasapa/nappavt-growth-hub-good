// Public health probe. Reveals only binding presence, no data.
import { json, nowIso } from '../_lib/http.js';

export async function onRequestGet(context) {
  return json({
    ok: true,
    service: 'nappavt-growth-hub-api',
    d1: Boolean(context.env.DB),
    r2: Boolean(context.env.CLIPS),
    time: nowIso(),
  });
}
