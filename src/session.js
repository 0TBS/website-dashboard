// Staying logged in. The desk key is typed once; the Worker answers with a
// cookie, and the browser sends that cookie with every request until someone
// presses Log off. The cookie is HttpOnly, so no script on the page can read
// it, and it is set by the Worker rather than by the page, so Safari does not
// clear it after seven days the way it clears localStorage.
//
// Kept apart from worker.js so it can be tested under plain Node.

export const COOKIE = 'desk_session';

// 400 days is the longest any browser keeps a cookie. Every visit sets it
// again, so the clock restarts each time and only Log off, a changed key or a
// cleared browser ends it.
export const MAX_AGE = 400 * 24 * 60 * 60;

const enc = new TextEncoder();

// The cookie holds a value derived from the key, not the key itself, so it
// cannot be turned back into the key. A new DASH_KEY gives a new value, which
// logs every browser out at once.
export async function sessionToken(key) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode('website-desk session v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every value sent under the cookie's name. Another *.10xid.com host could set
// a second one for the whole domain; any match counts, so a stray one cannot
// lock anyone out.
export function cookieValues(header, name = COOKIE) {
  if (!header) return [];
  return header.split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(name + '='))
    .map((p) => p.slice(name.length + 1));
}

// Secure only over HTTPS: `wrangler dev` is plain HTTP.
function cookie(value, maxAge, secure) {
  return [`${COOKIE}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Strict',
    ...(secure ? ['Secure'] : [])].join('; ');
}
export const sessionCookie = (token, secure) => cookie(token, MAX_AGE, secure);
export const clearCookie = (secure) => cookie('', 0, secure);
