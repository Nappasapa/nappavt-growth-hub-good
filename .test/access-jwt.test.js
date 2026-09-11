// Access JWT verification (RS256 against a JWKS endpoint) — the production
// security boundary, exercised with REAL signatures. Builds a throwaway RSA
// key pair, serves {keys:[jwk]} from a local HTTP endpoint pointing at the
// verifier's teamDomain, then signs/garbles Access-style JWTs.
//
// Run: node .test/access-jwt.test.js

const { createServer } = require('node:http');
const path = require('node:path');

const { verifyAccessJwt } = require(path.join('..', 'functions', '_lib', 'auth.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok -', name); } else { fail++; console.error('  FAIL -', name, String(extra).slice(0, 300)); }
};

const b64url = bufOrObj => {
  const buf = typeof bufOrObj === 'string' || Buffer.isBuffer(bufOrObj)
    ? Buffer.from(bufOrObj)
    : Buffer.from(JSON.stringify(bufOrObj));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

(async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'test-kid-1';
  jwk.alg = 'RS256';
  // A second, valid publishable key the attacker does NOT know (tests kid selection)
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const otherJwk = await crypto.subtle.exportKey('jwk', other.publicKey);
  otherJwk.kid = 'test-kid-2';
  otherJwk.alg = 'RS256';

  const server = createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk, otherJwk] }));
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const TEAM = `127.0.0.1:${port}`;
  const AUD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ISS = `https://${TEAM}`;

  // The verifier always builds https://<teamDomain>/cdn-cgi/access/certs (as it
  // must in production). For the test we bridge those requests down to our
  // plain-HTTP JWKS server — signature verification itself is untouched.
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith(`https://${TEAM}/`)) return realFetch(`http://${TEAM}/${u.slice(`https://${TEAM}/`.length)}`, opts);
    return realFetch(url, opts);
  };

  async function sign(payload, { kid = 'test-kid-1', key = privateKey, alg = 'RS256' } = {}) {
    const header = b64url({ alg, kid, typ: 'JWT' });
    const body = b64url(payload);
    const data = new TextEncoder().encode(`${header}.${body}`);
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data);
    return `${header}.${body}.${b64url(Buffer.from(sig))}`;
  }
  const nowSec = () => Math.floor(Date.now() / 1000);
  const basePayload = () => ({
    email: 'Viewer@Example.com',
    iss: ISS,
    aud: AUD,
    exp: nowSec() + 3600,
    iat: nowSec() - 5,
  });

  console.log('access-jwt verification:');

  // --- happy path
  {
    const payload = basePayload();
    const out = await verifyAccessJwt(await sign(payload), TEAM, AUD);
    t('valid token verifies and returns payload', !!out && out.email === 'Viewer@Example.com', JSON.stringify(out));
  }
  // --- second published key (kid selection)
  {
    const payload = basePayload();
    const out = await verifyAccessJwt(await sign(payload, { kid: 'test-kid-2', key: other.privateKey }), TEAM, AUD);
    t('valid token with second key id verifies', !!out && out.email === payload.email);
  }

  // --- adversarial cases, each must return null
  const cases = [];
  cases.push(['tampered payload (email swap) fails', async () => {
    const good = await sign(basePayload());
    const [h, , s] = good.split('.');
    const evil = `${h}.${b64url({ ...basePayload(), email: 'attacker@evil.example' })}.${s}`;
    return verifyAccessJwt(evil, TEAM, AUD);
  }]);
  cases.push(['alg=none style (no signature bytes) fails', async () => {
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(basePayload())}.`;
    return verifyAccessJwt(token, TEAM, AUD);
  }]);
  cases.push(['HS256-labelled header fails (algorithm confusion)', async () => {
    const token = `${b64url({ alg: 'HS256', kid: 'test-kid-1' })}.${b64url(basePayload())}.${b64url('sig')}`;
    return verifyAccessJwt(token, TEAM, AUD);
  }]);
  cases.push(['token signed by unknown private key fails', async () => {
    const evil = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    return verifyAccessJwt(await sign(basePayload(), { kid: 'test-kid-1', key: evil.privateKey }), TEAM, AUD);
  }]);
  cases.push(['unknown kid fails', async () => {
    return verifyAccessJwt(await sign(basePayload(), { kid: 'no-such-kid' }), TEAM, AUD);
  }]);
  cases.push(['wrong audience fails', async () => {
    return verifyAccessJwt(await sign({ ...basePayload(), aud: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), TEAM, AUD);
  }]);
  cases.push(['verifying against a different AUD fails (no token reuse across apps)', async () => {
    return verifyAccessJwt(await sign(basePayload()), TEAM, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
  }]);
  cases.push(['wrong issuer fails', async () => {
    return verifyAccessJwt(await sign({ ...basePayload(), iss: 'https://evil-team.cloudflareaccess.com' }), TEAM, AUD);
  }]);
  cases.push(['expired token fails (beyond clock skew)', async () => {
    return verifyAccessJwt(await sign({ ...basePayload(), exp: nowSec() - 3600 }), TEAM, AUD);
  }]);
  cases.push(['not-yet-valid token fails (nbf beyond skew)', async () => {
    return verifyAccessJwt(await sign({ ...basePayload(), nbf: nowSec() + 3600 }), TEAM, AUD);
  }]);
  cases.push(['missing email claim fails', async () => {
    const p = basePayload(); delete p.email;
    return verifyAccessJwt(await sign(p), TEAM, AUD);
  }]);
  cases.push(['garbage token fails without throwing', async () => {
    return verifyAccessJwt('not-a-jwt', TEAM, AUD);
  }]);
  cases.push(['empty token fails without throwing', async () => {
    return verifyAccessJwt('', TEAM, AUD);
  }]);
  cases.push(['audience given as array including the AUD passes', async () => {
    const out = await verifyAccessJwt(await sign({ ...basePayload(), aud: ['other', AUD] }), TEAM, AUD);
    return out && out.email ? out : null;   // expected PASS — inverted check below
  }]);

  for (const [name, fn] of cases) {
    const expectPass = name.startsWith('audience given as array');
    try {
      const out = await fn();
      if (expectPass) t(name, !!out, `expected payload, got ${JSON.stringify(out)}`);
      else t(name, out === null, `expected null, got ${JSON.stringify(out)}`);
    } catch (err) {
      t(name, false, `threw: ${err.message}`);
    }
  }

  // --- JWKS cache actually caches (kill the server: cached key must still verify)
  {
    server.close();
    const out = await verifyAccessJwt(await sign(basePayload()), TEAM, AUD);
    t('JWKS cache: verification survives certs endpoint outage', !!out && out.email === 'Viewer@Example.com');
  }

  console.log(`\naccess-jwt: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('SUITE CRASH:', err); process.exit(1); });
