// The desk's only server code. The page itself is a static file served from
// public/ before this runs; the Worker answers /api/* alone (see
// run_worker_first in wrangler.jsonc) and keeps the list in D1.

import { cleanSite, toJson, InvalidField, FLAGS } from './sites.js';

const COLUMNS = ['name', 'live_domain', 'staging_domain', 'github_repo', 'live_platform', ...FLAGS, 'notes'];

// The table is made on first use rather than by a migration step, so a fresh
// deploy works with nothing to run by hand. Memoised per isolate: after the
// first request it costs nothing.
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
let ready = null;
function ensureSchema(db) {
  if (!ready) ready = db.prepare(SCHEMA).run().catch((e) => { ready = null; throw e; });
  return ready;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  });
}

async function digest(s) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

// Fails closed: with no DASH_KEY set there is no way in, rather than an open
// list of every client's domains and repos.
async function authorised(request, env) {
  if (!env.DASH_KEY) return false;
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given) return false;
  const [a, b] = await Promise.all([digest(given), digest(env.DASH_KEY)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function readBody(request) {
  try { return await request.json(); } catch { throw new InvalidField(null, 'Body is not valid JSON.'); }
}

async function getSite(db, id) {
  const row = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  return row ? toJson(row) : null;
}

async function listSites(db) {
  const { results } = await db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE').all();
  return json({ sites: results.map(toJson) });
}

async function createSite(db, request) {
  const fields = cleanSite(await readBody(request), { creating: true });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const values = COLUMNS.map((c) => (c in fields ? fields[c] : null));
  await db.prepare(
    `INSERT INTO sites (id, ${COLUMNS.join(', ')}, created_at, updated_at)
     VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`
  ).bind(id, ...values, now, now).run();
  return json({ site: await getSite(db, id) }, 201);
}

async function updateSite(db, request, id) {
  const fields = cleanSite(await readBody(request));
  const keys = Object.keys(fields);
  if (!keys.length) throw new InvalidField(null, 'Nothing to change.');
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE sites SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`
  ).bind(...keys.map((k) => fields[k]), now, id).run();
  if (!res.meta.changes) return json({ error: 'No site with that id.' }, 404);
  return json({ site: await getSite(db, id) });
}

async function deleteSite(db, id) {
  const res = await db.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
  if (!res.meta.changes) return json({ error: 'No site with that id.' }, 404);
  return json({ deleted: id });
}

async function handleApi(request, env, url) {
  if (!(await authorised(request, env))) {
    return env.DASH_KEY
      ? json({ error: 'Wrong or missing desk key.', code: 'bad-key' }, 401)
      : json({ error: 'DASH_KEY is not set on this Worker.', code: 'no-key-configured' }, 401);
  }
  await ensureSchema(env.DB);

  const parts = url.pathname.replace(/\/+$/, '').split('/'); // ['', 'api', 'sites', id?]
  if (parts[2] !== 'sites' || parts.length > 4) return json({ error: 'Not found.' }, 404);
  const id = parts[3];
  const m = request.method;

  try {
    if (!id && m === 'GET') return await listSites(env.DB);
    if (!id && m === 'POST') return await createSite(env.DB, request);
    if (id && m === 'PATCH') return await updateSite(env.DB, request, id);
    if (id && m === 'DELETE') return await deleteSite(env.DB, id);
    return json({ error: 'Method not allowed.' }, 405);
  } catch (e) {
    if (e instanceof InvalidField) return json({ error: e.message, field: e.field }, 400);
    throw e;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
