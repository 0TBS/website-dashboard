// Who is going live. The desk key is shared by the whole team, so changing a
// client's DNS also needs the person's own Cloudflare Access login. Access
// signs a token (a JWT) that names them. This file checks the signature, that
// the token was made for this Access application, and that the email in it is
// on the Worker's allowlist.
//
// Kept apart from worker.js so it can be tested under plain Node. No library:
// Web Crypto verifies RS256 on its own.

const enc = new TextEncoder();
const dec = new TextDecoder();

// The settings this file needs. Routes add the Cloudflare API ones.
const CONFIG = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'GOLIVE_EMAILS'];

// Access's signing keys, imported once and kept for ten minutes per team.
// Importing costs CPU, and the Free plan allows 10 ms per request.
const KEY_TTL = 10 * 60 * 1000;
const keyCache = new Map(); // team origin -> { at, keys: Map(kid -> CryptoKey) }

// Clocks drift a little between Access and the Worker.
const EXPIRY_SKEW = 30 * 1000;
const FUTURE_SKEW = 60 * 1000;

// "TBox.cloudflareaccess.com" or "https://tbox.cloudflareaccess.com/" ->
// "https://tbox.cloudflareaccess.com", which is exactly the issuer Access
// writes into its tokens. Anything else is null: the keys are fetched from
// this address, so it must be an Access team and nothing else.
export function teamOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(host) ? 'https://' + host : null;
}

// "Ana@Example.com, ben@example.org\ncy@example.net" -> lower-case emails.
export function allowedEmails(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(/[\s,]+/).map((e) => e.toLowerCase()).filter(Boolean);
}

// Names only, never values. A team domain that is not an Access team, or an
// allowlist with nobody on it, counts as missing: either way nobody could go
// live, and the page should say which setting to fix.
export function accessConfigMissing(env) {
  const usable = {
    ACCESS_TEAM_DOMAIN: teamOrigin(env.ACCESS_TEAM_DOMAIN) !== null,
    ACCESS_AUD: typeof env.ACCESS_AUD === 'string' && env.ACCESS_AUD.trim() !== '',
    GOLIVE_EMAILS: allowedEmails(env.GOLIVE_EMAILS).length > 0,
  };
  return CONFIG.filter((name) => !usable[name]);
}

// For tests only: forget every cached key, so each test starts cold.
export function _resetKeyCache() {
  keyCache.clear();
}

const fail = (status, code, error) => ({ ok: false, status, code, error });
const invalid = (error) => fail(403, 'access-invalid', error);

// Base64url to bytes, or null for anything that is not strict base64url.
// The checks first mean atob() never sees input it would throw on.
function base64url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// A token part that must hold a JSON object; null when it holds anything else.
function jsonPart(s) {
  const bytes = base64url(s);
  if (!bytes) return null;
  try {
    const v = JSON.parse(dec.decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Splits and decodes a token without trusting any of it yet.
function parseToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = jsonPart(parts[0]);
  const payload = jsonPart(parts[1]);
  const signature = base64url(parts[2]);
  if (!header || !payload || !signature) return null;
  return { header, payload, signature, signed: enc.encode(parts[0] + '.' + parts[1]) };
}

// Every key the team's certs list holds, imported. Throws when the list
// cannot be had; the caller answers 503. A key this code cannot use is
// skipped, so one odd entry does not lock everyone out.
async function fetchKeys(team, fetchImpl) {
  const res = await fetchImpl(team + '/cdn-cgi/access/certs', {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) throw new Error('Access certs answered ' + res.status);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (typeof jwk?.kid !== 'string' || jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    } catch {
      // Not an RS256 key; the others still work.
    }
  }
  if (!keys.size) throw new Error('Access certs listed no usable key');
  return keys;
}

// The key a token names, or null when Access does not list it. A kid the
// fresh cache does not know fetches the list once more: Access rotates its
// keys every six weeks, and a token signed with the new key can arrive
// before the cache expires. One fetch at most per call, never a loop.
async function keyFor(team, kid, fetchImpl, now) {
  const cached = keyCache.get(team);
  if (cached && now - cached.at < KEY_TTL && cached.keys.has(kid)) return cached.keys.get(kid);
  const keys = await fetchKeys(team, fetchImpl);
  keyCache.set(team, { at: now, keys });
  return keys.get(kid) || null;
}

async function signatureMatches(key, jwt) {
  try {
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, jwt.signed);
  } catch {
    return false;
  }
}

// Why the claims are refused, or null when they are fine. aud is an array
// in Access tokens; a plain string is accepted too.
function claimProblem(p, env, team, now) {
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(env.ACCESS_AUD.trim())) return 'The Access token was made for a different Access application.';
  if (p.iss !== team) return 'The Access token was issued by a different Access team.';
  if (!Number.isFinite(p.exp)) return 'The Access token has no expiry time.';
  if (p.exp * 1000 <= now - EXPIRY_SKEW) return 'Your Access login has expired. Sign in again.';
  for (const claim of ['nbf', 'iat']) {
    if (p[claim] === undefined) continue;
    if (!Number.isFinite(p[claim]) || p[claim] * 1000 > now + FUTURE_SKEW) {
      return 'The Access token is dated in the future.';
    }
  }
  return null;
}

// The person the token names, if they are on the list. A service token (a
// script, not a person) has no email, only common_name, so it can never go
// live.
function person(p, env) {
  const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : '';
  if (!email) {
    return fail(403, 'not-allowed', p.common_name
      ? 'A Cloudflare Access service token cannot go live. Only a person signed in with their own email can.'
      : 'This Access login carries no email address, so the desk cannot tell who you are.');
  }
  if (!allowedEmails(env.GOLIVE_EMAILS).includes(email)) {
    return { ...fail(403, 'not-allowed', email + ' is not on the list of people who can go live.'), email };
  }
  return { ok: true, email };
}

// { ok: true, email } or { ok: false, status, code, error, email? }. Never
// throws on anything a request can carry.
export async function verifyAccess(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  // Fails closed, like DASH_KEY: with a setting missing nobody gets in.
  const missing = accessConfigMissing(env);
  if (missing.length) {
    return { ...fail(503, 'golive-not-set-up', 'Going live is not set up on this Worker.'), missing };
  }
  const team = teamOrigin(env.ACCESS_TEAM_DOMAIN);

  // The header only. Access does not promise to pass its cookie, and its
  // cf-access-authenticated-user-email header is not signed. Access sends a
  // signed-out person to its login page before the Worker sees the request,
  // so no token at all means Access is not in front of this path.
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    return fail(401, 'access-not-protecting', 'Cloudflare Access is not in front of /api/golive, so the desk refuses.');
  }

  const jwt = parseToken(token);
  if (!jwt) return invalid('The Access token is not a well-formed JWT.');
  // RS256 only, whatever the token asks for: letting the token pick is how
  // "alg: none" and HS256-signed-with-the-public-key forgeries get in.
  if (jwt.header.alg !== 'RS256') return invalid('The Access token is not signed with RS256.');
  if (typeof jwt.header.kid !== 'string' || !jwt.header.kid) return invalid('The Access token does not name its signing key.');

  let key;
  try {
    key = await keyFor(team, jwt.header.kid, fetchImpl, now);
  } catch {
    return fail(503, 'access-keys-unavailable',
      'Could not fetch the Cloudflare Access signing keys, so the desk cannot check who you are. Try again in a minute.');
  }
  if (!key) return invalid('The Access token is signed with a key Cloudflare Access does not list.');
  if (!(await signatureMatches(key, jwt))) return invalid('The Access token signature does not match.');

  const problem = claimProblem(jwt.payload, env, team, now);
  if (problem) return invalid(problem);
  return person(jwt.payload, env);
}
