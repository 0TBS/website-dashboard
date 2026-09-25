import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteStorage } from './sqlite-adapter.js';
import * as store from '../src/golive-store.js';
import { handleGoLive, handleGoLiveSignin, goliveConfigMissing } from '../src/golive-routes.js';
import { _resetKeyCache } from '../src/access.js';
import { cloudflare } from '../src/cloudflare.js';
import { LIMIT } from '../src/budget.js';
import { DESK_WORKER, buildPlan, checksDigest } from '../src/golive.js';
import { createFakeCloudflare, createFakeSites, createFakeDoh, combineFetches } from './fake-cloudflare.js';

// Every call must go through the fetch a test passes in, so the budget
// counts it. There is no global fetch to fall back on.
globalThis.fetch = async () => { throw new Error('golive-routes.js used the global fetch'); };

const SEC = 1000;
const MINUTE = 60 * SEC;
const DAY = 24 * 60 * MINUTE;
const THURSDAY = Date.parse('2026-09-24T16:00:00Z');
const FRIDAY = Date.parse('2026-09-25T16:00:00Z');

// One clock for the whole file: the routes' `now`, and Date.now, which the
// Cloudflare client and the switch read for their deadlines. Tests move it.
const clock = { t: THURSDAY };
mock.method(Date, 'now', () => clock.t);
const iso = () => new Date(clock.t).toISOString();

const ACCOUNT = 'acc00000000000000000000000000001';
const ZONE = 'e0000000000000000000000000000001';      // acme.com, the client
const DESK_ZONE = 'e0000000000000000000000000000002'; // 10xid.com, the desk's own
const SITE_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER_ID = '7c9d0e1f-2a3b-4c5d-8e6f-0a1b2c3d4e5f';
const REF = 'desk-' + SITE_ID;
const STAGING = 'staging-acme.10xid.com';
const W = 'staging-acme';
const DESK = 'website.10xid.com';
const NS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
const TEAM = 'tbox.cloudflareaccess.com';
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';
const ANA = 'ana@example.com';
const CREATED = '2026-09-01T12:00:00.000Z';

const ENV = {
  DASH_KEY: 'k', GOLIVE_API_TOKEN: 'tok-test-secret', GOLIVE_ACCOUNT_ID: ACCOUNT,
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, GOLIVE_EMAILS: 'ana@example.com, ben@example.org',
};

// What every answer carries, as worker.js answers.
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};

const SITE = {
  id: SITE_ID, name: 'Acme Plumbing', live_domain: 'acme.com', staging_domain: STAGING,
  github_repo: 'tbox/acme-site', live_platform: 'wordpress',
};

// The usual WordPress starting point: the apex on the old host, www an alias
// of it, mail elsewhere.
const RECORDS = [
  { type: 'A', name: 'acme.com', content: '192.0.2.10', proxied: true },
  { type: 'CNAME', name: 'www.acme.com', content: 'acme.com', proxied: true },
  { type: 'MX', name: 'acme.com', content: 'mx.mailhost.net', priority: 10 },
  { type: 'TXT', name: 'acme.com', content: 'v=spf1 include:_spf.mailhost.net ~all' },
];

// A copy of the sites table in src/worker.js, which cannot be imported under
// plain Node (it imports cloudflare:workers). Keep the two in step.
const SITES = `CREATE TABLE IF NOT EXISTS sites (
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

// --- A real Access login: an RS256 key pair and a certs endpoint ---

const enc = new TextEncoder();
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const rsa = () => crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const [ACCESS_KEY, STRANGER_KEY] = await Promise.all([rsa(), rsa()]);
const { kty, e, n } = await crypto.subtle.exportKey('jwk', ACCESS_KEY.publicKey);
const JWK = { kid: 'kid-1', kty, alg: 'RS256', use: 'sig', e, n };

// A person's application token as Access issues it, dated by the clock.
async function jwt({ email = ANA, key = ACCESS_KEY, ...claims } = {}) {
  const sec = Math.floor(clock.t / 1000);
  const input = b64({ alg: 'RS256', kid: JWK.kid, typ: 'JWT' }) + '.' + b64({
    aud: [AUD], email, exp: sec + 3600, iat: sec - 10, nbf: sec - 10, iss: 'https://' + TEAM,
    type: 'app', sub: 'user-1', ...claims,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(input));
  return input + '.' + Buffer.from(sig).toString('base64url');
}

// --- The world: Cloudflare, the sites, public DNS, Access and the desk ---

function stagingHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acme Plumbing</title>
<link rel="canonical" href="https://acme.com/">
<link rel="stylesheet" href="/_astro/index.B1x2y3.css">
<script type="module" src="/_astro/page.C4d5e6.js"></script>
</head><body><nav><a href="/">Home</a> <a href="/services/">Services</a></nav></body></html>`;
}

// The client's hosts as the world sees them: the old WordPress site until a
// host is on the staging Worker, then the staging build, and a 301 once a
// redirect rule for the host is in.
function liveSite(fake, url) {
  const rule = fake.redirectRules(ZONE).find((r) => r.enabled && r.expression === `(http.host eq "${url.hostname}")`);
  if (rule) {
    const target = rule.action_parameters.from_value.target_url.expression.match(/concat\("([^"]+)"/)[1];
    return { status: 301, headers: { location: target + url.pathname + url.search } };
  }
  if (!fake.state.domains.some((d) => d.hostname === url.hostname && d.service === W)) {
    return { body: '<!doctype html><title>Acme – Just another WordPress site</title>' };
  }
  if (url.pathname === '/') return { body: stagingHtml() };
  if (url.pathname === '/services/') return { body: '<title>Services</title>' };
  return { status: 404, body: 'Not found' };
}

// The Desk's go-live methods as worker.js defines them, over node:sqlite:
// every write in one transaction, and everything copied on the way in and
// out, as an RPC call copies it. The object's clock is the file's clock.
function deskOf({ sql, transactionSync }) {
  const rpc = (fn, write = false) => async (...args) => {
    const copy = structuredClone(args);
    return structuredClone(write ? transactionSync(() => fn(sql, ...copy)) : fn(sql, ...copy));
  };
  return {
    read: rpc((db, id) => store.siteWithGolive(db, id, clock.t)),
    goliveDetail: rpc(store.goliveDetail),
    goliveLastCheck: rpc(store.goliveLastCheck),
    goliveHostsInUse: rpc(store.goliveHostsInUse),
    goliveSaveCheck: rpc(store.goliveSaveCheck, true),
    goliveBegin: rpc(store.goliveBegin, true),
    goliveStep: rpc(store.goliveStep, true),
    goliveFinish: rpc(store.goliveFinish, true),
    goliveSaveVerify: rpc(store.goliveSaveVerify, true),
  };
}

function addSite(sql, s) {
  sql.exec(
    `INSERT INTO sites (id, name, live_domain, staging_domain, github_repo, live_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id, s.name, s.live_domain ?? null, s.staging_domain ?? null, s.github_repo ?? null, s.live_platform ?? null, CREATED, CREATED
  );
}

// Cloudflare, the sites, both public resolvers and the Access certs behind
// one fetch, and the desk's database. `wrap` puts something in front of
// Cloudflare alone.
function world({ records = RECORDS, sites = [SITE], wrap = null } = {}) {
  const fake = createFakeCloudflare({
    accountId: ACCOUNT,
    zones: [{ id: ZONE, name: 'acme.com' }, { id: DESK_ZONE, name: '10xid.com' }],
    records,
    domains: [{ hostname: DESK, service: DESK_WORKER }, { hostname: STAGING, service: W }],
    workers: [W],
  });
  const live = (url) => liveSite(fake, url);
  const web = createFakeSites({
    [`https://${STAGING}/`]: { body: stagingHtml() },
    [`https://${STAGING}/robots.txt`]: { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
    'https://acme.com/*': live,
    'https://www.acme.com/*': live,
  });
  const table = () => ({ 'acme.com': { NS, MX: '10 mx.mailhost.net' } });
  const resolvers = createFakeDoh({ 'dns.google': table(), 'cloudflare-dns.com': table() });
  const certs = async () => Response.json({ keys: [JWK], public_cert: {}, public_certs: [] });
  const net = combineFetches(wrap ? [fake.claims, wrap(fake.fetch)] : fake, web, resolvers, [TEAM, certs]);

  const storage = sqliteStorage();
  storage.sql.exec(SITES);
  store.ensureGoliveSchema(storage.sql);
  for (const s of sites) addSite(storage.sql, s);
  // Changes a person makes in the dashboard behind the desk's back.
  const admin = cloudflare({ token: 'tok-admin', accountId: ACCOUNT, fetchImpl: fake.fetch });
  return { fake, web, resolvers, net, storage, desk: deskOf(storage), admin };
}

// One request to /api/golive/*, as worker.js hands it over once the desk key
// is checked. Every answer must carry the desk's headers, and no request may
// make more outbound calls than the budget allows.
async function call(w, method, path, { body, token, env = ENV, sleep = async () => {} } = {}) {
  const url = new URL('https://' + DESK + path);
  const headers = {};
  if (token !== null) headers['cf-access-jwt-assertion'] = token ?? await jwt();
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const waits = [];
  const before = w.net.calls.length;
  const res = await handleGoLive(new Request(url, init), env, {
    parts: url.pathname.replace(/\/+$/, '').split('/'), url, store: w.desk,
    waitUntil: (p) => waits.push(p), fetchImpl: w.net, now: () => clock.t, sleep,
  });
  const calls = w.net.calls.length - before;
  assert.ok(calls <= LIMIT, `${method} ${path} made ${calls} outbound calls; a request may make ${LIMIT}`);
  for (const [k, v] of Object.entries(HEADERS)) assert.equal(res.headers.get(k), v, `${method} ${path}: ${k}`);
  return { status: res.status, body: await res.json(), calls, waits, res };
}

const path = (action = '', id = SITE_ID) => `/api/golive/${id}${action ? '/' + action : ''}`;
const checkSite = (w, includePair = true) => call(w, 'POST', path('check'), { body: { include_pair: includePair } });
const startBody = (c, extra = {}) => ({
  include_pair: true, confirm: 'acme.com', plan_hash: c.body.plan_hash, acks: c.body.acks.map((a) => a.id), ...extra,
});
const start = (w, c, extra = {}, opts = {}) => call(w, 'POST', path('start'), { body: startBody(c, extra), ...opts });
const rollBack = (w, body = { confirm: 'acme.com', acks: [] }) => call(w, 'POST', path('rollback'), { body });

async function goLive(w) {
  const c = await checkSite(w);
  assert.equal(c.body.ready, true, JSON.stringify(c.body.checks.filter((x) => x.status === 'fail')));
  const s = await start(w, c);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { c, s };
}

// The zone as a person compares it: what each record says, not its id.
const zoneState = (w) => w.fake.state.records.filter((r) => r.zone_id === ZONE)
  .map((r) => `${r.type} ${r.name} ${r.content} ${r.proxied ? 'proxied' : 'dns-only'} ttl=${r.ttl}${r.meta?.read_only ? ' read-only' : ''}`)
  .sort();
const domainState = (w) => w.fake.state.domains.filter((d) => d.zone_id === ZONE).map((d) => `${d.hostname} on ${d.service}`).sort();
const ourRules = (w) => w.fake.redirectRules(ZONE).filter((r) => r.ref === REF);
const cfCalls = (w, from, test) => w.fake.calls.slice(from).filter(test);
const isAttach = (c) => c.method === 'PUT' && c.path.endsWith('/workers/domains');
const isDetach = (c) => c.method === 'DELETE' && c.path.includes('/workers/domains/');
const isCreate = (c) => c.method === 'POST' && c.path.endsWith('/dns_records');
const actions = (log) => log.map((x) => x.action);
const rowOf = (w, id = SITE_ID) => store.goliveDetail(w.storage.sql, id, clock.t).golive;

// Answers `hostname`'s attach with an error, and leaves every other call alone.
const failAttach = (hostname, status, code, message) => (fetchImpl) => async (input, init = {}) => {
  if (init.method === 'PUT' && JSON.parse(init.body).hostname === hostname) {
    return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  }
  return fetchImpl(input, init);
};

beforeEach(() => {
  clock.t = THURSDAY;
  _resetKeyCache();
});

// --- Set up, and who is asking ---

test('with a setting missing, every endpoint answers 503 with the names, before anything is fetched', async () => {
  const w = world();
  const cases = [
    [{}, ['GOLIVE_API_TOKEN', 'GOLIVE_ACCOUNT_ID', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'GOLIVE_EMAILS']],
    [{ ...ENV, GOLIVE_API_TOKEN: '  ' }, ['GOLIVE_API_TOKEN']],
    [{ ...ENV, GOLIVE_ACCOUNT_ID: undefined, GOLIVE_EMAILS: ' , ' }, ['GOLIVE_ACCOUNT_ID', 'GOLIVE_EMAILS']],
    [{ ...ENV, ACCESS_TEAM_DOMAIN: 'example.com' }, ['ACCESS_TEAM_DOMAIN']],
    // wrangler reads CF_API_TOKEN and CF_ACCOUNT_ID from a developer's shell
    // as its own deploy credentials. The desk never takes them for its own.
    [{ ...ENV, GOLIVE_API_TOKEN: undefined, GOLIVE_ACCOUNT_ID: undefined, CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: ACCOUNT },
      ['GOLIVE_API_TOKEN', 'GOLIVE_ACCOUNT_ID']],
  ];
  for (const [env, missing] of cases) {
    assert.deepEqual(goliveConfigMissing(env), missing);
    for (const [method, p] of [['GET', '/api/golive/me'], ['POST', path('check')], ['GET', '/api/golive/nowhere']]) {
      const r = await call(w, method, p, { env, body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 503, p);
      assert.deepEqual(r.body, { code: 'golive-not-set-up', error: 'Going live is not set up on this Worker.', missing });
    }
  }
  assert.deepEqual(goliveConfigMissing(ENV), []);
  assert.equal(w.net.calls.length, 0, 'not even the Access keys');
});

test('Access: no token is 401, a forged or expired one 403, and someone not on the list is named', async () => {
  const w = world();
  const none = await call(w, 'GET', '/api/golive/me', { token: null });
  assert.equal(none.status, 401);
  assert.equal(none.body.code, 'access-not-protecting');

  for (const token of ['garbage', await jwt({ key: STRANGER_KEY }), await jwt({ exp: Math.floor(clock.t / 1000) - 3600 })]) {
    const r = await call(w, 'POST', path('check'), { token, body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'access-invalid');
  }

  const eve = await call(w, 'POST', path('check'), { token: await jwt({ email: 'Eve@Example.com' }), body: {} });
  assert.equal(eve.status, 403);
  assert.deepEqual(eve.body, {
    code: 'not-allowed', error: 'eve@example.com is not on the list of people who can go live.', email: 'eve@example.com',
  });
  assert.equal(store.goliveLastCheck(w.storage.sql, SITE_ID), null, 'a refused person checks nothing');
  assert.equal(w.fake.calls.length, 0, 'and Cloudflare was never asked');
});

test('GET /api/golive/me names the person; the Access keys come out of the same budget', async () => {
  const w = world();
  const first = await call(w, 'GET', '/api/golive/me');
  assert.deepEqual([first.status, first.body], [200, { email: ANA }]);
  assert.equal(first.calls, 1, 'the certs fetch is counted');
  assert.equal((await call(w, 'GET', '/api/golive/me')).calls, 0, 'then the keys are cached');
});

test('unknown sites, paths and methods are refused before anything happens', async () => {
  const w = world();
  const cases = [
    ['GET', '/api/golive', 404, 'Not found.'],
    ['GET', '/api/golive/', 404, 'Not found.'],
    ['GET', path('', OTHER_ID), 404, 'No site with that id.'],
    ['POST', path('check', SITE_ID.toUpperCase()), 404, 'No site with that id.'],
    ['POST', path('check', '..%2F..%2Fsites'), 404, 'No site with that id.'],
    ['POST', path('delete'), 404, 'Not found.'],
    ['POST', path('check') + '/again', 404, 'Not found.'],
    ['GET', path('check'), 405, 'Method not allowed.'],
    ['DELETE', path(), 405, 'Method not allowed.'],
    ['POST', '/api/golive/me', 405, 'Method not allowed.'],
  ];
  for (const [method, p, status, error] of cases) {
    const r = await call(w, method, p, { body: method === 'POST' ? {} : undefined });
    assert.deepEqual([r.status, r.body.error], [status, error], `${method} ${p}`);
  }
  assert.equal(w.fake.calls.length, 0);
});

test('a body that is not a JSON object, or a bad include_pair, is a 400', async () => {
  const w = world();
  for (const body of ['{"include_pair":', '[true]', '"yes"', 'null']) {
    const r = await call(w, 'POST', path('check'), { body });
    assert.deepEqual([r.status, r.body], [400, { error: 'Body is not a JSON object.', field: null }], body);
  }
  const r = await call(w, 'POST', path('check'), { body: { include_pair: 'yes' } });
  assert.deepEqual([r.status, r.body], [400, { error: 'include_pair must be true or false.', field: 'include_pair' }]);
  assert.equal(w.fake.calls.length, 0);
});

// --- The whole cycle ---

test('check, start, Check now and Roll back: the switch happens, and the zone ends exactly as it began', async () => {
  const w = world();
  const before = zoneState(w);
  const mailIds = w.fake.state.records.filter((r) => r.type === 'MX' || r.type === 'TXT').map((r) => r.id).sort();

  // Check: saved, because a start relies on it.
  const c = await checkSite(w);
  assert.equal(c.status, 200);
  assert.equal(c.body.ready, true);
  assert.equal(c.calls, 13, 'the Access keys, eight Cloudflare reads, the page, robots.txt and two resolvers');
  assert.deepEqual(c.waits, []);
  assert.match(c.body.plan_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(c.body.acks.map((a) => a.id), ['gate12', 'wrangler']);
  assert.deepEqual(c.body.plan.hosts.map((h) => h.hostname), ['acme.com', 'www.acme.com']);
  const saved = store.goliveLastCheck(w.storage.sql, SITE_ID);
  assert.deepEqual(saved, {
    site_id: SITE_ID, plan_hash: c.body.plan_hash, checks_hash: saved.checks_hash, include_pair: true, ready: true, acks: c.body.acks,
    checked_by: ANA, checked_at: iso(),
  });
  // What a start compares: the Cloudflare checks alone, since it fetches no page.
  assert.equal(saved.checks_hash, await checksDigest((await buildPlan({ site: SITE, includePair: true, cf: w.admin })).checks));
  assert.deepEqual(zoneState(w), before, 'a check changes nothing');

  // Start: the plan again from Cloudflare, no page, then the switch.
  clock.t += 3 * MINUTE;
  const pages = w.web.calls.length;
  const lookups = w.resolvers.calls.length;
  const s = await start(w, c, { confirm: ' ACME.com ' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.waits.length, 1, 'the run was handed to waitUntil');
  assert.equal(await s.waits[0], s.res, 'and the answer is what the run ended with');
  assert.equal(w.web.calls.length, pages, 'a start fetches no page');
  assert.equal(w.resolvers.calls.length, lookups, 'and asks no resolver');
  const g = s.body.golive;
  assert.equal(g.state, 'checking');
  assert.equal(g.started_by, ANA);
  assert.equal(g.switched_at, iso());
  assert.equal(g.error, null);
  assert.deepEqual(g.acks.map((a) => a.id), ['gate12', 'wrangler']);
  assert.deepEqual(g.attached.map((a) => a.hostname), ['acme.com', 'www.acme.com']);
  assert.ok(g.attached.every((a) => a.id && a.dns_id), 'each host with the record Cloudflare made for it');
  assert.equal(g.saved_records.length, 2, 'the rollback, saved before anything was deleted');
  assert.equal(g.ssl_mode, 'full', 'for the gate 13 record');
  assert.equal(s.body.site.live_platform, 'astro');
  assert.equal(s.body.site.golive.state, 'checking');
  assert.deepEqual([s.body.site.golive.has_error, s.body.site.golive.error_kind], [false, null]);
  assert.ok(!('error' in s.body.site.golive) && !('ssl_mode' in s.body.site.golive), 'the list carries neither');
  assert.deepEqual(actions(s.body.log), [
    'switch-started', 'record-deleted', 'record-deleted', 'domain-attached', 'domain-attached', 'worker-records',
    'redirect-added', 'switched',
  ]);
  assert.ok(s.body.log.every((x) => x.who === ANA));
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);
  assert.deepEqual(zoneState(w).filter((r) => !/^(MX|TXT) /.test(r)), [
    'AAAA acme.com 100:: proxied ttl=1 read-only', 'AAAA www.acme.com 100:: proxied ttl=1 read-only',
  ]);
  assert.equal(ourRules(w).length, 1);

  // Check now: the live address serves the staging build, so it is live.
  clock.t += 5 * MINUTE;
  const v = await call(w, 'POST', path('verify'));
  assert.equal(v.status, 200);
  assert.deepEqual(v.waits, []);
  assert.deepEqual(v.body.checks.map((x) => [x.id, x.status]), [
    ['https', 'pass'], ['noindex', 'pass'], ['same-site', 'pass'], ['deep-page', 'pass'], ['redirect', 'pass'],
    ['still-attached', 'pass'], ['public-dns', 'pass'], ['mx-txt', 'pass'],
  ]);
  assert.equal(v.body.done, true);
  assert.equal(v.body.golive.state, 'live');
  assert.equal(v.body.golive.verified_at, iso());
  assert.equal(v.body.site.golive.state, 'live');

  const d = await call(w, 'GET', path());
  assert.equal(d.status, 200);
  assert.deepEqual(Object.keys(d.body).sort(), ['golive', 'last_check', 'log', 'site']);
  assert.equal(d.body.site.id, SITE_ID);
  assert.equal(d.body.golive.state, 'live');
  assert.equal(d.body.log.at(-1).action, 'verified');
  assert.equal(d.body.last_check.plan_hash, c.body.plan_hash);

  // Roll back: everything as it was, and "Live site runs on" back to WordPress.
  clock.t += DAY;
  const r = await rollBack(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.waits.length, 1, 'the rollback was handed to waitUntil');
  assert.equal(await r.waits[0], r.res);
  assert.equal(r.body.golive.state, 'rolled-back');
  assert.equal(r.body.golive.rolled_back_by, ANA);
  assert.equal(r.body.golive.rolled_back_at, iso());
  assert.equal(r.body.site.live_platform, 'wordpress');
  assert.equal(r.body.site.golive.state, 'rolled-back');
  const log = actions(r.body.log);
  assert.equal(log[0], 'switch-started', 'the log keeps the whole story');
  assert.deepEqual(log.slice(log.indexOf('rollback-started')), [
    'rollback-started', 'redirect-removed', 'domain-detached', 'record-restored', 'domain-detached', 'record-restored',
    'rolled-back',
  ]);
  assert.deepEqual(zoneState(w), before, 'the zone is exactly as it began');
  assert.deepEqual(domainState(w), []);
  assert.deepEqual(ourRules(w), []);
  assert.deepEqual(w.fake.state.records.filter((x) => x.type === 'MX' || x.type === 'TXT').map((x) => x.id).sort(), mailIds,
    'MX and TXT were never touched');

  // Undone, so the site can go live again, and there is nothing left to undo.
  assert.equal((await rollBack(w)).body.code, 'nothing-to-undo');
  assert.equal((await checkSite(w)).body.ready, true);
});

test('with the pair unticked only the live host moves, and www keeps its own record', async () => {
  const records = [
    { type: 'A', name: 'acme.com', content: '192.0.2.10', proxied: true },
    { type: 'A', name: 'www.acme.com', content: '192.0.2.20', proxied: true },
  ];
  const w = world({ records });
  const c = await checkSite(w, false);
  assert.equal(c.body.ready, true);
  assert.equal(c.body.checks.find((x) => x.id === 'hosts').status, 'warn');
  assert.equal(store.goliveLastCheck(w.storage.sql, SITE_ID).include_pair, false);
  const s = await start(w, c, { include_pair: false });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(domainState(w), ['acme.com on staging-acme']);
  assert.ok(zoneState(w).includes('A www.acme.com 192.0.2.20 proxied ttl=1'));
  assert.equal(s.body.golive.redirect, null);
  assert.equal(w.fake.redirectRules(ZONE).length, 0);
});

// --- What a start refuses ---

test('a start needs a check: saved, ready, under ten minutes old and for the same hostnames', async () => {
  const w = world();
  const before = zoneState(w);
  const body = { include_pair: true, confirm: 'acme.com', plan_hash: 'x', acks: ['gate12', 'wrangler'] };

  const none = await call(w, 'POST', path('start'), { body });
  assert.deepEqual([none.status, none.body.code], [409, 'check-first']);
  assert.match(none.body.error, /Check the site before going live/);

  const c = await checkSite(w);
  clock.t += 10 * MINUTE + SEC;
  const old = await start(w, c);
  assert.deepEqual([old.status, old.body.code], [409, 'check-first']);
  assert.match(old.body.error, /more than ten minutes old/);

  const c2 = await checkSite(w);
  const other = await start(w, c2, { include_pair: false });
  assert.deepEqual([other.status, other.body.code], [409, 'check-first']);
  assert.match(other.body.error, /different choice of hostnames/);

  // Staging still says noindex: the check is not ready, so nothing starts.
  w.web.pages[`https://${STAGING}/`] = { headers: { 'x-robots-tag': 'noindex' }, body: stagingHtml() };
  const c3 = await checkSite(w);
  assert.equal(c3.body.ready, false);
  const notReady = await start(w, c3);
  assert.deepEqual([notReady.status, notReady.body.code], [409, 'check-first']);
  assert.match(notReady.body.error, /something to fix first/);

  assert.deepEqual([none, old, other, notReady].map((x) => x.waits.length), [0, 0, 0, 0]);
  assert.equal(rowOf(w), null, 'no go-live was begun');
  assert.deepEqual(zoneState(w), before);
});

test('a plan that changed since the check is refused with the fresh plan, and nothing is changed', async () => {
  const w = world();
  const c = await checkSite(w);
  // Someone adds a second address on the apex in the dashboard.
  await w.admin.createDnsRecord(ZONE, { type: 'A', name: 'acme.com', content: '192.0.2.11', proxied: true, ttl: 1 });
  const after = zoneState(w);
  const r = await start(w, c);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'plan-changed');
  assert.equal(r.body.error, 'The plan changed since you checked. Read it again.');
  assert.notEqual(r.body.plan_hash, c.body.plan_hash);
  assert.deepEqual(r.body.plan.delete_records.map((x) => x.content).sort(), ['192.0.2.10', '192.0.2.11', 'acme.com']);
  assert.equal(r.body.ready, true);
  assert.deepEqual(r.body.acks.map((a) => a.id), ['gate12', 'wrangler']);
  assert.deepEqual(zoneState(w), after);
  assert.equal(rowOf(w), null);

  // The page's own hash must match too.
  const c2 = await checkSite(w);
  const stale = await start(w, c2, { plan_hash: c.body.plan_hash });
  assert.equal(stale.body.code, 'plan-changed');

  // A change the hash does not cover, but that fails a check now: a Worker
  // route in front of the apex.
  w.fake.state.routes.push({ id: 'route-1', zone_id: ZONE, pattern: 'acme.com/*', script: 'old-worker' });
  const blocked = await start(w, c2);
  assert.equal(blocked.body.code, 'plan-changed');
  assert.equal(blocked.body.plan_hash, c2.body.plan_hash);
  assert.equal(blocked.body.ready, false);
  assert.equal(blocked.body.checks.find((x) => x.id === 'routes').status, 'fail');
  assert.deepEqual(zoneState(w), after);
});

// A name that would follow the apex to the Worker, added after the check,
// changes neither the plan nor readiness, only a warning. The person must
// see it before anything moves.
test('a new warning since the check stops the start, even when the plan is the same', async () => {
  const w = world();
  const c = await checkSite(w);
  assert.equal(c.body.checks.find((x) => x.id === 'mail').status, 'pass');
  await w.admin.createDnsRecord(ZONE, { type: 'CNAME', name: 'cpanel.acme.com', content: 'acme.com', proxied: false, ttl: 1 });
  const after = zoneState(w);
  const r = await start(w, c);
  assert.deepEqual([r.status, r.body.code], [409, 'plan-changed']);
  assert.equal(r.body.plan_hash, c.body.plan_hash, 'the same plan');
  assert.equal(r.body.ready, true);
  assert.equal(r.body.checks.find((x) => x.id === 'mail').status, 'warn');
  assert.deepEqual(r.waits, []);
  assert.equal(rowOf(w), null, 'nothing was begun');
  assert.deepEqual(zoneState(w), after);

  // Checked again, the warning has been seen, and the start goes ahead.
  const c2 = await checkSite(w);
  assert.equal((await start(w, c2)).status, 200);
});

// The check counts on the calls a plan usually costs. A zone listing that
// pages by the time of the start leaves fewer, and a switch that could not
// be put back must not begin.
test('a start that would leave too few calls for the switch and a full put-back is refused before anything begins', async () => {
  let pages = 0;
  const padded = (fetchImpl) => async (input, init = {}) => {
    const url = new URL(input.url ?? String(input));
    const res = await fetchImpl(input, init);
    if (!pages || init.method !== 'GET' || url.pathname !== `/client/v4/zones/${ZONE}/dns_records`) return res;
    const body = await res.json();
    const page = Number(url.searchParams.get('page') || 1);
    if (page > 1) body.result = [{ id: 'pad' + page, type: 'TXT', name: `pad${page}.acme.com`, content: 'x', proxied: false, ttl: 1, meta: {} }];
    return Response.json({ ...body, result_info: { ...body.result_info, page, total_pages: pages } });
  };
  const w = world({ wrap: padded });
  const before = zoneState(w);
  const c = await checkSite(w);
  assert.equal(c.body.ready, true);
  pages = 20;
  const r = await start(w, c);
  assert.deepEqual([r.status, r.body.code], [409, 'too-many-calls']);
  assert.equal(r.body.error, 'This switch needs more Cloudflare calls than one request allows. Ask a developer.');
  assert.deepEqual(r.waits, []);
  assert.equal(rowOf(w), null, 'nothing was begun');
  assert.deepEqual(zoneState(w), before);
  assert.deepEqual(domainState(w), []);
});

test('the typed hostname and every acknowledgement are required', async () => {
  const w = world();
  const before = zoneState(w);
  const c = await checkSite(w);

  for (const confirm of ['www.acme.com', '', undefined, 42]) {
    const r = await start(w, c, { confirm });
    assert.deepEqual([r.status, r.body.code], [400, 'confirm-mismatch'], String(confirm));
    assert.equal(r.body.error, 'Type acme.com exactly to point it at staging-acme.');
  }
  for (const acks of [[], ['gate12'], 'gate12,wrangler', [{ id: 'wrangler' }], null]) {
    const r = await start(w, c, { acks });
    assert.deepEqual([r.status, r.body.code], [400, 'acks-missing'], JSON.stringify(acks));
    assert.ok(r.body.acks.length > 0);
  }
  const one = await start(w, c, { acks: ['gate12', 'friday'] });
  assert.deepEqual(one.body.acks.map((a) => a.id), ['wrangler']);
  assert.match(one.body.error, /^Tick every acknowledgement first: I have checked tbox\/acme-site’s wrangler config/);
  assert.equal(rowOf(w), null);
  assert.deepEqual(zoneState(w), before);

  // Acknowledgements as { id } objects, and the hostname in any case.
  const ok = await start(w, c, { confirm: '  ACME.COM', acks: [{ id: 'gate12' }, { id: 'wrangler' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('on a Friday in Toronto the friday acknowledgement is needed as well, even if it turned Friday after the check', async () => {
  const w = world();
  clock.t = FRIDAY;
  const c = await checkSite(w);
  assert.deepEqual(c.body.acks.map((a) => a.id), ['gate12', 'wrangler', 'friday']);
  assert.equal((await start(w, c, { acks: ['gate12', 'wrangler'] })).body.code, 'acks-missing');

  // Thursday 23:55 in Toronto, then 00:01 on Friday.
  const late = world();
  clock.t = Date.parse('2026-09-25T03:55:00Z');
  const c2 = await checkSite(late);
  assert.deepEqual(c2.body.acks.map((a) => a.id), ['gate12', 'wrangler']);
  clock.t += 6 * MINUTE;
  const r = await start(late, c2);
  assert.deepEqual([r.status, r.body.code], [400, 'acks-missing']);
  assert.deepEqual(r.body.acks.map((a) => a.id), ['friday']);
  const ok = await start(late, c2, { acks: ['gate12', 'wrangler', 'friday'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.golive.acks.map((a) => a.id), ['gate12', 'wrangler', 'friday']);
});

test('busy: while another run holds the row, start and Roll back wait; a stale one can be rolled back', async () => {
  const w = world();
  const before = zoneState(w);
  const c = await checkSite(w);
  // Ben's switch is running from another tab.
  const bens = await w.desk.goliveBegin(SITE_ID, {
    kind: 'switch', who: 'ben@example.org', record: c.body.plan, acks: [], token: 'bens-run', now: iso(),
  });
  assert.equal(bens.ok, true);

  const s = await start(w, c);
  assert.deepEqual([s.status, s.body.code], [409, 'busy']);
  assert.equal(s.body.reason, 'A switch on this site is running now. Wait for it to finish.');
  assert.equal(s.body.golive.started_by, 'ben@example.org');
  assert.deepEqual(s.waits, []);
  const r = await rollBack(w);
  assert.deepEqual([r.status, r.body.code], [409, 'busy']);
  assert.equal(r.body.reason, 'A switch on this site is running now. Wait for it to finish.');
  assert.deepEqual(zoneState(w), before);

  // Two minutes quiet: Ben's run has stopped, and Roll back takes it over.
  clock.t += 2 * MINUTE + SEC;
  const taken = await rollBack(w);
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.golive.state, 'rolled-back');
  assert.match(taken.body.log.find((x) => x.action === 'rollback-started').text, /takes over a switch that stopped part-way/);
  assert.equal(taken.body.site.live_platform, 'wordpress');
  assert.deepEqual(zoneState(w), before);
});

test('the hostname lock: another site\'s unfinished go-live on the same host fails the check', async () => {
  const other = { id: OTHER_ID, name: 'Acme (old record)', live_domain: 'acme.com', staging_domain: STAGING, live_platform: 'astro' };
  const w = world({ sites: [SITE, other] });
  const record = {
    zone_id: ZONE, zone_name: 'acme.com', worker: W, staging_host: STAGING, main_host: 'acme.com',
    hosts: [{ hostname: 'acme.com', role: 'main' }], saved_records: [], saved_domains: [], redirect: null, mx_txt: [],
  };
  store.goliveBegin(w.storage.sql, OTHER_ID, { kind: 'switch', who: 'ben@example.org', record, token: 't', now: iso() });
  store.goliveFinish(w.storage.sql, OTHER_ID, 't', { state: 'checking', fields: { switched_at: iso() }, now: iso() });

  const c = await checkSite(w);
  assert.equal(c.body.ready, false);
  const hosts = c.body.checks.find((x) => x.id === 'hosts');
  assert.equal(hosts.status, 'fail');
  assert.match(hosts.detail, /acme\.com has an unfinished or live go-live on Acme \(old record\)\./);
  assert.equal((await start(w, c)).body.code, 'check-first');
});

// --- When a switch goes wrong ---

test('a switch that fails before every host is attached puts everything back and answers 502', async () => {
  const w = world({ wrap: failAttach('www.acme.com', 500, 10013, 'Workers are having a moment.') });
  const before = zoneState(w);
  const c = await checkSite(w);
  const s = await start(w, c);
  assert.equal(s.status, 502);
  assert.equal(s.body.code, 'switch-failed');
  assert.equal(s.waits.length, 1);
  assert.match(s.body.error, /^Could not attach www\.acme\.com to staging-acme\. Cloudflare said: Workers are having a moment/);
  assert.equal(s.body.golive.state, 'switch-failed');
  assert.equal(s.body.golive.restored, 1);
  assert.equal(s.body.golive.error, s.body.error);
  assert.ok(s.body.golive.notes.some((x) => /keeps the certificate/.test(x)));
  assert.equal(s.body.site.live_platform, 'wordpress', 'the platform was never changed');
  assert.deepEqual(actions(s.body.log), [
    'switch-started', 'record-deleted', 'record-deleted', 'domain-attached',
    'domain-detached', 'record-restored', 'record-restored', 'switch-failed',
  ]);
  assert.deepEqual(zoneState(w), before);
  assert.deepEqual(domainState(w), []);

  // Put back, so it may go live again; there is nothing to roll back or check.
  assert.equal((await rollBack(w)).body.code, 'nothing-to-undo');
  assert.equal((await call(w, 'POST', path('verify'))).body.code, 'not-switched');
  assert.equal((await checkSite(w)).body.ready, true);
});

test('with the most records a plan allows, a switch that fails late still leaves the restore its calls', async () => {
  const most = [
    { type: 'A', name: 'acme.com', content: '192.0.2.10', proxied: true },
    { type: 'A', name: 'acme.com', content: '192.0.2.11', proxied: true },
    { type: 'A', name: 'acme.com', content: '192.0.2.12', proxied: true },
    { type: 'AAAA', name: 'acme.com', content: '2001:db8::1', proxied: true },
    { type: 'CNAME', name: 'www.acme.com', content: 'acme.com', proxied: true },
    { type: 'MX', name: 'acme.com', content: 'mx.mailhost.net', priority: 10 },
  ];
  // www clashes on every try, so the attach is tried three times.
  const w = world({ records: most, wrap: failAttach('www.acme.com', 409, 100117, "Hostname 'www.acme.com' already has externally managed DNS records.") });
  const before = zoneState(w);
  const c = await checkSite(w);
  assert.equal(c.body.ready, true);
  const waits = [];
  const s = await start(w, c, {}, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(s.status, 502);
  assert.equal(s.body.golive.restored, 1, JSON.stringify(s.body.golive.error));
  assert.deepEqual(waits, [1000, 2000]);
  assert.ok(s.calls <= LIMIT);
  assert.deepEqual(zoneState(w), before);

  // One record more and the check refuses: the switch and its restore would
  // not both fit in one request.
  const more = world({ records: [...most, { type: 'AAAA', name: 'acme.com', content: '2001:db8::2', proxied: true }] });
  const c2 = await checkSite(more);
  assert.equal(c2.body.ready, false);
  assert.match(c2.body.checks.find((x) => x.id === 'records').detail, /more Cloudflare calls than one request allows/);
  assert.equal((await start(more, c2)).body.code, 'check-first');
});

test('a switch that runs out of its 90 seconds is put back within a fresh 60 of its own', async () => {
  // The apex attach answers after 91 seconds.
  const slow = (fetchImpl) => async (input, init = {}) => {
    const res = await fetchImpl(input, init);
    if (init.method === 'PUT' && JSON.parse(init.body).hostname === 'acme.com') clock.t += 91 * SEC;
    return res;
  };
  const w = world({ wrap: slow });
  const before = zoneState(w);
  const c = await checkSite(w);
  const s = await start(w, c);
  assert.equal(s.status, 502);
  assert.equal(s.body.error, 'Ran out of time before attaching www.acme.com.');
  assert.equal(s.body.golive.restored, 1, 'the restore had time of its own');
  assert.deepEqual(zoneState(w), before);
  assert.deepEqual(domainState(w), []);
});

test('a restore that runs out of its own 60 seconds says what is not back, and Roll back finishes it', async () => {
  let restoring = false;
  const slow = (fetchImpl) => async (input, init = {}) => {
    const res = await fetchImpl(input, init);
    if (init.method === 'PUT' && JSON.parse(init.body).hostname === 'acme.com') {
      clock.t += 91 * SEC;
      restoring = true;
    } else if (restoring) {
      // The restore's first call answers after 61 seconds.
      clock.t += 61 * SEC;
      restoring = false;
    }
    return res;
  };
  const w = world({ wrap: slow });
  const before = zoneState(w);
  const c = await checkSite(w);
  const s = await start(w, c);
  assert.equal(s.status, 502);
  assert.equal(s.body.golive.state, 'switch-failed');
  assert.equal(s.body.golive.restored, 0);
  assert.match(s.body.error, /^Ran out of time before attaching www\.acme\.com\. Not everything was put back: /);
  assert.match(s.body.error, /Ran out of time for this run/);
  assert.notDeepEqual(zoneState(w), before);

  const r = await rollBack(w);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.golive.state, 'rolled-back');
  assert.equal(r.body.site.live_platform, 'wordpress');
  assert.deepEqual(zoneState(w), before);
  assert.deepEqual(domainState(w), []);
});

test('a finish that fails is tried once more, and a failed finish never puts anything back', async () => {
  const w = world();
  const finish = w.desk.goliveFinish;
  let failures = 1;
  w.desk.goliveFinish = async (...args) => {
    if (failures-- > 0) throw new Error('Durable Object reset because its code was updated.');
    return finish(...args);
  };
  const from = w.fake.calls.length;
  const { s } = await goLive(w);
  assert.equal(s.body.golive.state, 'checking');
  assert.equal(s.body.site.live_platform, 'astro');
  assert.deepEqual(cfCalls(w, from, isDetach), [], 'nothing was detached');

  // The finish was written but its answer lost: the second try gets what
  // was saved, not "another run took over".
  const w1 = world();
  const real = w1.desk.goliveFinish;
  let lost = 1;
  w1.desk.goliveFinish = async (...args) => {
    const res = await real(...args);
    if (lost-- > 0) throw new Error('Network connection lost.');
    return res;
  };
  const { s: s1 } = await goLive(w1);
  assert.equal(s1.body.golive.state, 'checking');
  assert.equal(s1.body.site.live_platform, 'astro');
  assert.equal(actions(s1.body.log).filter((a) => a === 'switched').length, 1, 'written once');

  // It fails twice: the switch has happened, so the desk says so and leaves it.
  const w2 = world();
  w2.desk.goliveFinish = async () => { throw new Error('Durable Object storage is unavailable.'); };
  const from2 = w2.fake.calls.length;
  const c = await checkSite(w2);
  const r = await start(w2, c);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'not-recorded');
  assert.match(r.body.error, /^Every host is on staging-acme, but the desk could not record that the switch finished \(Durable Object storage is unavailable\.\)/);
  assert.deepEqual(cfCalls(w2, from2, isDetach), []);
  assert.deepEqual(domainState(w2), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);
  assert.equal(rowOf(w2).state, 'switching');

  // Two minutes on, Check now carries on from there.
  clock.t += 2 * MINUTE + SEC;
  const v = await call(w2, 'POST', path('verify'));
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(['checking', 'live'].includes(v.body.golive.state));
  assert.ok(store.goliveDetail(w2.storage.sql, SITE_ID, clock.t).log.some((x) => x.action === 'resumed'));
  assert.equal(v.body.site.live_platform, 'astro');
});

test('a switch whose row another run took over stops at once and puts nothing back', async () => {
  const w = world();
  const step = w.desk.goliveStep;
  let n = 0;
  w.desk.goliveStep = async (...args) => {
    // A Roll back takes the row between the switch's first and second step.
    if (++n === 2) w.storage.sql.exec("UPDATE golive SET run_token = 'rollback-run' WHERE site_id = ?", SITE_ID);
    return step(...args);
  };
  const c = await checkSite(w);
  const from = w.fake.calls.length;
  const s = await start(w, c);
  assert.deepEqual([s.status, s.body.code], [409, 'busy']);
  assert.equal(s.body.reason, 'Another run took over this go-live, so this one stopped.');
  assert.equal(s.body.golive.state, 'switching');
  assert.deepEqual(cfCalls(w, from, isAttach), [], 'nothing more was attached');
  assert.deepEqual(cfCalls(w, from, isCreate), [], 'and nothing was put back: the other run decides');
});

test('a redirect that cannot be added does not stop the switch; the row says what failed', async () => {
  const w = world();
  w.fake.failOn('POST', /^\/zones\/[^/]+\/rulesets(\/[^/]+\/rules)?$/, { status: 500, codes: [10001], message: 'Rules are having a moment.' });
  const { s } = await goLive(w);
  assert.equal(s.body.golive.state, 'checking');
  assert.match(s.body.golive.error, /Rules are having a moment/);
  assert.ok(actions(s.body.log).includes('redirect-failed'));
  assert.match(s.body.log.at(-1).text, /The redirect from www\.acme\.com was not added/);
  assert.equal(s.body.site.live_platform, 'astro');
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);

  clock.t += 5 * MINUTE;
  const v = await call(w, 'POST', path('verify'));
  const redirect = v.body.checks.find((x) => x.id === 'redirect');
  assert.equal(redirect.status, 'fail');
  assert.match(redirect.detail, /^The redirect rule was not added: .*Rules are having a moment/);
  assert.equal(v.body.done, false);
  assert.equal(v.body.golive.state, 'checking');
});

// --- Roll back and Check now ---

test('a Roll back more than seven days after the switch needs the old-host acknowledgement', async () => {
  const w = world();
  await goLive(w);
  clock.t += 7 * DAY + MINUTE;
  const r = await rollBack(w);
  assert.deepEqual([r.status, r.body.code], [400, 'acks-missing']);
  assert.deepEqual(r.body.acks, [{
    id: 'old-host', label: 'The old host is still ours: its address has not been switched off or given up (gate 20)',
  }]);
  assert.equal(rowOf(w).state, 'checking', 'nothing was begun');

  const ok = await rollBack(w, { confirm: 'acme.com', acks: ['old-host'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.golive.state, 'rolled-back');
  const started = ok.body.log.find((x) => x.action === 'rollback-started');
  assert.deepEqual(started.detail.acks.map((a) => a.id), ['old-host']);
  assert.equal(started.who, ANA);
});

// A switch that failed and was not all put back, or one that stopped
// part-way, has no switched_at, and can still be rolled back months later.
test('a Roll back of a failed or stopped switch started more than seven days ago needs the old-host acknowledgement too', async () => {
  let restoring = false;
  const slow = (fetchImpl) => async (input, init = {}) => {
    const res = await fetchImpl(input, init);
    if (init.method === 'PUT' && JSON.parse(init.body).hostname === 'acme.com') {
      clock.t += 91 * SEC;
      restoring = true;
    } else if (restoring) {
      clock.t += 61 * SEC;
      restoring = false;
    }
    return res;
  };
  const w = world({ wrap: slow });
  const before = zoneState(w);
  const s = await start(w, await checkSite(w));
  assert.deepEqual([s.body.golive.state, s.body.golive.restored, s.body.golive.switched_at], ['switch-failed', 0, null]);
  clock.t += 7 * DAY + MINUTE;
  const r = await rollBack(w);
  assert.deepEqual([r.status, r.body.code], [400, 'acks-missing']);
  assert.deepEqual(r.body.acks.map((a) => a.id), ['old-host']);
  assert.equal(rowOf(w).state, 'switch-failed', 'nothing was begun');
  const ok = await rollBack(w, { confirm: 'acme.com', acks: ['old-host'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(zoneState(w), before);

  // A switch that stopped part-way: stale for a week, never switched.
  const w2 = world();
  const c = await checkSite(w2);
  await w2.desk.goliveBegin(SITE_ID, { kind: 'switch', who: 'ben@example.org', record: c.body.plan, acks: [], token: 'lost', now: iso() });
  clock.t += 7 * DAY + MINUTE;
  assert.deepEqual((await rollBack(w2)).body.acks.map((a) => a.id), ['old-host']);
  assert.equal((await rollBack(w2, { confirm: 'acme.com', acks: ['old-host'] })).body.golive.state, 'rolled-back');
});

test('Roll back is refused with nothing to undo, or without the typed hostname', async () => {
  const w = world();
  const none = await rollBack(w);
  assert.deepEqual([none.status, none.body.code], [409, 'nothing-to-undo']);
  assert.equal(none.body.golive, null);

  await goLive(w);
  for (const confirm of ['www.acme.com', '', undefined]) {
    const r = await rollBack(w, { confirm, acks: [] });
    assert.deepEqual([r.status, r.body.code], [400, 'confirm-mismatch']);
    assert.equal(r.body.error, 'Type acme.com exactly to roll it back.');
    assert.deepEqual(r.waits, []);
  }
  assert.equal(rowOf(w).state, 'checking');
});

// Check now reads the row, then spends a while on the network. What it
// found about one run must never make a later run live.
test('Check now saves nothing when the go-live was started again while it was checking', async () => {
  const w = world();
  await goLive(w);
  clock.t += 5 * MINUTE;
  const live = w.web.pages['https://acme.com/*'];
  let once = true;
  w.web.pages['https://acme.com/*'] = (url, init) => {
    // Rolled back and switched again from another tab, meanwhile.
    if (once) w.storage.sql.exec('UPDATE golive SET started_at = ? WHERE site_id = ?', iso(), SITE_ID);
    once = false;
    return live(url, init);
  };
  const v = await call(w, 'POST', path('verify'));
  assert.deepEqual([v.status, v.body.code], [409, 'not-switched']);
  assert.equal(v.body.error, 'This go-live was rolled back or started again while the desk was checking it, so the check was not saved. Check again.');
  assert.equal(rowOf(w).state, 'checking', 'not made live');
  assert.equal(rowOf(w).checks, null);

  const again = await call(w, 'POST', path('verify'));
  assert.equal(again.body.golive.state, 'live');
});

// Cloudflare made the rule, but the answer to the POST never came.
test('a redirect rule whose answer was lost is found by its ref and recorded, and the site goes live', async () => {
  let drop = true;
  const lossy = (fetchImpl) => async (input, init = {}) => {
    const res = await fetchImpl(input, init);
    if (drop && init.method === 'POST' && /\/rulesets(\/[^/]+\/rules)?$/.test(new URL(input.url ?? String(input)).pathname)) {
      drop = false;
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    return res;
  };
  const w = world({ wrap: lossy });
  const { s } = await goLive(w);
  assert.equal(ourRules(w).length, 1);
  assert.deepEqual(s.body.golive.redirect_rule, { ruleset_id: w.fake.state.rulesets[0].id, rule_id: ourRules(w)[0].id, ref: REF });
  assert.equal(s.body.golive.error, null);
  assert.equal(s.body.site.golive.has_error, false);

  clock.t += 5 * MINUTE;
  const v = await call(w, 'POST', path('verify'));
  assert.equal(v.body.checks.find((x) => x.id === 'redirect').status, 'pass');
  assert.equal(v.body.golive.state, 'live');
});

// The row lost track of its rule (a switch cut off after Cloudflare made it,
// then resumed by Check now): verify finds it by its ref, and the row keeps it.
test('Check now finds a redirect rule the row does not know about, and records it', async () => {
  const w = world();
  await goLive(w);
  const [rule] = ourRules(w);
  w.storage.sql.exec("UPDATE golive SET redirect_rule = NULL, error = 'The redirect rule was not added: no answer.' WHERE site_id = ?", SITE_ID);
  clock.t += 5 * MINUTE;
  const v = await call(w, 'POST', path('verify'));
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.checks.find((x) => x.id === 'redirect').status, 'pass');
  assert.equal(v.body.golive.state, 'live');
  assert.deepEqual(v.body.golive.redirect_rule, { ruleset_id: w.fake.state.rulesets[0].id, rule_id: rule.id, ref: REF });
  assert.equal(v.body.golive.error, null);
  assert.ok(actions(store.goliveDetail(w.storage.sql, SITE_ID, clock.t).log).includes('redirect-found'));
  assert.equal(ourRules(w).length, 1, 'and no second rule');
});

test('a go-live record the desk cannot read is shown as such, and neither checked nor rolled back', async () => {
  const w = world();
  await goLive(w);
  w.storage.sql.exec(`UPDATE golive SET saved_records = '[{"id":' WHERE site_id = ?`, SITE_ID);
  const from = w.fake.calls.length;
  const d = await call(w, 'GET', path());
  assert.equal(d.body.golive.state, 'unreadable');
  assert.equal(d.body.site.golive.state, 'checking', 'the list reads only what it shows');
  const r = await rollBack(w);
  assert.deepEqual([r.status, r.body.code], [409, 'unreadable']);
  assert.match(r.body.error, /^The desk cannot read this site's go-live record, so it cannot roll it back\./);
  assert.equal((await call(w, 'POST', path('verify'))).body.code, 'not-switched');
  assert.equal(w.fake.calls.length, from, 'Cloudflare was not asked');
});

test('Check now is refused while the site is not switched', async () => {
  const w = world();
  const none = await call(w, 'POST', path('verify'));
  assert.deepEqual([none.status, none.body.code], [409, 'not-switched']);
  assert.equal(none.body.golive, null);
  assert.equal(w.fake.calls.length, 0);
});

// --- Signing in with Access ---

async function signin(w, query, { token, env = ENV, method = 'GET' } = {}) {
  const url = new URL(`https://${DESK}/api/golive/signin${query}`);
  const headers = token === null ? {} : { 'cf-access-jwt-assertion': token ?? await jwt() };
  return handleGoLiveSignin(new Request(url, { method, headers }), env, { url, fetchImpl: w.net, now: () => clock.t });
}

test('signin sends the browser back to the page, and only ever to a fixed address', async () => {
  const w = world();
  const ok = await signin(w, '?site=' + SITE_ID);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/#golive=' + SITE_ID);
  for (const [k, v] of Object.entries(HEADERS)) if (k !== 'content-type') assert.equal(ok.headers.get(k), v, k);

  for (const query of ['', '?site=', '?site=' + SITE_ID.toUpperCase(), '?site=https://evil.example/',
    '?site=' + encodeURIComponent('//evil.example/' + SITE_ID.slice(15)), '?site=' + SITE_ID + 'x', '?other=' + SITE_ID]) {
    const r = await signin(w, query);
    assert.equal(r.headers.get('location'), '/', query);
  }

  const cases = [
    [{ token: null }, 'access-not-protecting'],
    [{ token: await jwt({ key: STRANGER_KEY }) }, 'access-invalid'],
    [{ token: await jwt({ email: 'eve@example.com' }) }, 'not-allowed'],
    [{ env: { ...ENV, GOLIVE_API_TOKEN: '' } }, 'golive-not-set-up'],
  ];
  for (const [opts, code] of cases) {
    const r = await signin(w, '?site=' + SITE_ID, opts);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/#golive-error=' + code);
  }

  const post = await signin(w, '?site=' + SITE_ID, { method: 'POST' });
  assert.deepEqual([post.status, await post.json()], [405, { error: 'Method not allowed.' }]);
  assert.ok(w.net.calls.every((x) => new URL(x.url).hostname === TEAM), 'signin asks Access for its keys and nothing else');
});
