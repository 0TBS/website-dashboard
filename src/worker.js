// The desk's only server code. Every request comes through here first
// (run_worker_first in wrangler.jsonc) so that plain HTTP can be turned away;
// the page itself is then served from public/ by the assets binding, and the
// Worker answers /api/* itself.
//
// The list lives in one Durable Object with its own SQLite database, not in
// D1: the account is at the Workers Free plan's limit of ten D1 databases,
// every one of them holding a client site's forms or blog. A single object is
// also the simplest thing that is strongly consistent — every read and write
// goes through the same instance, one at a time. On top of that, an edit can
// name the updated_at it started from, and is refused if the row has moved on
// since, so a stale edit cannot overwrite a teammate's newer one.

import { DurableObject } from 'cloudflare:workers';
import { cleanSite, toJson, InvalidField, FLAGS } from './sites.js';
import { sessionToken, cookieValues, sessionCookie, clearCookie } from './session.js';

const COLUMNS = ['name', 'live_domain', 'staging_domain', 'github_repo', 'live_platform', ...FLAGS, 'notes'];

// Made when the object first starts rather than by a migration step, so a
// fresh deploy works with nothing to run by hand.
const SCHEMA = `CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  live_domain    TEXT,
  staging_domain TEXT,
  github_repo    TEXT,
  live_platform  TEXT CHECK (live_platform IN ('astro','wordpress','other','none')),
  astro_staging  INTEGER CHECK (astro_staging IN (0,1)),
  domain_ours    INTEGER CHECK (domain_ours IN (0,1)),
  needs_seo_ppc  INTEGER CHECK (needs_seo_ppc IN (0,1)),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`;

// Fields reaching these methods have already been through cleanSite() in the
// Worker, so the object only stores and reads. Not found is null, not an
// error: errors lose their class crossing the RPC boundary.
export class Desk extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  list() {
    return this.sql.exec('SELECT * FROM sites ORDER BY name COLLATE NOCASE').toArray().map(toJson);
  }

  read(id) {
    const rows = this.sql.exec('SELECT * FROM sites WHERE id = ?', id).toArray();
    return rows.length ? toJson(rows[0]) : null;
  }

  create(fields) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const values = COLUMNS.map((c) => (c in fields ? fields[c] : null));
    this.sql.exec(
      `INSERT INTO sites (id, ${COLUMNS.join(', ')}, created_at, updated_at)
       VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      id, ...values, now, now
    );
    return this.read(id);
  }

  // Returns { site }, { missing: true }, or { conflict: true, site } when
  // `expected` (the updated_at the editor started from) is no longer current.
  // The read and the write run in one synchronous call, so nothing can land
  // between the check and the update.
  update(id, fields, expected) {
    const current = this.read(id);
    if (!current) return { missing: true };
    if (expected && current.updated_at !== expected) return { conflict: true, site: current };
    const keys = Object.keys(fields).filter((k) => COLUMNS.includes(k));
    if (!keys.length) return { site: current };
    this.sql.exec(
      `UPDATE sites SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => fields[k]), new Date().toISOString(), id
    );
    return { site: this.read(id) };
  }

  remove(id) {
    if (!this.read(id)) return false;
    this.sql.exec('DELETE FROM sites WHERE id = ?', id);
    return true;
  }
}

// The one instance, placed in eastern North America, near the team.
const desk = (env) => env.DESK.get(env.DESK.idFromName('desk'), { locationHint: 'enam' });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000',
    },
  });
}

// The zone's own "Always Use HTTPS" is off, and turning it on would change
// every *.10xid.com client host, so this host enforces HTTPS itself. On unless
// HTTPS_ONLY is "off", which only .dev.vars sets: `wrangler dev` is plain HTTP
// and rewrites the host to website.10xid.com, so the host cannot tell local
// from live.
function insecure(url, env) {
  return url.protocol === 'http:' && env.HTTPS_ONLY !== 'off';
}

async function digest(s) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

async function same(given, expected) {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// How a request shows it holds the key: 'bearer' (the Authorization header,
// for scripts and backups), 'cookie' (a browser that logged in), 'stale' (a
// login from before the key was changed), 'wrong' (a bearer key that does not
// match) or 'none'. Fails closed: with no DASH_KEY set there is no way in,
// rather than an open list of every client's domains and repos.
async function credential(request, env) {
  if (!env.DASH_KEY) return 'none';
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (given) return (await same(given, env.DASH_KEY)) ? 'bearer' : 'wrong';
  const sent = cookieValues(request.headers.get('cookie'));
  if (!sent.length) return 'none';
  const token = await sessionToken(env.DASH_KEY);
  for (const c of sent) if (await same(c, token)) return 'cookie';
  return 'stale';
}

function refuse(env, cred, secure) {
  if (!env.DASH_KEY) return json({ error: 'DASH_KEY is not set on this Worker.', code: 'no-key-configured' }, 401);
  if (cred === 'stale') {
    const res = json({ error: 'The desk key has changed since this browser logged in.', code: 'stale-session' }, 401);
    res.headers.append('set-cookie', clearCookie(secure));
    return res;
  }
  return json({ error: 'Wrong or missing desk key.', code: cred === 'wrong' ? 'bad-key' : 'locked' }, 401);
}

async function readBody(request) {
  try { return await request.json(); } catch { throw new InvalidField(null, 'Body is not valid JSON.'); }
}

// POST logs this browser in: the key is checked once and swapped for the
// cookie. DELETE is Log off.
async function handleSession(request, env, secure) {
  if (request.method === 'DELETE') {
    const res = json({ loggedIn: false });
    res.headers.append('set-cookie', clearCookie(secure));
    return res;
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!env.DASH_KEY) return refuse(env, 'none', secure);
  const body = await request.json().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key || key.length > 200 || !(await same(key, env.DASH_KEY))) {
    return json({ error: 'That is not the desk key.', code: 'bad-key' }, 401);
  }
  const res = json({ loggedIn: true });
  res.headers.append('set-cookie', sessionCookie(await sessionToken(env.DASH_KEY), secure));
  return res;
}

const notFound = () => json({ error: 'No site with that id.' }, 404);

async function handleApi(request, env, url) {
  const secure = url.protocol === 'https:';
  const parts = url.pathname.replace(/\/+$/, '').split('/'); // ['', 'api', 'sites', id?]
  if (parts[2] === 'session' && parts.length === 3) return handleSession(request, env, secure);

  const cred = await credential(request, env);
  if (cred !== 'bearer' && cred !== 'cookie') return refuse(env, cred, secure);
  // A browser sends the cookie even on a request another *.10xid.com page
  // starts. That page can send a plain POST without asking, but it cannot add
  // a header of its own without the browser first asking this Worker, which
  // never agrees. So a logged-in browser's changes must carry x-desk, which
  // only the desk's own page adds.
  if (cred === 'cookie' && request.method !== 'GET' && request.headers.get('x-desk') !== '1') {
    return json({ error: 'Changes must come from the desk page itself.', code: 'not-from-desk' }, 403);
  }

  const res = await handleSites(request, env, parts);
  // Each visit restarts the cookie's 400 days, so an active browser never expires.
  if (cred === 'cookie') res.headers.append('set-cookie', sessionCookie(await sessionToken(env.DASH_KEY), secure));
  return res;
}

async function handleSites(request, env, parts) {
  if (parts[2] !== 'sites' || parts.length > 4) return json({ error: 'Not found.' }, 404);
  const id = parts[3];
  const m = request.method;

  try {
    if (!id && m === 'GET') return json({ sites: await desk(env).list() });
    if (!id && m === 'POST') {
      const fields = cleanSite(await readBody(request), { creating: true });
      return json({ site: await desk(env).create(fields) }, 201);
    }
    if (id && m === 'PATCH') {
      const body = await readBody(request);
      const fields = cleanSite(body);
      if (!Object.keys(fields).length) throw new InvalidField(null, 'Nothing to change.');
      const expected = body.expected_updated_at;
      if (expected != null && (typeof expected !== 'string' || expected.length > 40)) {
        throw new InvalidField('expected_updated_at', 'expected_updated_at must be the updated_at string you last saw.');
      }
      const res = await desk(env).update(id, fields, expected || null);
      if (res.missing) return notFound();
      if (res.conflict) {
        return json({ error: 'Someone else changed this site while you were editing it.', code: 'conflict', site: res.site }, 409);
      }
      return json({ site: res.site });
    }
    if (id && m === 'DELETE') {
      return (await desk(env).remove(id)) ? json({ deleted: id }) : notFound();
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (e) {
    if (e instanceof InvalidField) return json({ error: e.message, field: e.field }, 400);
    throw e;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (insecure(url, env)) {
      // The API is refused rather than redirected: a client that sent the key
      // over plain HTTP should fail loudly, not be quietly retried.
      if (isApi) return json({ error: 'The desk only answers over HTTPS.', code: 'https-only' }, 403);
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (isApi) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
