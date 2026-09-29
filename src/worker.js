// The desk's only server code. Every request comes through here first
// (run_worker_first in wrangler.jsonc) so that plain HTTP can be turned away;
// the page itself is then served from public/ by the assets binding, and the
// Worker answers /api/* itself.
//
// The list, and everything else the desk knows, lives in Postgres on Neon
// (db.js, schema.js, store.js). It used to live in a Durable Object; the
// object is kept only so its rows can be copied across once, the first time
// this Worker reaches the database (ready(), below).
//
// An edit can name the updated_at it started from, and is refused if the row
// has moved on since, so a stale edit cannot overwrite a teammate's newer one.

import { DurableObject } from 'cloudflare:workers';
import { cleanSite, InvalidField } from './sites.js';
import { cleanItem, KINDS, ITEMS, CHOICES, SERVICE_KINDS, JOB_TASKS } from './details.js';
import { cleanClientForm, OPTIONS, LIMITS } from './client-form.js';
import { cleanPassword, encryptPassword, decryptPassword, SecretsNotSetUp } from './secrets.js';
import { formEmails, sendEmails, DEFAULT_FROM, DEFAULT_REP } from './notify.js';
import { sessionToken, cookieValues, sessionCookie, clearCookie } from './session.js';
import { json } from './answers.js';
import { pgSession } from './db.js';
import { migrate } from './schema.js';
import { Store } from './store.js';
import { handleGoLive, handleGoLiveSignin } from './golive-routes.js';

// The old home of the list. It no longer takes writes: all it does is hand
// over its tables, once, for the copy into Postgres. Its data stays where it
// was, untouched, until the object is deleted in a later release.
export class Desk extends DurableObject {
  export() {
    const sql = this.ctx.storage.sql;
    const have = new Set(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((t) => t.name));
    const dump = {};
    for (const table of ['sites', 'golive', 'golive_log', 'golive_checks']) {
      dump[table] = have.has(table) ? sql.exec(`SELECT * FROM ${table}`).toArray() : [];
    }
    return dump;
  }
}

// The one instance, placed in eastern North America, near the team.
const oldDesk = (env) => env.DESK.get(env.DESK.idFromName('desk'), { locationHint: 'enam' });

// Once per Worker instance: bring the database's shape up to date, then copy
// the Durable Object's rows across if that has not been done. Until both
// have worked, every request that needs the database fails, rather than
// showing an empty list someone might start filling in again. Only the fact
// that it is done is kept between requests: a request may not wait on
// another request's connection, so two that start together both check, and
// the lock in migrate() and importRows() makes the second find nothing to do.
let isReady = false;
async function ready(env, connect) {
  if (isReady) return;
  await migrate(connect);
  const s = new Store(connect);
  if (!(await s.hasImported())) {
    const counts = await s.importRows(env.DESK ? await oldDesk(env).export() : {});
    if (counts) console.log(JSON.stringify({ message: 'Copied the Durable Object into Postgres.', counts }));
  }
  isReady = true;
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

async function handleApi(request, env, url, ctx) {
  const secure = url.protocol === 'https:';
  const parts = url.pathname.replace(/\/+$/, '').split('/'); // ['', 'api', 'sites', id?]
  if (parts[2] === 'session' && parts.length === 3) return handleSession(request, env, secure);
  // Where Cloudflare Access sends a person back after its login. It arrives
  // from Access's own site, so the SameSite=Strict login cookie is not sent
  // with it and the key cannot be checked here. It changes nothing and shows
  // nothing: it checks the Access login and redirects to the page, which
  // then asks with the cookie like any other request.
  if (parts[2] === 'golive' && parts[3] === 'signin' && parts.length === 4) {
    return handleGoLiveSignin(request, env, { url });
  }

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

  // Nothing below runs until the database is ready, and only for a request
  // that holds the key. The request's one connection closes once the answer
  // and anything handed to waitUntil have finished.
  if (!env.DATABASE_URL) return unavailable('DATABASE_URL is not set on this Worker.');
  const session = pgSession(env.DATABASE_URL);
  const pending = [];
  const waitUntil = (p) => { pending.push(p); ctx.waitUntil(p); };
  try {
    try {
      await ready(env, session.connect);
    } catch (e) {
      return unavailable(e);
    }

    // Going live needs the key and, on top of it, the person's own Access
    // login, which golive-routes.js checks. A switch or rollback is handed to
    // waitUntil, so it runs to its end even if the page goes away.
    const store = new Store(session.connect);
    const res = parts[2] === 'golive'
      ? await handleGoLive(request, env, { parts, url, store, waitUntil })
      : parts[2] === 'client-form'
        ? await handleClientForm(request, store, parts, env, url)
        : await handleSites(request, store, parts, env);
    // Each visit restarts the cookie's 400 days, so an active browser never expires.
    if (cred === 'cookie') res.headers.append('set-cookie', sessionCookie(await sessionToken(env.DASH_KEY), secure));
    return res;
  } finally {
    ctx.waitUntil(Promise.allSettled(pending).then(() => session.close()));
  }
}

function unavailable(e) {
  console.error(JSON.stringify({ message: 'The database is not ready.', error: String(e?.message || e) }));
  return json({ error: 'The desk could not reach its database. Try again in a moment.', code: 'database-unavailable' }, 503);
}

// Ids as store.js makes them: 0001, 0002 … 10000. Anything else is not one of ours.
const ID = /^[0-9]{4,12}$/;

// The updated_at an editor started from, when it sends one.
function expectedFrom(body) {
  const expected = body.expected_updated_at;
  if (expected != null && (typeof expected !== 'string' || expected.length > 40)) {
    throw new InvalidField('expected_updated_at', 'expected_updated_at must be the updated_at string you last saw.');
  }
  return expected || null;
}

// /api/sites and /api/sites/:id, then a site's details:
//   GET    /api/sites/:id/details        services, contacts, domains and history
//   POST   /api/sites/:id/:kind          add a service, contact, domain or social link
//   PATCH  /api/sites/:id/:kind/:itemId  change one
//   DELETE /api/sites/:id/:kind/:itemId  remove one
async function handleSites(request, db, parts, env) {
  if (parts[2] !== 'sites' || parts.length > 7) return json({ error: 'Not found.' }, 404);
  const [id, kind, itemId, extra] = parts.slice(3);
  if (extra && !(kind === 'services' && extra === 'password')) return json({ error: 'Not found.' }, 404);
  if (id && !ID.test(id)) return notFound();
  const m = request.method;

  try {
    if (kind === 'details' && !itemId) {
      if (m !== 'GET') return json({ error: 'Method not allowed.' }, 405);
      const details = await db.details(id);
      return details ? json({ ...details, choices: CHOICES }) : notFound();
    }
    if (extra) return await handlePassword(request, db, m, id, itemId, env);
    if (kind) return await handleItem(request, db, m, id, kind, itemId, env);

    if (!id && m === 'GET') return json({ sites: await db.list() });
    if (!id && m === 'POST') {
      const fields = cleanSite(await readBody(request), { creating: true });
      return json({ site: await db.create(fields) }, 201);
    }
    if (id && m === 'PATCH') {
      const body = await readBody(request);
      const fields = cleanSite(body);
      if (!Object.keys(fields).length) throw new InvalidField(null, 'Nothing to change.');
      const res = await db.update(id, fields, expectedFrom(body));
      if (res.missing) return notFound();
      if (res.conflict) {
        return json({ error: 'Someone else changed this site while you were editing it.', code: 'conflict', site: res.site }, 409);
      }
      return json({ site: res.site });
    }
    if (id && m === 'DELETE') {
      const removed = await db.remove(id);
      if (removed?.blocked) {
        return json({
          error: 'This site has a go-live that is not finished. Roll it back, or wait for it to finish, before deleting it.',
          code: 'golive-active',
        }, 409);
      }
      return removed ? json({ deleted: id }) : notFound();
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (e) {
    if (e instanceof InvalidField) return json({ error: e.message, field: e.field }, 400);
    if (e instanceof SecretsNotSetUp) return json({ error: e.message, code: e.code }, 503);
    throw e;
  }
}

const DUPLICATE = {
  hostname: 'That domain is already listed for this site.',
  url: 'That link is already listed for this site.',
};

// The client form (src/client-form.js):
//   GET  /api/client-form        what the form offers: service kinds, job ticks, options
//   POST /api/client-form        the whole form: a new site and everything under it
const FORM_CHOICES = { service_kinds: SERVICE_KINDS, job_tasks: JOB_TASKS, options: OPTIONS, limits: LIMITS };

// Saving the form: every password is encrypted first, so a form with a
// password and no CREDENTIALS_KEY is refused whole, before anything is
// written. The emails go after the save, and the answer says how each went.
async function handleClientForm(request, db, parts, env, url) {
  const m = request.method;
  if (parts.length === 3 && m === 'GET') return json({ choices: FORM_CHOICES });
  if (parts.length === 3 && m === 'POST') {
    try {
      const form = cleanClientForm(await readBody(request));
      const stored = { ...form, services: [] };
      for (const s of form.services) {
        stored.services.push({ ...s, password: s.password ? await encryptPassword(env.CREDENTIALS_KEY, s.password) : null });
      }
      const { site } = await db.createClient(stored);
      const emails = await sendEmails(formEmails(form, site, {
        deskUrl: url.origin, from: env.FORM_EMAIL_FROM || DEFAULT_FROM, rep: env.FORM_EMAIL_REP || DEFAULT_REP,
      }), env.RESEND_API_KEY);
      for (const e of emails.filter((x) => !x.sent)) {
        console.error(JSON.stringify({ message: 'A client form email was not sent.', who: e.who, site: site.id, error: e.error }));
      }
      return json({ site, emails: emails.map(({ who, sent, error }) => ({ who, sent, ...(error ? { error } : {}) })) }, 201);
    } catch (e) {
      if (e instanceof InvalidField) return json({ error: e.message, field: e.field }, 400);
      if (e instanceof SecretsNotSetUp) return json({ error: e.message, code: e.code }, 503);
      throw e;
    }
  }
  if (parts.length > 3) return json({ error: 'Not found.' }, 404);
  return json({ error: 'Method not allowed.' }, 405);
}

// A service's `password` in the body: text sets it (encrypted here), null
// or empty removes it, absent leaves it. Other kinds have no password.
async function passwordFrom(kind, body, env) {
  if (kind !== 'services' || !('password' in body)) return undefined;
  let clean;
  try { clean = cleanPassword(body.password); } catch (e) {
    throw new InvalidField('password', 'Password ' + e.message + '.');
  }
  return clean === null ? null : encryptPassword(env.CREDENTIALS_KEY, clean);
}

async function handleItem(request, db, m, siteId, kind, itemId, env) {
  if (!KINDS.includes(kind) || (itemId && !ID.test(itemId))) return json({ error: 'Not found.' }, 404);
  const gone = () => json({ error: 'No such ' + ITEMS[kind].noun + ' on this site.' }, 404);

  if (!itemId && m === 'POST') {
    const body = await readBody(request);
    const fields = cleanItem(kind, body, { creating: true });
    const res = await db.createItem(kind, siteId, fields, { password: await passwordFrom(kind, body, env) });
    if (res.missing) return notFound();
    if (res.duplicate) throw new InvalidField(res.duplicate, DUPLICATE[res.duplicate]);
    return json({ item: res.item }, 201);
  }
  if (itemId && m === 'PATCH') {
    const body = await readBody(request);
    const fields = cleanItem(kind, body);
    const password = await passwordFrom(kind, body, env);
    if (!Object.keys(fields).length && password === undefined) throw new InvalidField(null, 'Nothing to change.');
    const res = await db.updateItem(kind, siteId, itemId, fields, expectedFrom(body), { password });
    if (res.missing) return gone();
    if (res.duplicate) throw new InvalidField(res.duplicate, DUPLICATE[res.duplicate]);
    if (res.conflict) {
      return json({ error: 'Someone else changed this while you were editing it.', code: 'conflict', item: res.item }, 409);
    }
    return json({ item: res.item });
  }
  if (itemId && m === 'DELETE') {
    return (await db.removeItem(kind, siteId, itemId)) ? json({ deleted: itemId }) : gone();
  }
  return json({ error: 'Method not allowed.' }, 405);
}

// POST /api/sites/:id/services/:itemId/password: the password itself, for
// Show and Copy on the desk. A POST, so it needs the x-desk header like any
// change, and no other page can ask for it with the login cookie.
async function handlePassword(request, db, m, siteId, itemId, env) {
  if (!itemId || !ID.test(itemId)) return json({ error: 'Not found.' }, 404);
  if (m !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const res = await db.readPassword(siteId, itemId);
  if (res.missing) return json({ error: 'No such service on this site.' }, 404);
  if (res.none) return json({ error: 'This service has no password saved.', code: 'no-password' }, 404);
  return json({ password: await decryptPassword(env.CREDENTIALS_KEY, res.ciphertext) });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (insecure(url, env)) {
      // The API is refused rather than redirected: a client that sent the key
      // over plain HTTP should fail loudly, not be quietly retried.
      if (isApi) return json({ error: 'The desk only answers over HTTPS.', code: 'https-only' }, 403);
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (isApi) return handleApi(request, env, url, ctx);
    return env.ASSETS.fetch(request);
  },
};
