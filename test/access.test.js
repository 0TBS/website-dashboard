import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccess, accessConfigMissing, teamOrigin, allowedEmails, _resetKeyCache } from '../src/access.js';

const TEAM = 'https://tbox.cloudflareaccess.com';
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';
const NOW = Date.UTC(2026, 8, 25, 15, 0, 0);
const SEC = NOW / 1000;
const MIN = 60 * 1000;

const env = {
  ACCESS_TEAM_DOMAIN: 'tbox.cloudflareaccess.com',
  ACCESS_AUD: AUD,
  GOLIVE_EMAILS: 'ana@example.com, ben@example.org',
};

const enc = new TextEncoder();
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// A real RS256 key pair. The public half is shaped like an entry in Access's
// certs list: kid, kty, alg, use, e, n and nothing else.
async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const { kty, e, n } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty, alg: 'RS256', use: 'sig', e, n } };
}
const [current, next] = await Promise.all([makeKey('kid-current'), makeKey('kid-next')]);

// A person's application token, as Access issues it.
const claims = (extra = {}) => ({
  aud: [AUD], email: 'ana@example.com', exp: SEC + 3600, iat: SEC - 10, nbf: SEC - 10,
  iss: TEAM, type: 'app', identity_nonce: 'nonce', sub: 'user-1', country: 'CA', ...extra,
});

async function sign(payload, { key = current, header = { alg: 'RS256', kid: key.kid, typ: 'JWT' } } = {}) {
  const input = b64(header) + '.' + b64(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(input));
  return input + '.' + Buffer.from(sig).toString('base64url');
}

// A stand-in for the certs endpoint. Each call answers with the next list of
// keys given, and the last list repeats. Every call is recorded.
function certs(...lists) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const keys = lists[Math.min(calls.length - 1, lists.length - 1)];
    return Response.json({ keys, public_cert: {}, public_certs: [] });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const request = (headers = {}) => new Request('https://website.10xid.com/api/golive/me', { headers });

function check(token, { env: e = env, fetchImpl = certs([current.jwk, next.jwk]), now = NOW } = {}) {
  return verifyAccess(request({ 'cf-access-jwt-assertion': token }), e, { fetchImpl, now });
}

beforeEach(() => _resetKeyCache());

test('a valid Access token names the person, in lower case', async () => {
  const fetchImpl = certs([current.jwk, next.jwk]);
  const res = await check(await sign(claims({ email: ' Ana@Example.com ' })), { fetchImpl });
  assert.deepEqual(res, { ok: true, email: 'ana@example.com' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://tbox.cloudflareaccess.com/cdn-cgi/access/certs');
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual', 'a redirect is never followed');
  assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal, 'a hung fetch gives up');
});

test('keys are fetched once and kept for ten minutes, per team', async () => {
  const fetchImpl = certs([current.jwk]);
  const token = await sign(claims());
  assert.equal((await check(token, { fetchImpl })).ok, true);
  assert.equal((await check(token, { fetchImpl, now: NOW + 9 * MIN })).ok, true);
  assert.equal(fetchImpl.calls.length, 1, 'nine minutes later the cached keys serve');
  assert.equal((await check(token, { fetchImpl, now: NOW + 10 * MIN })).ok, true);
  assert.equal(fetchImpl.calls.length, 2, 'after ten minutes they are fetched again');

  const other = { ...env, ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com' };
  const otherToken = await sign(claims({ iss: 'https://other.cloudflareaccess.com' }));
  assert.equal((await check(otherToken, { env: other, fetchImpl, now: NOW + 10 * MIN })).ok, true);
  assert.equal(fetchImpl.calls.length, 3, 'another team has keys of its own');
  assert.equal(fetchImpl.calls[2].url, 'https://other.cloudflareaccess.com/cdn-cgi/access/certs');
});

test('a key Access has just rotated in is found by fetching the list once more', async () => {
  const fetchImpl = certs([current.jwk], [current.jwk, next.jwk]);
  assert.equal((await check(await sign(claims()), { fetchImpl })).ok, true);
  const res = await check(await sign(claims(), { key: next }), { fetchImpl, now: NOW + MIN });
  assert.deepEqual(res, { ok: true, email: 'ana@example.com' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal((await check(await sign(claims(), { key: next }), { fetchImpl, now: NOW + 2 * MIN })).ok, true);
  assert.equal(fetchImpl.calls.length, 2, 'the new key is cached with the rest');
});

test('a kid Access never lists is refused after one more fetch, not in a loop', async () => {
  const fetchImpl = certs([current.jwk]);
  const stranger = await sign(claims(), { header: { alg: 'RS256', kid: 'kid-unknown' } });

  const cold = await check(stranger, { fetchImpl });
  assert.equal(cold.code, 'access-invalid');
  assert.equal(fetchImpl.calls.length, 1, 'a cold cache fetches once and does not fetch again');

  assert.equal((await check(await sign(claims()), { fetchImpl })).ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  const warm = await check(stranger, { fetchImpl });
  assert.equal(warm.status, 403);
  assert.equal(warm.code, 'access-invalid');
  assert.match(warm.error, /key Cloudflare Access does not list/);
  assert.equal(fetchImpl.calls.length, 2, 'a warm cache refetches exactly once');
});

test('a wrong signature is refused', async () => {
  // Signed with another key but claiming to be the current one.
  const forged = await sign(claims(), { key: next, header: { alg: 'RS256', kid: current.kid } });
  const res = await check(forged, { fetchImpl: certs([current.jwk]) });
  assert.deepEqual(res, { ok: false, status: 403, code: 'access-invalid', error: 'The Access token signature does not match.' });

  // A genuine token with someone else's claims swapped in.
  const [h, , s] = (await sign(claims())).split('.');
  const swapped = [h, b64(claims({ email: 'eve@example.com' })), s].join('.');
  assert.equal((await check(swapped)).code, 'access-invalid');

  const good = await sign(claims());
  assert.equal((await check(good.slice(0, -4))).code, 'access-invalid', 'a cut-short signature');
  assert.equal((await check(good.slice(0, good.lastIndexOf('.') + 1) + 'AAAA')).code, 'access-invalid');
});

test('only RS256 is accepted: alg none and HS256 are refused before any key is fetched', async () => {
  const fetchImpl = certs([current.jwk]);
  const payload = b64(claims());

  const none = [
    b64({ alg: 'none', kid: current.kid }) + '.' + payload + '.',
    b64({ alg: 'none', kid: current.kid }) + '.' + payload + '.' + b64('x'),
  ];
  // The classic confusion: HMAC keyed with the public key, which anyone has.
  const hsInput = b64({ alg: 'HS256', kid: current.kid, typ: 'JWT' }) + '.' + payload;
  const hmac = await crypto.subtle.importKey('raw', enc.encode(JSON.stringify(current.jwk)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hs256 = hsInput + '.' + Buffer.from(await crypto.subtle.sign('HMAC', hmac, enc.encode(hsInput))).toString('base64url');
  const others = await Promise.all([
    sign(claims(), { header: { alg: 'RS512', kid: current.kid } }),
    sign(claims(), { header: { alg: 'rs256', kid: current.kid } }),
    sign(claims(), { header: { kid: current.kid } }),
  ]);

  for (const token of [...none, hs256, ...others]) {
    const res = await check(token, { fetchImpl });
    assert.equal(res.status, 403, token);
    assert.equal(res.code, 'access-invalid', token);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('a token that does not name its key is refused', async () => {
  const fetchImpl = certs([current.jwk]);
  for (const header of [{ alg: 'RS256' }, { alg: 'RS256', kid: '' }, { alg: 'RS256', kid: 7 }]) {
    const res = await check(await sign(claims(), { header }), { fetchImpl });
    assert.equal(res.code, 'access-invalid', JSON.stringify(header));
    assert.match(res.error, /does not name its signing key/);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('an expired token is refused, with 30 seconds allowed for clock drift', async () => {
  const expired = await check(await sign(claims({ exp: SEC - 31 })));
  assert.equal(expired.code, 'access-invalid');
  assert.match(expired.error, /expired/);
  assert.equal((await check(await sign(claims({ exp: SEC - 30 })))).code, 'access-invalid');
  assert.equal((await check(await sign(claims({ exp: SEC - 29 })))).ok, true);
  assert.equal((await check(await sign(claims({ exp: undefined })))).code, 'access-invalid', 'no expiry at all');
  assert.equal((await check(await sign(claims({ exp: String(SEC + 3600) })))).code, 'access-invalid');
});

test('a token dated in the future is refused, with 60 seconds allowed', async () => {
  assert.equal((await check(await sign(claims({ nbf: SEC + 61 })))).code, 'access-invalid');
  assert.equal((await check(await sign(claims({ nbf: SEC + 59 })))).ok, true);
  assert.equal((await check(await sign(claims({ iat: SEC + 120 })))).code, 'access-invalid');
  assert.equal((await check(await sign(claims({ iat: 'soon' })))).code, 'access-invalid');
  assert.equal((await check(await sign(claims({ nbf: undefined, iat: undefined })))).ok, true, 'both are optional');
});

test('aud must name this application, as an array or as a string', async () => {
  assert.equal((await check(await sign(claims({ aud: [AUD] })))).ok, true);
  assert.equal((await check(await sign(claims({ aud: AUD })))).ok, true);
  assert.equal((await check(await sign(claims({ aud: ['another-app', AUD] })))).ok, true);
  assert.equal((await check(await sign(claims()), { env: { ...env, ACCESS_AUD: ` ${AUD}\n` } })).ok, true);

  for (const aud of [['another-app'], 'another-app', [], AUD + 'x', undefined, [[AUD]]]) {
    const res = await check(await sign(claims({ aud })));
    assert.equal(res.code, 'access-invalid', JSON.stringify(aud));
    assert.match(res.error, /different Access application/);
  }
});

test('iss must be exactly the team address', async () => {
  const wrong = ['https://other.cloudflareaccess.com', TEAM + '/', 'http://tbox.cloudflareaccess.com',
    'tbox.cloudflareaccess.com', 'https://TBOX.cloudflareaccess.com', undefined];
  for (const iss of wrong) {
    const res = await check(await sign(claims({ iss })));
    assert.equal(res.code, 'access-invalid', String(iss));
    assert.match(res.error, /different Access team/);
  }
});

test('a service token or a login with no email can never go live', async () => {
  // What Access issues for a service token: common_name instead of an email.
  const service = { type: 'app', aud: [AUD], exp: SEC + 3600, iss: TEAM, common_name: 'e367826f93b8d71185e03fe518aff3b4.access', iat: SEC - 10, sub: '' };
  const res = await check(await sign(service));
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.code, 'not-allowed');
  assert.match(res.error, /service token cannot go live/);
  assert.ok(!('email' in res));

  for (const email of [undefined, '', '   ', 42, ['ana@example.com']]) {
    const r = await check(await sign(claims({ email })));
    assert.equal(r.code, 'not-allowed', JSON.stringify(email));
    assert.match(r.error, /no email address/);
  }
});

test('an email not on the list is refused and named', async () => {
  const res = await check(await sign(claims({ email: 'Eve@Example.com' })));
  assert.deepEqual(res, {
    ok: false, status: 403, code: 'not-allowed',
    error: 'eve@example.com is not on the list of people who can go live.', email: 'eve@example.com',
  });
  for (const email of ['na@example.com', 'ana@example.co', 'ana@example.com.evil.net']) {
    assert.equal((await check(await sign(claims({ email })))).code, 'not-allowed', 'no partial matches: ' + email);
  }
});

test('the allowlist is read case-insensitively, split on commas and white space', async () => {
  assert.deepEqual(allowedEmails('Ana@Example.com, ben@example.org\n  cy@example.net,,dee@example.com\t'),
    ['ana@example.com', 'ben@example.org', 'cy@example.net', 'dee@example.com']);
  assert.deepEqual(allowedEmails('ana@example.com ben@example.org'), ['ana@example.com', 'ben@example.org']);
  assert.deepEqual(allowedEmails(' , \n'), []);
  assert.deepEqual(allowedEmails(undefined), []);

  const list = { ...env, GOLIVE_EMAILS: 'ANA@EXAMPLE.COM\tBen@Example.org' };
  assert.deepEqual(await check(await sign(claims({ email: 'ben@EXAMPLE.org' })), { env: list }),
    { ok: true, email: 'ben@example.org' });
  assert.deepEqual(await check(await sign(claims({ email: 'ana@example.com' })), { env: list }),
    { ok: true, email: 'ana@example.com' });
});

test('with a setting missing, going live is refused without fetching anything', async () => {
  assert.deepEqual(accessConfigMissing(env), []);
  assert.deepEqual(accessConfigMissing({}), ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'GOLIVE_EMAILS']);
  assert.deepEqual(accessConfigMissing({ ...env, ACCESS_AUD: '  ' }), ['ACCESS_AUD']);
  assert.deepEqual(accessConfigMissing({ ...env, GOLIVE_EMAILS: ', ' }), ['GOLIVE_EMAILS'], 'a list with nobody on it');
  assert.deepEqual(accessConfigMissing({ ...env, ACCESS_TEAM_DOMAIN: 'example.com' }), ['ACCESS_TEAM_DOMAIN'], 'not an Access team');

  const fetchImpl = certs([current.jwk]);
  const token = await sign(claims());
  const res = await check(token, { env: {}, fetchImpl });
  assert.equal(res.status, 503);
  assert.equal(res.code, 'golive-not-set-up');
  assert.deepEqual(res.missing, ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'GOLIVE_EMAILS']);

  const partial = await check(token, { env: { ...env, GOLIVE_EMAILS: '' }, fetchImpl });
  assert.deepEqual(partial.missing, ['GOLIVE_EMAILS']);
  assert.ok(!JSON.stringify(partial).includes(AUD), 'names only, never values');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a malformed token is refused, never thrown', async () => {
  const fetchImpl = certs([current.jwk]);
  const header = b64({ alg: 'RS256', kid: current.kid });
  const payload = b64(claims());
  const sig = b64('signature');
  const malformed = [
    'garbage', 'a.b', 'a.b.c.d', '..', '...', `${header}.${payload}`,
    `${header}.${payload}.${sig}.${sig}`,
    `${b64('not json')}.${payload}.${sig}`,
    `${header}.${b64('{"email":')}.${sig}`,
    `${b64('"RS256"')}.${payload}.${sig}`,
    `${b64('null')}.${payload}.${sig}`,
    `${header}.${b64([claims()])}.${sig}`,
    `${header}.${payload}.${sig}==`,
    `${header}.${payload}.a`,
    `${header}$.${payload}.${sig}`,
    `${header}.${payload}. ${sig}`,
    `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: current.kid })).toString('base64')}.${payload}.${sig}`,
    `${header}.${Buffer.from([0xff, 0xfe, 0x7b]).toString('base64url')}.${sig}`,
  ];
  for (const token of malformed) {
    const res = await check(token, { fetchImpl });
    assert.equal(res.status, 403, token);
    assert.equal(res.code, 'access-invalid', token);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('the team domain is accepted with or without https:// and a trailing slash', async () => {
  for (const raw of ['tbox.cloudflareaccess.com', 'https://tbox.cloudflareaccess.com', 'https://tbox.cloudflareaccess.com/',
    ' HTTPS://TBox.CloudflareAccess.com// ']) {
    assert.equal(teamOrigin(raw), TEAM, raw);
  }
  for (const raw of ['http://tbox.cloudflareaccess.com', 'tbox.cloudflareaccess.com/cdn-cgi', 'example.com',
    'tbox.cloudflareaccess.com.example.com', 'cloudflareaccess.com', 'a.tbox.cloudflareaccess.com',
    'tbox.cloudflareaccess.com:443', '', undefined, 42]) {
    assert.equal(teamOrigin(raw), null, String(raw));
  }

  const fetchImpl = certs([current.jwk]);
  const res = await check(await sign(claims()), { env: { ...env, ACCESS_TEAM_DOMAIN: 'https://TBox.cloudflareaccess.com/' }, fetchImpl });
  assert.equal(res.ok, true, 'iss is checked against the normalised address');
  assert.equal(fetchImpl.calls[0].url, 'https://tbox.cloudflareaccess.com/cdn-cgi/access/certs', 'no doubled slash');
});

test('without the Access header the desk refuses, and never trusts the unsigned email header or the cookie', async () => {
  const fetchImpl = certs([current.jwk]);
  const token = await sign(claims());
  for (const headers of [{}, { 'cf-access-authenticated-user-email': 'ana@example.com' }, { cookie: 'CF_Authorization=' + token }]) {
    const res = await verifyAccess(request(headers), env, { fetchImpl, now: NOW });
    assert.deepEqual(res, {
      ok: false, status: 401, code: 'access-not-protecting',
      error: 'Cloudflare Access is not in front of /api/golive, so the desk refuses.',
    });
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('when the keys cannot be fetched the answer is a clear 503, not a crash', async () => {
  const token = await sign(claims());
  const broken = [
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('oops', { status: 500 }),
    async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/certs' } }),
    async () => new Response('<html>not json</html>', { status: 200 }),
    async () => Response.json({ keys: [] }),
    async () => Response.json({ nothing: true }),
    async () => Response.json({ keys: [{ kid: 'ec', kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }] }),
  ];
  for (const fetchImpl of broken) {
    const res = await check(token, { fetchImpl });
    assert.equal(res.status, 503, String(fetchImpl));
    assert.equal(res.code, 'access-keys-unavailable');
    assert.match(res.error, /Could not fetch the Cloudflare Access signing keys/);
  }
  // A failure is not cached: the next request tries again.
  assert.equal((await check(token, { fetchImpl: certs([current.jwk]) })).ok, true);
});

test('a refetch that fails after an unknown kid is a 503 too', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? Response.json({ keys: [current.jwk] }) : new Response('down', { status: 502 }));
  assert.equal((await check(await sign(claims()), { fetchImpl })).ok, true);
  const res = await check(await sign(claims(), { key: next }), { fetchImpl });
  assert.equal(res.code, 'access-keys-unavailable');
  assert.equal((await check(await sign(claims()), { fetchImpl })).ok, true, 'the keys already held still work');
  assert.equal(calls, 2);
});

test('a listed key the desk cannot use is skipped, and the others still work', async () => {
  const odd = [
    { kid: 'bad-n', kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB', n: '!!' },
    { ...next.jwk, kid: 'wrong-alg', alg: 'RS512' },
    { kty: 'RSA', e: current.jwk.e, n: current.jwk.n },
    null,
    'text',
    current.jwk,
  ];
  assert.equal((await check(await sign(claims()), { fetchImpl: certs(odd) })).ok, true);
  const res = await check(await sign(claims(), { key: next, header: { alg: 'RS256', kid: 'wrong-alg' } }), { fetchImpl: certs(odd) });
  assert.equal(res.code, 'access-invalid', 'a key that failed to import is as good as unlisted');
});
