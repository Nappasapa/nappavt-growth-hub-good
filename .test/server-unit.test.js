// Unit tests for the Node.js backend (no database required).
// Covers the pieces that carry security/compat weight in pure form.

'use strict';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok -', name); } else { fail++; console.error('  FAIL -', name, String(extra).slice(0, 300)); }
};

(async () => {
  console.log('server unit tests:');

  // ---- scrypt password hashing
  const auth = await import('../server/auth.mjs');
  {
    const h = auth.hashPassword('correct horse battery staple');
    t('scrypt hash format', typeof h === 'string' && h.startsWith('scrypt$16384$8$1$'));
    t('scrypt verify accepts correct password', auth.verifyPassword('correct horse battery staple', h));
    t('scrypt verify rejects wrong password', !auth.verifyPassword('wrong', h));
    t('scrypt verify rejects garbage stored hash', !auth.verifyPassword('x', 'not-a-hash'));
    t('scrypt verify rejects null stored value', !auth.verifyPassword('x', null));
    const h2 = auth.hashPassword('correct horse battery staple');
    t('scrypt salting is random (two hashes differ)', h !== h2 && auth.verifyPassword('correct horse battery staple', h2));
  }

  // ---- secureCompare
  const http = await import('../server/http.mjs');
  {
    t('secureCompare equality', http.secureCompare('abc', 'abc'));
    t('secureCompare mismatch', !http.secureCompare('abc', 'abd'));
    t('secureCompare length mismatch', !http.secureCompare('abc', 'abcd'));
    t('secureCompare null-safe', !http.secureCompare(null, 'a') && http.secureCompare(null, null));
  }

  // ---- SQL statement splitter
  const { splitStatements } = await import('../server/sql.mjs');
  const { readFileSync } = await import('node:fs');
  {
    const stmts = splitStatements(readFileSync('server/migrations/0001_init.sql', 'utf8'));
    t('schema splits into 7 CREATE TABLE statements', stmts.length === 7 && stmts.every(s => /^CREATE TABLE/i.test(s.trim())), `n=${stmts.length}`);
    const tricky = splitStatements("INSERT INTO t VALUES ('a;b', \"c;d\", `e;f`); -- comment ;\n/* ; block ; */ UPDATE t SET a='y''es' WHERE b=2;");
    t('splitter ignores semicolons in quotes/comments', tricky.length === 2, JSON.stringify(tricky));
    const down = splitStatements(readFileSync('server/migrations/0001_init.down.sql', 'utf8'));
    t('down migration splits into 7 DROPs', down.length === 7 && down.every(s => /^DROP TABLE/i.test(s.trim())), `n=${down.length}`);
  }

  // ---- timestamp conversion
  const db = await import('../server/db.mjs');
  {
    t('isoToDb → UTC DATETIME(3)', db.isoToDb('2026-09-11T08:15:30.500Z') === '2026-09-11 08:15:30.500', db.isoToDb('2026-09-11T08:15:30.500Z'));
    t('isoToDb handles postgres offsets', db.isoToDb('2026-09-06T20:04:11.123456+00:00') === '2026-09-06 20:04:11.123', db.isoToDb('2026-09-06T20:04:11.123456+00:00'));
    t('isoToDb(null) → null', db.isoToDb(null) === null);
    t('dbToIso → ISO-8601 Z', db.dbToIso('2026-09-11 08:15:30.500') === '2026-09-11T08:15:30.500Z', db.dbToIso('2026-09-11 08:15:30.500'));
    t('dbToIso normalizes pg-style +00:00', db.dbToIso('2026-09-06T20:04:11+00:00') === '2026-09-06T20:04:11.000Z', db.dbToIso('2026-09-06T20:04:11+00:00'));
    t('ISO strings sort lexicographically (revision contract)', db.dbToIso('2026-09-06 20:04:11') < db.dbToIso('2026-09-06 20:04:12'));
  }

  // ---- clip key guards / content types
  const storage = await import('../server/storage.mjs');
  {
    t('valid legacy clip key passes', storage.sanitizeClipKey('11111111-2222-4333-8444-555555555555/1722500000_abc_old.mp4') !== null);
    t('traversal rejected', storage.sanitizeClipKey('a/../b') === null && storage.sanitizeClipKey('../x') === null && storage.sanitizeClipKey('a//b') === null);
    t('absolute/endpoint paths rejected', storage.sanitizeClipKey('/a') === null && storage.sanitizeClipKey('a/') === null);
    t('backslashes normalized then guarded', storage.sanitizeClipKey('a\\..\\x') === null);
    t('non-ascii rejected', storage.sanitizeClipKey('a/🚀.mp4') === null);
    t('content-type mapping', storage.clipContentType('x/y.mp4') === 'video/mp4' && storage.clipContentType('x/y.mov') === 'video/quicktime' && storage.clipContentType('x/y.bin') === 'application/octet-stream');
  }

  // ---- rate limiter
  const { rateLimitCheck } = await import('../server/ratelimit.mjs');
  {
    const key = 'test:' + Math.random();
    t('first calls allowed', rateLimitCheck(key, { windowMs: 1000, max: 2 }).allowed && rateLimitCheck(key, { windowMs: 1000, max: 2 }).allowed);
    const third = rateLimitCheck(key, { windowMs: 1000, max: 2 });
    t('third call blocked with retry-after', !third.allowed && third.retryAfterSeconds >= 1, JSON.stringify(third));
    await new Promise(r => setTimeout(r, 1100));
    t('window expiry allows again', rateLimitCheck(key, { windowMs: 1000, max: 2 }).allowed);
  }

  // ---- route matcher incl. wildcard/params
  {
    const routes = [
      { method: 'GET', pattern: '/api/notes/:id', handler: () => {} },
      { method: 'GET', pattern: '/api/clips/*', handler: () => {} },
      { method: 'GET', pattern: '/api/me', handler: () => {} },
      { method: 'POST', pattern: '/api/me', handler: () => {} },
    ];
    const hit1 = http.matchRoute(routes, 'GET', '/api/notes/abc-123');
    t('param route matches + extracts id', Boolean(hit1 && hit1.params.id === 'abc-123'));
    const hit2 = http.matchRoute(routes, 'GET', '/api/clips/uuid-1/file.mp4');
    t('wildcard route captures rest', Boolean(hit2 && hit2.params.rest === 'uuid-1/file.mp4'));
    const hit3 = http.matchRoute(routes, 'DELETE', '/api/notes/x');
    t('unknown method on known path → methodNotAllowed', Boolean(hit3 && hit3.methodNotAllowed));
    t('unknown path → no match', http.matchRoute(routes, 'GET', '/api/nope') === null);
  }

  // ---- origin guard
  {
    const req = host => ({ headers: { host: 'hub.example', origin: host } });
    t('same-origin mutation allowed', !http.widthBadOrigin?.(req('https://hub.example')) && !http.badOrigin(req('https://hub.example'), ''));
    t('foreign origin blocked', http.badOrigin(req('https://evil.example'), ''));
    t('APP_ORIGIN override honored', !http.badOrigin(req('https://app.example'), 'https://app.example'));
    t('missing Origin header → allowed (curl/native clients)', !http.badOrigin({ headers: { host: 'hub.example' } }, ''));
  }

  // ---- config redaction keeps secrets out of logs
  {
    const { redactedConfigSummary } = await import('../server/config.mjs');
    const text = JSON.stringify(redactedConfigSummary());
    t('redacted config has no password/token values', !/change-me|password':'|"token":/.test(text), text.slice(0, 200));
    t('redacted config still reports boolean flag presence', text.includes('"passwordSet"') && text.includes('"botTokenSet"'));
  }

  console.log(`\nserver-unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('SUITE CRASH:', err); process.exit(1); });
