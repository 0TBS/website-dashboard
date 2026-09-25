import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildPlan, preflight, requiredAcks, planHash, checksDigest, switchOn, restore, verify, restoreCost, switchCost,
  SwitchError, redirectRuleFor, recordText, isFriday, isReady, DESK_WORKER,
  readCapped, robotsNoindex, canonicalHost, resourceUrls, oldFiles, astroAssets, pageTitle, firstInternalLink,
  robotsBlocksAll, spfHasBareA, cnameChain, routeCovers, doh,
} from '../src/golive.js';
import { cloudflare } from '../src/cloudflare.js';
import { budget, countedFetch, LIMIT } from '../src/budget.js';
import { createFakeCloudflare, createFakeSites, createFakeDoh, combineFetches } from './fake-cloudflare.js';

// Every call must go through the fetch a test passes in, so the budget
// counts it. There is no global fetch to fall back on.
globalThis.fetch = async () => { throw new Error('golive.js used the global fetch'); };

const ACCOUNT = 'acc00000000000000000000000000001';
const ZONE = 'e0000000000000000000000000000001';      // acme.com, the client
const DESK_ZONE = 'e0000000000000000000000000000002'; // 10xid.com, the desk's own
const OTHER_ZONE = 'e0000000000000000000000000000003'; // other.com, another client
const SITE_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const REF = 'desk-' + SITE_ID;
const STAGING = 'staging-acme.10xid.com';
const W = 'staging-acme';
const NS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
const DESK = 'website.10xid.com';
const THURSDAY = Date.parse('2026-09-24T16:00:00Z');
const FRIDAY = Date.parse('2026-09-25T16:00:00Z');
const MINUTE = 60 * 1000;
const CERT_CALLS = 2; // the Access keys, before any go-live call

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
  { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' },
];

function stagingHtml({ canonical = 'https://acme.com/', head = '', body = '', title = 'Acme Plumbing', assets = true } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="canonical" href="${canonical}">
${assets ? '<link rel="stylesheet" href="/_astro/index.B1x2y3.css">\n<script type="module" src="/_astro/page.C4d5e6.js"></script>' : ''}${head}
</head><body><nav><a href="/">Home</a> <a href="/services/">Services</a></nav>
<img src="https://img.acme.com/logo.webp" alt="Acme">${body}</body></html>`;
}

const OLD_HTML = '<!doctype html><title>Acme Plumbing – Just another WordPress site</title>'
  + '<link rel="stylesheet" href="/wp-content/themes/acme/style.css">';

// What Cloudflare's managed robots.txt puts in front of a site's own.
const MANAGED_ROBOTS = `# As a condition of accessing this website, you agree to abide by the following
# content signals:
#   search: building a search index and providing search results
User-Agent: *
Content-Signal: search=yes,ai-train=no
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: GPTBot
Disallow: /
`;

// The client's hosts as the world sees them: the old WordPress site until a
// host is on the staging Worker, then the staging build, and a 301 once a
// redirect rule for the host is in.
function liveSite(fake, url) {
  const rule = fake.redirectRules(ZONE).find((r) => r.enabled && r.expression === `(http.host eq "${url.hostname}")`);
  if (rule) {
    const target = rule.action_parameters.from_value.target_url.expression.match(/concat\("([^"]+)"/)[1];
    return { status: 301, headers: { location: target + url.pathname + url.search } };
  }
  if (!fake.state.domains.some((d) => d.hostname === url.hostname && d.service === W)) return { body: OLD_HTML };
  if (url.pathname === '/') return { body: stagingHtml() };
  if (url.pathname === '/services/') return { body: '<title>Services</title>' };
  return { status: 404, body: 'Not found' };
}

// Cloudflare, the sites and both public resolvers, behind one fetch.
// `wrap` puts something in front of Cloudflare alone.
function world({
  records = RECORDS, domains = [], rulesets = [], routes = [], secrets = {}, sslMode = 'full', detachLag = 0,
  zone = {}, pages = {}, dns = {}, wrap = null,
} = {}) {
  const fake = createFakeCloudflare({
    accountId: ACCOUNT,
    zones: [
      { id: ZONE, name: 'acme.com', ...zone },
      { id: DESK_ZONE, name: '10xid.com' },
      { id: OTHER_ZONE, name: 'other.com' },
    ],
    records,
    domains: [{ hostname: DESK, service: DESK_WORKER }, { hostname: STAGING, service: W }, ...domains],
    workers: [W, 'acme-live', 'someone-else'],
    rulesets, routes, secrets, sslMode, detachLag,
  });
  const site = (url) => liveSite(fake, url);
  const sites = createFakeSites({
    [`https://${STAGING}/`]: { body: stagingHtml() },
    [`https://${STAGING}/robots.txt`]: { headers: { 'content-type': 'text/plain' }, body: MANAGED_ROBOTS + '\nUser-agent: *\nAllow: /\n' },
    'https://acme.com/*': site,
    'https://www.acme.com/*': site,
    'https://shop.acme.com/*': site,
    ...pages,
  });
  // Each resolver gets its own copy, so a test can change one alone.
  const table = () => structuredClone({ 'acme.com': { NS, MX: '10 mx.mailhost.net' }, ...dns });
  const resolvers = createFakeDoh({ 'dns.google': table(), 'cloudflare-dns.com': table() });
  const net = combineFetches(wrap ? [fake.claims, wrap(fake.fetch)] : fake, sites, resolvers);
  // Changes a test makes behind the desk's back, as a person would in the
  // dashboard: not counted against any request.
  const admin = cloudflare({ token: 'tok-admin', accountId: ACCOUNT, fetchImpl: fake.fetch });
  return { fake, sites, resolvers, net, admin };
}

// One request to the Worker: its own budget and counted fetch in front of
// the world, as the routes make one per request.
function request(w, { used = CERT_CALLS, limit = LIMIT } = {}) {
  const allowance = budget(limit);
  allowance.used = used;
  const before = w.net.calls.length;
  const fetchImpl = countedFetch(w.net, allowance);
  return {
    budget: allowance,
    fetch: fetchImpl,
    cf: cloudflare({ token: 'tok-test', accountId: ACCOUNT, fetchImpl }),
    start: used,
    calls: () => w.net.calls.length - before,
  };
}

// Every call went through the request's counted fetch, and never past its limit.
function withinBudget(req) {
  assert.equal(req.budget.used - req.start, req.calls(), 'every call was counted');
  assert.ok(req.budget.used <= req.budget.limit, `used ${req.budget.used} of ${req.budget.limit}`);
}

// Stands in for goliveStep: keeps what a run adds and sets, and answers
// stale from the nth step on. `throwOn(entry, n)` makes a step throw, as a
// Durable Object call does when the object resets or is overloaded.
function steps({ staleFrom = Infinity, onStep, throwOn } = {}) {
  const row = {};
  const entries = [];
  async function step(entry) {
    if (entries.length >= staleFrom) return { stale: true };
    if (throwOn?.(entry, entries.length)) throw new Error('Durable Object reset because its code was updated.');
    entries.push(entry);
    for (const [k, v] of Object.entries(entry.add || {})) row[k] = [...(row[k] || []), ...v];
    Object.assign(row, entry.fields || {});
    await onStep?.(entry);
    return { ok: true };
  }
  const logs = () => entries.flatMap((e) => e.log || []);
  return { step, row, entries, actions: () => logs().map((l) => l.action), texts: () => logs().map((l) => l.text) };
}

function sleeper() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

// The go-live row goliveBegin writes from a plan.
function rowOf(plan) {
  return {
    site_id: plan.site_id, zone_id: plan.zone.id, zone_name: plan.zone.name, worker: plan.worker,
    staging_host: plan.staging_host, main_host: plan.main, hosts: plan.hosts,
    saved_records: plan.delete_records, saved_domains: plan.saved_domains, redirect: plan.redirect,
    mx_txt: plan.mx_txt, attached: [], steps_done: [], redirect_rule: null,
  };
}

async function runCheck(w, { site = SITE, includePair = true, busyHosts = [], now = THURSDAY, deskHost = DESK } = {}) {
  const req = request(w);
  const out = await preflight({ site, includePair, cf: req.cf, deskHost, busyHosts, siteFetch: req.fetch, doh: req.fetch, now });
  withinBudget(req);
  return { ...out, req, byId: (id) => out.checks.find((c) => c.id === id) };
}

// Start: the plan again from Cloudflare, then the switch, in one request.
async function goLive(w, { site = SITE, includePair = true, sleep = sleeper().sleep, stepper = steps() } = {}) {
  const req = request(w);
  const { checks, plan } = await buildPlan({ site, includePair, cf: req.cf, deskHost: DESK });
  assert.ok(isReady(checks), 'the plan is ready: ' + JSON.stringify(checks.filter((c) => c.status === 'fail')));
  const row = rowOf(plan);
  const result = await switchOn({ record: row, cf: req.cf, sleep, step: stepper.step, budget: req.budget });
  withinBudget(req);
  assert.ok(req.budget.remaining() >= restoreCost(row), 'a restore would still have had its calls');
  const record = {
    ...row, ...stepper.row, switched_at: new Date(THURSDAY).toISOString(),
    error: result.redirectError ? result.redirectError.message : null,
  };
  return { plan, record, result, stepper, req };
}

async function rollBack(w, record, { sleep = sleeper().sleep, stepper = steps() } = {}) {
  const req = request(w);
  const out = await restore({ record, cf: req.cf, sleep, step: stepper.step, budget: req.budget });
  withinBudget(req);
  return { ...out, stepper, req };
}

async function checkNow(w, record, now = THURSDAY + 5 * MINUTE) {
  const req = request(w);
  const out = await verify({ record, cf: req.cf, siteFetch: req.fetch, doh: req.fetch, now });
  withinBudget(req);
  return { ...out, byId: (id) => out.checks.find((c) => c.id === id) };
}

// The zone as a person compares it: what each record says, not its id.
const zoneState = (w) => w.fake.state.records.filter((r) => r.zone_id === ZONE)
  .map((r) => `${r.type} ${r.name} ${r.content} ${r.proxied ? 'proxied' : 'dns-only'} ttl=${r.ttl}${r.meta?.read_only ? ' read-only' : ''}`)
  .sort();
const domainState = (w) => w.fake.state.domains.filter((d) => d.zone_id === ZONE).map((d) => `${d.hostname} on ${d.service}`).sort();
const uniqueResolvers = (w, name) => [...new Set(w.resolvers.calls.filter((c) => c.name === name).map((c) => c.resolver))].sort();
const ourRules = (w) => w.fake.redirectRules(ZONE).filter((r) => r.ref === REF);

// Cloudflare calls since `from`, as short labels, for checking the order.
function callLabels(w, from, names = {}) {
  return w.fake.calls.slice(from).map((c) => {
    if (c.path.endsWith('/entrypoint')) return 'rules';
    if (c.path.includes('/rules/')) return 'delete rule';
    if (c.method === 'POST' && /\/rulesets(\/[^/]+\/rules)?$/.test(c.path)) return 'add rule';
    if (c.path.endsWith('/workers/domains')) return c.method === 'GET' ? 'domains' : 'attach ' + c.body.hostname;
    if (c.path.includes('/workers/domains/')) return 'detach ' + (names[c.path.split('/').pop()] || '?');
    if (c.path.endsWith('/dns_records')) return c.method === 'GET' ? 'records' : `create ${c.body.type} ${c.body.name}`;
    if (c.path.includes('/dns_records/')) return 'delete record';
    return c.method + ' ' + c.path;
  });
}

// --- A whole go-live: check, switch, verify, roll back ---

test('apex + www: every check passes, the switch moves both, verify passes, and Roll back puts it all back', async () => {
  const w = world();
  const before = zoneState(w);
  const mailIds = w.fake.state.records.filter((r) => r.type === 'MX' || r.type === 'TXT').map((r) => r.id);

  const c = await runCheck(w);
  assert.ok(c.ready);
  assert.deepEqual(c.checks.map((x) => [x.id, x.status]), [
    ['addresses', 'pass'], ['zone', 'pass'], ['worker', 'pass'], ['hosts', 'pass'], ['records', 'pass'], ['mail', 'pass'],
    ['mx-txt', 'pass'], ['routes', 'pass'], ['ssl', 'pass'], ['redirects', 'pass'], ['wrangler', 'warn'], ['staging-stays', 'warn'],
    ['staging', 'pass'], ['noindex', 'pass'], ['canonical', 'pass'], ['old-files', 'pass'], ['robots', 'pass'], ['nameservers', 'pass'],
  ]);
  assert.equal(c.req.calls(), 12, 'eight Cloudflare reads, the page, robots.txt and two resolvers');
  assert.deepEqual(c.plan.hosts, [{ hostname: 'acme.com', role: 'main' }, { hostname: 'www.acme.com', role: 'redirect' }]);
  assert.deepEqual(c.plan.delete_records.map(recordText), [
    'A acme.com → 192.0.2.10 (proxied, TTL auto)', 'CNAME www.acme.com → acme.com (proxied, TTL auto)',
  ]);
  assert.ok(c.plan.delete_records.every((r) => r.id && r.created_on), 'full records, the rollback');
  assert.deepEqual(c.plan.saved_domains, []);
  assert.deepEqual(c.plan.redirect, { from: 'www.acme.com', to: 'acme.com', ref: REF });
  assert.deepEqual(c.plan.mx_txt, [
    { type: 'MX', name: 'acme.com', content: 'mx.mailhost.net', priority: 10 },
    { type: 'TXT', name: 'acme.com', content: 'v=spf1 include:_spf.mailhost.net ~all', priority: null },
  ]);
  assert.equal(c.plan.worker, W);
  assert.deepEqual(c.plan.zone, { id: ZONE, name: 'acme.com', plan: 'free', name_servers: NS });
  assert.equal(c.byId('redirects').detail, 'Will add a 301 from www.acme.com to acme.com. Page Rules and Bulk Redirects are not checked.');
  assert.deepEqual(c.byId('records').items, [
    'A acme.com → 192.0.2.10 (proxied, TTL auto)', 'CNAME www.acme.com → acme.com (proxied, TTL auto)',
  ]);

  const sleep = sleeper();
  const from = w.fake.calls.length;
  const { record, result, stepper } = await goLive(w, { sleep: sleep.sleep });
  assert.deepEqual(sleep.waits, []);
  assert.deepEqual(callLabels(w, from).slice(8), [
    'delete record', 'delete record', 'attach acme.com', 'attach www.acme.com',
    'records', // one listing notes both Worker records
    'rules', 'rules', 'add rule',
  ], 'the plan again (eight reads), then the switch');
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);
  assert.deepEqual(zoneState(w), [
    'AAAA acme.com 100:: proxied ttl=1 read-only', 'AAAA www.acme.com 100:: proxied ttl=1 read-only',
    'MX acme.com mx.mailhost.net dns-only ttl=1',
    'TXT _dmarc.acme.com v=DMARC1; p=none dns-only ttl=1', 'TXT acme.com v=spf1 include:_spf.mailhost.net ~all dns-only ttl=1',
  ]);
  assert.deepEqual(w.fake.state.records.filter((r) => r.type === 'MX' || r.type === 'TXT').map((r) => r.id), mailIds, 'MX and TXT untouched');
  const [rule] = ourRules(w);
  const want = redirectRuleFor({ from: 'www.acme.com', to: 'acme.com', ref: REF });
  for (const k of ['ref', 'description', 'expression', 'action', 'action_parameters', 'enabled']) assert.deepEqual(rule[k], want[k], k);
  assert.equal(rule.expression, '(http.host eq "www.acme.com")');
  assert.deepEqual(result.redirectRule, { ruleset_id: w.fake.state.rulesets[0].id, rule_id: rule.id, ref: REF });
  assert.equal(result.redirectError, null);

  // Each host's Worker record was noted, so a Roll back can wait for it.
  const workerIds = Object.fromEntries(w.fake.state.records.filter((r) => r.meta.read_only).map((r) => [r.name, r.id]));
  assert.deepEqual(result.attached.map((a) => [a.hostname, a.dns_id]), [['acme.com', workerIds['acme.com']], ['www.acme.com', workerIds['www.acme.com']]]);
  assert.deepEqual(record.attached, result.attached, 'the step stored them');
  assert.deepEqual(stepper.actions(), ['record-deleted', 'record-deleted', 'domain-attached', 'domain-attached', 'worker-records', 'redirect-added']);
  const ids = c.plan.delete_records.map((r) => r.id);
  assert.deepEqual(record.steps_done, ['deleted:' + ids[0], 'deleted:' + ids[1], 'attached:acme.com', 'attached:www.acme.com', 'redirect']);
  assert.deepEqual(record.redirect_rule, result.redirectRule);
  assert.equal(stepper.texts()[0], 'Deleted A acme.com → 192.0.2.10 (proxied, TTL auto). It is saved, so Roll back can put it back.');

  const v = await checkNow(w, record);
  assert.deepEqual(v.checks.map((x) => [x.id, x.status]), [
    ['https', 'pass'], ['noindex', 'pass'], ['same-site', 'pass'], ['deep-page', 'pass'], ['redirect', 'pass'],
    ['still-attached', 'pass'], ['public-dns', 'pass'], ['mx-txt', 'pass'],
  ]);
  assert.equal(v.done, true);

  const back = await rollBack(w, record);
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(zoneState(w), before, 'every record back as it was');
  assert.deepEqual(domainState(w), []);
  assert.deepEqual(ourRules(w), []);
  assert.deepEqual(back.stepper.actions(), ['redirect-removed', 'domain-detached', 'record-restored', 'domain-detached', 'record-restored']);
  assert.equal(back.notes.length, 1);
  assert.match(back.notes[0], /certificate it made for acme\.com and www\.acme\.com/);
});

test('Worker to Worker: the hosts move off the live Worker and Roll back moves them back', async () => {
  const w = world({
    records: RECORDS.filter((r) => r.type === 'MX' || r.type === 'TXT'),
    domains: [{ hostname: 'acme.com', service: 'acme-live' }, { hostname: 'www.acme.com', service: 'acme-live' }],
    secrets: { 'acme-live': ['RESEND_KEY', 'TURNSTILE_SECRET'], [W]: ['TURNSTILE_SECRET'] },
    detachLag: 2,
  });
  const c = await runCheck(w);
  assert.ok(c.ready);
  assert.deepEqual(c.plan.delete_records, [], 'hosts on another Worker have no records to delete');
  assert.deepEqual(c.plan.saved_domains.map((d) => [d.hostname, d.service]), [['acme.com', 'acme-live'], ['www.acme.com', 'acme-live']]);
  assert.ok(c.plan.saved_domains.every((d) => d.id));
  assert.ok(c.byId('hosts').items.includes('acme.com moves from acme-live to staging-acme'));
  assert.equal(c.byId('records').status, 'pass');
  assert.match(c.byId('records').detail, /Nothing to delete/);
  assert.ok(c.byId('records').items.includes('No record to delete on acme.com: it is a Custom Domain on another Worker.'));
  const secrets = c.byId('other-worker');
  assert.equal(secrets.status, 'warn');
  assert.match(secrets.detail, /^acme-live has the secret RESEND_KEY that staging-acme does not\./);
  assert.match(c.byId('wrangler').detail,
    /Also disconnect Workers Builds on acme-live, or remove acme\.com and www\.acme\.com from acme-live's wrangler config, or acme-live's next build takes them back\./);
  assert.equal(c.req.calls(), 14, 'two secret listings as well');

  // Cloudflare's docs do not promise a read_only mark. A host on another
  // Worker gives nothing to delete whatever its records say.
  const unmarked = world({
    records: RECORDS.filter((r) => r.type === 'MX' || r.type === 'TXT'),
    domains: [{ hostname: 'acme.com', service: 'acme-live' }, { hostname: 'www.acme.com', service: 'acme-live' }],
  });
  for (const r of unmarked.fake.state.records) r.meta = {};
  const u = await runCheck(unmarked);
  assert.deepEqual(u.plan.delete_records, []);
  assert.equal(u.byId('records').status, 'pass');

  // The old Worker's records take a moment to go, so each attach clashes
  // twice and goes in on the third try.
  const sleep = sleeper();
  const { record, stepper } = await goLive(w, { sleep: sleep.sleep });
  assert.deepEqual(sleep.waits, [1000, 2000, 1000, 2000]);
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);
  assert.deepEqual(stepper.actions(), ['domain-detached', 'domain-detached', 'domain-attached', 'domain-attached', 'worker-records', 'redirect-added']);
  assert.deepEqual(record.steps_done.slice(0, 2), c.plan.saved_domains.map((d) => 'detached:' + d.id));

  const rollSleep = sleeper();
  const back = await rollBack(w, record, { sleep: rollSleep.sleep });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(domainState(w), ['acme.com on acme-live', 'www.acme.com on acme-live']);
  assert.deepEqual(rollSleep.waits, [1000, 2000, 1000, 2000], 'waited for each Worker record to go before moving the host back');
  assert.deepEqual(back.stepper.actions(), ['redirect-removed', 'domain-detached', 'domain-reattached', 'domain-detached', 'domain-reattached']);
  assert.deepEqual(zoneState(w).filter((s) => s.startsWith('AAAA')), [
    'AAAA acme.com 100:: proxied ttl=1 read-only', 'AAAA www.acme.com 100:: proxied ttl=1 read-only',
  ], 'only the old Worker\'s own records');
});

test('apex only: with the pair unticked only the apex moves, www keeps its record, and no redirect is added', async () => {
  const w = world({ records: [...RECORDS.filter((r) => r.name !== 'www.acme.com'), { type: 'A', name: 'www.acme.com', content: '192.0.2.10', proxied: true }] });
  const c = await runCheck(w, { includePair: false });
  assert.ok(c.ready);
  const hosts = c.byId('hosts');
  assert.equal(hosts.status, 'warn');
  assert.match(hosts.detail, /www\.acme\.com stays where it is today and keeps showing the old site\./);
  assert.deepEqual(c.plan.hosts, [{ hostname: 'acme.com', role: 'main' }]);
  assert.equal(c.plan.pair, 'www.acme.com');
  assert.equal(c.plan.redirect, null);
  assert.equal(c.byId('redirects').detail, 'No redirect rule touches acme.com. Page Rules and Bulk Redirects are not checked.');
  assert.deepEqual(c.plan.delete_records.map((r) => r.name), ['acme.com']);

  const { record, result } = await goLive(w, { includePair: false });
  assert.deepEqual(result.attached.map((a) => a.hostname), ['acme.com']);
  assert.deepEqual(domainState(w), ['acme.com on staging-acme']);
  assert.ok(zoneState(w).includes('A www.acme.com 192.0.2.10 proxied ttl=1'));
  assert.equal(w.fake.redirectRules(ZONE).length, 0);
  const v = await checkNow(w, record);
  assert.equal(v.byId('redirect'), undefined, 'no pair, no redirect check');
  assert.equal(v.done, true);
});

test('www as the live address: the apex is the pair and redirects to www', async () => {
  const w = world({
    pages: { [`https://${STAGING}/`]: { body: stagingHtml({ canonical: 'https://www.acme.com/' }) } },
  });
  const site = { ...SITE, live_domain: 'www.acme.com' };
  const c = await runCheck(w, { site });
  assert.ok(c.ready, JSON.stringify(c.checks.filter((x) => x.status === 'fail')));
  assert.deepEqual(c.plan.hosts, [{ hostname: 'www.acme.com', role: 'main' }, { hostname: 'acme.com', role: 'redirect' }]);
  assert.deepEqual(c.plan.redirect, { from: 'acme.com', to: 'www.acme.com', ref: REF });
  assert.deepEqual(c.plan.delete_records.map((r) => r.name), ['www.acme.com', 'acme.com'], 'main first');
  assert.equal(c.byId('canonical').status, 'pass');
  assert.equal(c.req.calls(), 13, 'findZone asked for www.acme.com, then acme.com');

  const { record } = await goLive(w, { site });
  assert.equal(ourRules(w)[0].expression, '(http.host eq "acme.com")');
  assert.equal(ourRules(w)[0].action_parameters.from_value.target_url.expression, 'concat("https://www.acme.com", http.request.uri.path)');
  const back = await rollBack(w, record);
  assert.ok(back.ok);
  assert.deepEqual(zoneState(w), zoneState(world()));
});

test('a subdomain as the live address has no pair, and public DNS is waited for when its old record was DNS only', async () => {
  const w = world({
    records: [...RECORDS, { type: 'A', name: 'shop.acme.com', content: '192.0.2.20', proxied: false, ttl: 3600 }],
    pages: { [`https://${STAGING}/`]: { body: stagingHtml({ canonical: 'https://shop.acme.com/' }) } },
    dns: { 'shop.acme.com': { A: { data: '192.0.2.20', TTL: 3600 } } },
  });
  const site = { ...SITE, live_domain: 'shop.acme.com' };
  const c = await runCheck(w, { site });
  assert.ok(c.ready);
  assert.deepEqual(c.plan.hosts, [{ hostname: 'shop.acme.com', role: 'main' }]);
  assert.equal(c.plan.pair, null);
  assert.equal(c.plan.redirect, null);
  assert.equal(c.byId('hosts').status, 'pass');
  assert.equal(c.byId('hosts').detail, 'Moves shop.acme.com to staging-acme.');

  const { record } = await goLive(w, { site });
  let v = await checkNow(w, record);
  const dns = v.byId('public-dns');
  assert.equal(dns.status, 'wait');
  assert.equal(dns.detail, 'Public DNS still returns the old address 192.0.2.20 (cached for up to 3600 s).');
  assert.equal(v.done, false);

  assert.deepEqual(uniqueResolvers(w, 'shop.acme.com'), ['cloudflare-dns.com', 'dns.google']);

  // One resolver still holding the old answer is enough to wait.
  w.resolvers.set('shop.acme.com', 'A', ['104.21.8.8', '172.67.1.1'], 'cloudflare-dns.com');
  v = await checkNow(w, record);
  assert.equal(v.byId('public-dns').status, 'wait');
  w.resolvers.set('shop.acme.com', 'A', ['104.21.8.8', '172.67.1.1'], 'dns.google');
  v = await checkNow(w, record);
  assert.equal(v.byId('public-dns').status, 'pass');
  assert.equal(v.byId('public-dns').detail, 'Public DNS no longer returns the old address (dns.google + cloudflare-dns.com).');
  assert.equal(v.done, true);
});

// --- Checks 1–4 ---

test('the pair unticked: a www with its own record stays with a warning; a www that is an alias of the apex fails', async () => {
  const plain = await runCheck(world({ records: [...RECORDS.slice(0, 1), { type: 'A', name: 'www.acme.com', content: '192.0.2.10' }, ...RECORDS.slice(2)] }), { includePair: false });
  assert.equal(plain.byId('hosts').status, 'warn');
  assert.ok(plain.ready);

  const alias = await runCheck(world(), { includePair: false });
  assert.equal(alias.byId('hosts').status, 'fail');
  assert.match(alias.byId('hosts').detail, /^www\.acme\.com is an alias of acme\.com, so it cannot stay on the old site\. Keep 'Also move www\.acme\.com' ticked\./);
  assert.equal(alias.ready, false);

  // A chain counts too: www → web → the apex.
  const chain = await runCheck(world({
    records: [RECORDS[0], { type: 'CNAME', name: 'www.acme.com', content: 'web.acme.com' }, { type: 'CNAME', name: 'web.acme.com', content: 'acme.com' }],
  }), { includePair: false });
  assert.equal(chain.byId('hosts').status, 'fail');
});

test('the zone must be ours, active, not paused, a full setup, and not the desk\'s own', async () => {
  const cases = [
    ['nowhere.org', {}, /nowhere\.org is not a zone on our Cloudflare account, so the desk cannot change its DNS\. Move its DNS to Cloudflare first \(gate 6\)\./],
    ['acme.com', { status: 'pending' }, /acme\.com is pending on Cloudflare, not active/],
    ['acme.com', { paused: true }, /acme\.com is paused on Cloudflare/],
    ['acme.com', { type: 'partial' }, /acme\.com is a partial zone: Cloudflare is not its DNS host/],
    ['client.10xid.com', {}, /client\.10xid\.com is in the desk's own zone \(10xid\.com\)\. The desk does not change DNS in its own zone; do that one by hand\./],
  ];
  for (const [live, zone, detail] of cases) {
    const c = await runCheck(world({ zone }), { site: { ...SITE, live_domain: live } });
    assert.deepEqual(c.checks.map((x) => x.id), ['addresses', 'zone'], live + ' stops at the zone');
    assert.equal(c.byId('zone').status, 'fail');
    assert.match(c.byId('zone').detail, detail);
    assert.equal(c.plan, null);
    assert.equal(c.ready, false);
    assert.equal(c.req.calls(), live === 'client.10xid.com' ? 2 : 1, 'no page fetched, nothing more asked');
  }
});

test('addresses: both set, bare hostnames, different, and neither the desk; staging with a path says why', async () => {
  const cases = [
    [{ staging_domain: 'preview.10xid.com/id/acme' }, 'Staging is a path on a shared preview host, not a Worker of its own. Give the site its own Worker and hostname first (gate 9).'],
    [{ live_domain: null }, 'The live domain is not set.'],
    [{ staging_domain: null }, 'The staging domain is not set.'],
    [{ live_domain: 'acme.com:8443' }, 'The live domain acme.com:8443 is not a bare hostname such as acme.com (no path, no port).'],
    [{ live_domain: 'acme.com/shop' }, 'The live domain acme.com/shop is not a bare hostname such as acme.com (no path, no port).'],
    [{ staging_domain: 'acme.com' }, 'The live and staging domains are the same (acme.com).'],
    [{ staging_domain: DESK }, `The staging domain ${DESK} is the desk's own address.`],
    [{ live_domain: 'x'.repeat(250) + '.com' }, /is not a bare hostname/],
  ];
  for (const [change, detail] of cases) {
    const c = await runCheck(world(), { site: { ...SITE, ...change } });
    assert.equal(c.checks.length, 1);
    assert.equal(c.checks[0].status, 'fail');
    if (typeof detail === 'string') assert.ok(c.checks[0].detail.includes(detail), c.checks[0].detail);
    else assert.match(c.checks[0].detail, detail);
    assert.equal(c.req.calls(), 0);
  }
});

test('the staging Worker must be a Custom Domain, not the desk, not a main address, and not another site\'s live Worker', async () => {
  const cases = [
    [{}, { staging_domain: 'staging-nope.10xid.com' },
      'staging-nope.10xid.com is not a Worker Custom Domain on our account (it may be a Route, a workers.dev address or hosted elsewhere).'],
    [{ domains: [{ hostname: 'desk2.10xid.com', service: DESK_WORKER }] }, { staging_domain: 'desk2.10xid.com' },
      'desk2.10xid.com runs on website-dashboard, the desk itself.'],
    [{ domains: [{ hostname: 'other.com', service: 'staging-other' }] }, { staging_domain: 'other.com' },
      'other.com is the main address of other.com, and a staging address is never a zone\'s main address — is this another site\'s live domain?'],
    [{ domains: [{ hostname: 'www.other.com', service: 'staging-other' }] }, { staging_domain: 'www.other.com' },
      'www.other.com is the main address of other.com'],
    [{ domains: [{ hostname: 'other.com', service: W }] }, {},
      'staging-acme already serves other.com; it looks like another site\'s live Worker.'],
  ];
  for (const [options, change, detail] of cases) {
    const c = await runCheck(world(options), { site: { ...SITE, ...change } });
    const worker = c.byId('worker');
    assert.equal(worker.status, 'fail');
    assert.ok(worker.detail.includes(detail), worker.detail);
    assert.equal(c.checks.at(-1).id, 'worker', 'nothing after it');
    assert.equal(c.plan, null);
  }
});

test('a host already on the staging Worker, or on the desk, fails and stops there', async () => {
  const onW = await runCheck(world({ records: RECORDS.slice(2), domains: [{ hostname: 'www.acme.com', service: W }] }));
  assert.equal(onW.byId('hosts').status, 'fail');
  assert.match(onW.byId('hosts').detail, /^www\.acme\.com already points at staging-acme; it looks live already\./);
  assert.equal(onW.checks.at(-1).id, 'hosts');
  assert.equal(onW.plan, null);

  const onDesk = await runCheck(world({ records: RECORDS.slice(2), domains: [{ hostname: 'acme.com', service: DESK_WORKER }] }));
  assert.match(onDesk.byId('hosts').detail, /acme\.com is on website-dashboard, the desk's own Worker/);
  assert.equal(onDesk.plan, null);
});

test('a host held by another site\'s go-live fails, naming that site; one the plan does not move does not', async () => {
  const busy = [{ site_id: 'other', name: 'Acme Old Site', state: 'checking', hosts: ['www.acme.com'] }];
  const c = await runCheck(world(), { busyHosts: busy });
  assert.equal(c.byId('hosts').status, 'fail');
  assert.match(c.byId('hosts').detail, /^www\.acme\.com has an unfinished or live go-live on Acme Old Site\./);
  assert.ok(c.plan, 'the rest of the plan is still shown');
  assert.equal(c.ready, false);

  const unticked = await runCheck(world({ records: [RECORDS[0], { type: 'A', name: 'www.acme.com', content: '192.0.2.10' }, ...RECORDS.slice(2)] }),
    { includePair: false, busyHosts: busy });
  assert.equal(unticked.byId('hosts').status, 'warn');
});

// --- Checks 5–12 ---

test('a read-only record on a planned host fails: another Cloudflare product manages it', async () => {
  const c = await runCheck(world({ records: [{ type: 'AAAA', name: 'www.acme.com', content: '100::', proxied: true, meta: { read_only: true } }, RECORDS[0], ...RECORDS.slice(2)] }));
  const records = c.byId('records');
  assert.equal(records.status, 'fail');
  assert.equal(records.detail, 'AAAA www.acme.com is managed by another Cloudflare product; the desk will not touch it.');
  assert.deepEqual(c.plan.delete_records.map((r) => r.name), ['acme.com'], 'never planned for deletion');
  assert.equal(c.ready, false);
});

test('a planned host delegated to other nameservers fails: the desk cannot move it', async () => {
  const c = await runCheck(world({
    records: [RECORDS[0], ...RECORDS.slice(2),
      { type: 'NS', name: 'www.acme.com', content: 'ns1.otherdns.net' }, { type: 'NS', name: 'www.acme.com', content: 'ns2.otherdns.net' }],
  }));
  const records = c.byId('records');
  assert.equal(records.status, 'fail');
  assert.equal(records.detail, 'www.acme.com is delegated to other nameservers (NS records), so the desk cannot move it.');
  assert.equal(c.ready, false);
  // NS records on a host the plan does not move are none of its business.
  const other = await runCheck(world({ records: [...RECORDS, { type: 'NS', name: 'eu.acme.com', content: 'ns1.otherdns.net' }] }));
  assert.equal(other.byId('records').status, 'pass');
});

test('mail: an MX on a planned host, or reaching one through a CNAME, fails', async () => {
  const direct = await runCheck(world({ records: [...RECORDS.filter((r) => r.type !== 'MX'), { type: 'MX', name: 'acme.com', content: 'acme.com', priority: 0 }] }));
  assert.equal(direct.byId('mail').status, 'fail');
  assert.match(direct.byId('mail').detail, /^Mail for acme\.com is delivered to acme\.com, which moves onto the Worker\. Moving it would stop the client's email\. Point the MX at the mail server's own name \(with its own DNS-only A record\) first\.$/);

  const viaCname = await runCheck(world({
    records: [...RECORDS.filter((r) => r.type !== 'MX'),
      { type: 'CNAME', name: 'mail.acme.com', content: 'acme.com' },
      { type: 'MX', name: 'acme.com', content: 'mail.acme.com', priority: 10 }],
  }));
  const mail = viaCname.byId('mail');
  assert.equal(mail.status, 'fail');
  assert.match(mail.detail, /^Mail for acme\.com is delivered to mail\.acme\.com, which follows acme\.com onto the Worker\./);
  assert.ok(!mail.detail.includes('These names'), 'mail.acme.com is not warned about twice');
  assert.equal(viaCname.ready, false);

  // An MX somewhere else in the zone counts as well.
  const sub = await runCheck(world({ records: [...RECORDS, { type: 'MX', name: 'news.acme.com', content: 'www.acme.com', priority: 5 }] }));
  assert.match(sub.byId('mail').detail, /Mail for news\.acme\.com is delivered to www\.acme\.com, which moves onto the Worker\./);
});

test('mail: other names pointing at a planned host warn, the pair excepted; SPF with a bare a warns', async () => {
  const c = await runCheck(world({
    records: [
      { type: 'A', name: 'acme.com', content: '203.0.113.5', proxied: false, ttl: 300 },
      RECORDS[1], RECORDS[2],
      { type: 'TXT', name: 'acme.com', content: '"v=spf1 a mx include:_spf.mailhost.net ~all"' },
      { type: 'CNAME', name: 'ftp.acme.com', content: 'acme.com' },
      { type: 'CNAME', name: 'cpanel.acme.com', content: 'acme.com' },
      { type: 'CNAME', name: 'shop.acme.com', content: 'www.acme.com' },
      { type: 'CNAME', name: 'blog.acme.com', content: 'acme.ghost.io' },
    ],
  }));
  const mail = c.byId('mail');
  assert.equal(mail.status, 'warn');
  assert.ok(mail.detail.includes('These names point at acme.com and will follow it to the new site: ftp.acme.com, cpanel.acme.com. If they are used for mail, FTP or cPanel, point them at the server\'s own address first.'), mail.detail);
  assert.ok(mail.detail.includes('shop.acme.com points at www.acme.com and will follow it to the new site.'));
  assert.ok(!mail.detail.includes('blog.acme.com'));
  assert.deepEqual(mail.items, ['ftp.acme.com → acme.com', 'cpanel.acme.com → acme.com', 'shop.acme.com → www.acme.com'], 'the pair itself is not listed');
  assert.ok(mail.detail.includes('SPF allows mail from acme.com\'s own address (a). After the switch that address is Cloudflare\'s, so mail sent from 203.0.113.5 would fail SPF. Add ip4:203.0.113.5 to the SPF record first.'));
  assert.ok(c.ready, 'warnings never block');

  const quiet = await runCheck(world());
  assert.equal(quiet.byId('mail').detail, 'No mail depends on acme.com or www.acme.com.');
});

test('mail: SPF naming a moving host by a:<host>, at the apex or at main, warns as a bare a does', async () => {
  const dnsOnly = (name, content) => ({ type: 'A', name, content, proxied: false, ttl: 300 });
  const spf = (name, content) => ({ type: 'TXT', name, content });
  const warning = (host, ip) => `SPF allows mail from ${host}'s own address (a). After the switch that address is Cloudflare's, `
    + `so mail sent from ${ip} would fail SPF. Add ip4:${ip} to the SPF record first.`;

  const apex = await runCheck(world({
    records: [dnsOnly('acme.com', '203.0.113.5'), RECORDS[1], RECORDS[2], spf('acme.com', 'v=spf1 a:acme.com mx include:_spf.mailhost.net ~all')],
  }));
  assert.equal(apex.byId('mail').status, 'warn');
  assert.equal(apex.byId('mail').detail, warning('acme.com', '203.0.113.5'));

  // www as the live address, named by the apex's SPF.
  const www = await runCheck(world({
    records: [RECORDS[0], dnsOnly('www.acme.com', '203.0.113.5'), RECORDS[2], spf('acme.com', 'v=spf1 +a:www.acme.com/24 ~all')],
    pages: { [`https://${STAGING}/`]: { body: stagingHtml({ canonical: 'https://www.acme.com/' }) } },
  }), { site: { ...SITE, live_domain: 'www.acme.com' } });
  assert.equal(www.byId('mail').detail, warning('www.acme.com', '203.0.113.5'));

  // A subdomain with an SPF of its own. The apex's bare a is the apex's
  // address, which does not move.
  const shop = await runCheck(world({
    records: [...RECORDS.slice(0, 3), spf('acme.com', 'v=spf1 a ~all'), dnsOnly('shop.acme.com', '203.0.113.9'), spf('shop.acme.com', 'v=spf1 a -all')],
    pages: { [`https://${STAGING}/`]: { body: stagingHtml({ canonical: 'https://shop.acme.com/' }) } },
  }), { site: { ...SITE, live_domain: 'shop.acme.com' } });
  assert.equal(shop.byId('mail').detail, warning('shop.acme.com', '203.0.113.9'));
});

test('the MX and TXT snapshot is taken at the apex only', async () => {
  const c = await runCheck(world());
  const snap = c.byId('mx-txt');
  assert.equal(snap.status, 'pass');
  assert.equal(snap.detail, '1 MX record and 1 TXT record. The desk never touches them and checks them again afterwards.');
  assert.deepEqual(snap.items, ['MX 10 mx.mailhost.net', 'TXT v=spf1 include:_spf.mailhost.net ~all']);
});

test('a Worker route covering a planned host fails', async () => {
  const c = await runCheck(world({ routes: [{ pattern: '*acme.com/*', script: 'old-proxy' }, { pattern: 'blog.acme.com/*', script: 'blog' }] }));
  const routes = c.byId('routes');
  assert.equal(routes.status, 'fail');
  assert.equal(routes.detail, 'Worker route *acme.com/* (Worker old-proxy) runs in front of a Custom Domain, so acme.com would keep showing that Worker. Remove the route first.');
  assert.deepEqual(routes.items, ['*acme.com/*']);
  const fine = await runCheck(world({ routes: [{ pattern: 'blog.acme.com/*', script: 'blog' }] }));
  assert.equal(fine.byId('routes').detail, 'No Worker route covers acme.com or www.acme.com.');
});

test('redirect rules: one naming main fails, one naming the pair warns, and a zone at its plan\'s limit fails', async () => {
  const rule = (ref, expression, extra = {}) => ({
    ref, description: 'Rule ' + ref, expression, action: 'redirect',
    action_parameters: { from_value: { status_code: 301, target_url: { value: 'https://elsewhere.example/' } } }, ...extra,
  });
  const naming = await runCheck(world({ rulesets: [{ zone_id: ZONE, rules: [rule('old', '(http.host eq "acme.com" and http.request.uri.path eq "/shop")', { description: 'Old shop redirect' })] }] }));
  assert.equal(naming.byId('redirects').status, 'fail');
  assert.equal(naming.byId('redirects').detail, 'Redirect rule \'Old shop redirect\' already sends acme.com somewhere. The new site would never be seen. Remove it first.');

  const off = await runCheck(world({ rulesets: [{ zone_id: ZONE, rules: [rule('old', '(http.host eq "acme.com")', { enabled: false })] }] }));
  assert.equal(off.byId('redirects').status, 'pass', 'a disabled rule sends nothing anywhere');

  const pair = await runCheck(world({ rulesets: [{ zone_id: ZONE, rules: [rule('www', '(http.host eq "www.acme.com")')] }] }));
  assert.equal(pair.byId('redirects').status, 'warn');
  assert.match(pair.byId('redirects').detail, /^Redirect rule 'Rule www' also matches www\.acme\.com and may answer before the desk's rule\./);

  const tenRules = Array.from({ length: 10 }, (_, i) => rule('r' + i, `(http.host eq "old${i}.acme.com")`));
  const full = await runCheck(world({ rulesets: [{ zone_id: ZONE, rules: tenRules }] }));
  assert.equal(full.byId('redirects').status, 'fail');
  assert.equal(full.byId('redirects').detail, 'The zone already has 10 redirect rules, the most its plan allows.');
  const pro = await runCheck(world({ zone: { plan: 'pro' }, rulesets: [{ zone_id: ZONE, rules: tenRules }] }));
  assert.equal(pro.byId('redirects').status, 'pass', 'a Pro zone may have 25');
  const noPair = await runCheck(world({ records: [RECORDS[0], { type: 'A', name: 'www.acme.com', content: '192.0.2.10' }, ...RECORDS.slice(2)], rulesets: [{ zone_id: ZONE, rules: tenRules }] }), { includePair: false });
  assert.equal(noPair.byId('redirects').status, 'pass', 'no rule to add, no limit to reach');
  // Our own leftover rule is removed before the new one goes in.
  const leftover = await runCheck(world({ rulesets: [{ zone_id: ZONE, rules: [...tenRules.slice(1), rule(REF, '(http.host eq "www.acme.com")')] }] }));
  assert.equal(leftover.byId('redirects').status, 'pass');
});

test('redirect rules: a wildcard or full-URI rule that takes main fails like a named one; one the desk cannot read warns', async () => {
  const rule = (ref, expression, target = { value: 'https://elsewhere.example/' }) => ({
    ref, description: 'Rule ' + ref, expression, action: 'redirect',
    action_parameters: { from_value: { status_code: 301, target_url: target } },
  });
  const redirects = async (r, live = 'acme.com') => (await runCheck(world({ rulesets: [{ zone_id: ZONE, rules: [r] }] }),
    { site: { ...SITE, live_domain: live } })).byId('redirects');
  // The dashboard's own "Redirect from WWW to root" template.
  const template = rule('tmpl', '(http.request.full_uri wildcard r"https://www.*")',
    { expression: 'wildcard_replace(http.request.full_uri, r"https://www.*", r"https://${1}")' });
  const fails = [
    [template, 'www.acme.com'],
    [rule('a', '(http.request.full_uri wildcard r"https://acme.com/*")')],
    [rule('b', '(starts_with(http.request.full_uri, "https://acme.com/"))')],
    [rule('c', '(http.request.full_uri eq "https://acme.com/")')],
    [rule('d', '(http.host in {"shop.acme.com" "ACME.com"})')],
    [rule('e', '(http.host strict wildcard "*")')],
  ];
  for (const [r, live = 'acme.com'] of fails) {
    const c = await redirects(r, live);
    assert.equal(c.status, 'fail', r.expression);
    assert.equal(c.detail, `Redirect rule '${r.description}' already sends ${live} somewhere. The new site would never be seen. Remove it first.`);
  }

  // With the apex live, the template takes the pair: a warning, as a rule naming www is.
  const pair = await redirects(template);
  assert.equal(pair.status, 'warn');
  assert.match(pair.detail, /^Redirect rule 'Rule tmpl' also matches www\.acme\.com and may answer before the desk's rule\./);

  // Another host, named or by pattern, is not main.
  for (const expression of ['(http.host eq "shop.acme.com")', '(http.request.full_uri wildcard r"https://blog.acme.com/*")', '(http.host eq "acme.com.au")']) {
    assert.equal((await redirects(rule('f', expression))).status, 'pass', expression);
  }

  // A path or a part of the address, with no host the desk can read: it may take main.
  for (const expression of ['(starts_with(http.request.uri.path, "/old-shop"))', '(http.request.uri.query contains "ref=")', '(http.request.full_uri wildcard r"*/old/*")']) {
    const c = await redirects(rule('path', expression));
    assert.equal(c.status, 'warn', expression);
    assert.equal(c.detail, 'The desk cannot tell whether redirect rule \'Rule path\' applies to acme.com; check it by hand. '
      + 'Will add a 301 from www.acme.com to acme.com. Page Rules and Bulk Redirects are not checked.');
  }
});

test('redirect rules the token may not read fail, saying a permission may be missing', async () => {
  const w = world();
  w.fake.failOn('GET', /\/entrypoint$/, { status: 403, codes: [10000], message: 'Authentication error' });
  const c = await runCheck(w);
  assert.equal(c.byId('redirects').status, 'fail');
  assert.equal(c.byId('redirects').detail, 'Cloudflare said: Authentication error (code 10000). The API token may be missing a permission; see the README.');
});

test('SSL: Full passes, anything else warns, and an error only warns', async () => {
  assert.equal((await runCheck(world())).byId('ssl').status, 'pass');
  const flexible = (await runCheck(world({ sslMode: 'flexible' }))).byId('ssl');
  assert.equal(flexible.status, 'warn');
  assert.equal(flexible.detail, 'SSL/TLS mode is Flexible. Gate 13 keeps it Full for img.acme.com; the desk does not change it.');
  assert.match((await runCheck(world({ sslMode: 'strict' }))).byId('ssl').detail, /^SSL\/TLS mode is Full \(strict\)\./);
  const w = world();
  w.fake.failOn('GET', `/zones/${ZONE}/settings/ssl`, { status: 403, codes: [9109], message: 'Unauthorized to access requested resource' });
  const c = await runCheck(w);
  assert.equal(c.byId('ssl').status, 'warn');
  assert.ok(c.ready);
});

test('the wrangler and staging warnings are always there', async () => {
  const c = await runCheck(world());
  assert.equal(c.byId('wrangler').status, 'warn');
  assert.equal(c.byId('wrangler').detail,
    'A Workers Builds deploy replaces staging-acme\'s Custom Domains with the list in the repo\'s wrangler config. '
    + 'If tbox/acme-site\'s wrangler.jsonc has a routes key, add acme.com and www.acme.com to it with custom_domain: true and push that BEFORE anything else is deployed. '
    + 'After a Roll back, take them out again.');
  assert.equal(c.byId('staging-stays').detail,
    'staging-acme.10xid.com stays on staging-acme and, without noindex, is a second copy of the live site. Detach it, or keep it deliberately (gate 10).');
  const noRepo = await runCheck(world(), { site: { ...SITE, github_repo: null } });
  assert.match(noRepo.byId('wrangler').detail, /If the repo's wrangler\.jsonc has a routes key/);
});

test('a Cloudflare error inside a check fails it with Cloudflare\'s own words', async () => {
  const w = world();
  w.fake.failOn('GET', `/zones/${ZONE}/dns_records`, { status: 500, codes: [1000], message: 'Internal error' });
  const c = await runCheck(w);
  assert.equal(c.byId('records').detail, 'Cloudflare said: Internal error (code 1000).');
  assert.equal(c.byId('mail').status, 'fail');
  assert.equal(c.byId('mx-txt').status, 'fail');
  assert.equal(c.ready, false);

  const w2 = world();
  w2.fake.failOn('GET', `/accounts/${ACCOUNT}/workers/domains`, { status: 403, codes: [10000], message: 'Authentication error' });
  const c2 = await runCheck(w2);
  assert.match(c2.byId('worker').detail, /The API token may be missing a permission; see the README\.$/);
});

test('the budget rule: a plan whose switch and restore cannot both fit in one request fails', async () => {
  const apexAs = (n) => Array.from({ length: n }, (_, i) => ({ type: 'A', name: 'acme.com', content: '192.0.2.' + (10 + i), proxied: true }));
  const fits = await runCheck(world({ records: [...apexAs(4), ...RECORDS.slice(1)] }));
  assert.equal(fits.byId('records').status, 'pass');
  assert.equal(CERT_CALLS + 8 + switchCost(fits.plan) + restoreCost(fits.plan), LIMIT);

  const tooMany = await runCheck(world({ records: [...apexAs(5), ...RECORDS.slice(1)] }));
  const records = tooMany.byId('records');
  assert.equal(records.status, 'fail');
  assert.equal(records.detail, 'This switch needs more Cloudflare calls than one request allows (too many records). Ask a developer to do it by hand.');
  assert.equal(records.items.length, 6, 'the records are still listed');
  assert.equal(tooMany.ready, false);

  // The largest plan that passes still switches and restores in one
  // request: a switch that fails at its last attach, then the restore.
  const w = world({ records: [...apexAs(4), ...RECORDS.slice(1)] });
  const req = request(w);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  const stepper = steps({
    onStep: (e) => { if (e.log?.[0]?.action === 'domain-attached') w.fake.failOn('PUT', `/accounts/${ACCOUNT}/workers/domains`, { status: 500, message: 'Internal error' }); },
  });
  const row = rowOf(plan);
  const err = await switchOn({ record: row, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError);
  const back = await restore({ record: { ...row, attached: err.attached }, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget });
  assert.equal(back.ok, true, back.errors.join(' '));
  withinBudget(req);
});

test('the budget rule counts the plan\'s own calls and only what comes before every host is attached: rppainting.ca fits', async () => {
  // A real client refused by the old count: the apex on two A and two AAAA
  // records, www an alias of it, the pair moved too.
  const records = [
    { type: 'A', name: 'acme.com', content: '192.0.2.10', proxied: true },
    { type: 'A', name: 'acme.com', content: '192.0.2.11', proxied: true },
    { type: 'AAAA', name: 'acme.com', content: '2001:db8::10', proxied: true },
    { type: 'AAAA', name: 'acme.com', content: '2001:db8::11', proxied: true },
    ...RECORDS.slice(1),
  ];
  const c = await runCheck(world({ records }));
  assert.equal(c.byId('records').status, 'pass', c.byId('records').detail);
  assert.ok(c.ready, JSON.stringify(c.checks.filter((x) => x.status === 'fail')));

  const w = world({ records });
  const req = request(w);
  const built = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  assert.equal(built.calls, 8, 'one zone lookup, two Custom Domain listings and five reads');
  assert.equal(built.calls, req.calls());
  assert.equal(switchCost(built.plan), 5 + 2 * 3, 'the deletes and three tries per attach');
  assert.equal(restoreCost(built.plan), 25);
  assert.equal(CERT_CALLS + built.calls + switchCost(built.plan) + restoreCost(built.plan), LIMIT);

  // findZone asks once per label it walks: www.acme.com, then acme.com.
  const www = request(world());
  const wwwPlan = await buildPlan({ site: { ...SITE, live_domain: 'www.acme.com' }, cf: www.cf, deskHost: DESK });
  assert.equal(wwwPlan.calls, 9);
  assert.equal(wwwPlan.calls, www.calls());

  // It switches, and a switch that fails at its last attach is put back, in
  // one request.
  const stepper = steps({
    onStep: (e) => { if (e.log?.[0]?.action === 'domain-attached') w.fake.failOn('PUT', `/accounts/${ACCOUNT}/workers/domains`, { status: 500, message: 'Internal error' }); },
  });
  const row = rowOf(built.plan);
  const err = await switchOn({ record: row, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError, String(err));
  const back = await restore({ record: { ...row, attached: err.attached }, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(zoneState(w), zoneState(world({ records })));
  withinBudget(req);
});

test('costs follow the spec\'s formulas, for a plan or a stored row alike', () => {
  const plan = {
    hosts: [{ hostname: 'a' }, { hostname: 'b' }], delete_records: [{}, {}, {}], saved_domains: [{}], redirect: { from: 'b', to: 'a' },
  };
  // Before every host is attached: the deletes, the detaches, three tries per attach.
  assert.equal(switchCost(plan), 3 + 1 + 6);
  // Three to start and finish, five per host, two per record, three per
  // Custom Domain, one for the redirect and one listing of the zone.
  assert.equal(restoreCost(plan), 3 + 10 + 6 + 3 + 1 + 1);
  const row = { hosts: plan.hosts, saved_records: plan.delete_records, saved_domains: plan.saved_domains, redirect: null };
  assert.equal(switchCost(row), 3 + 1 + 6);
  assert.equal(restoreCost(row), 23);
});

test('with only its reserve left, the automatic restore still finishes while the Worker records take their time to go', async () => {
  // The www attach lands at Cloudflare, but its answer is lost.
  const w = world({
    wrap: (fetchImpl) => async (input, init = {}) => {
      const res = await fetchImpl(input, init);
      if (init.method === 'PUT' && JSON.parse(init.body).hostname === 'www.acme.com') {
        return Response.json({ success: false, errors: [{ code: 10013, message: 'Gateway timeout' }], messages: [], result: null }, { status: 504 });
      }
      return res;
    },
  });
  const before = zoneState(w);
  const { plan } = await buildPlan({ site: SITE, cf: request(w).cf, deskHost: DESK });
  const row = rowOf(plan);
  const reserve = restoreCost(row);
  w.fake.state.detachLag = 3;
  // Two deletes and two attaches, then exactly the reserve.
  const req = request(w, { used: LIMIT - reserve - 4 });
  const stepper = steps();
  const err = await switchOn({ record: row, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError, String(err));
  assert.equal(req.budget.remaining(), reserve);
  const sleep = sleeper();
  const back = await restore({ record: { ...row, attached: err.attached }, cf: req.cf, sleep: sleep.sleep, step: stepper.step, budget: req.budget });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(sleep.waits, [1000, 2000, 4000, 1000, 2000, 4000], 'four looks for each host');
  assert.deepEqual(zoneState(w), before);
  assert.deepEqual(domainState(w), []);
  withinBudget(req);
});

// --- The page checks (13–17) ---

test('staging must answer with a page; behind Access it says so, and the page checks are skipped', async () => {
  const w = world({ pages: { [`https://${STAGING}/`]: { status: 302, headers: { location: 'https://tbox.cloudflareaccess.com/cdn-cgi/access/login/staging' } } } });
  const c = await runCheck(w);
  assert.equal(c.byId('staging').status, 'fail');
  assert.equal(c.byId('staging').detail,
    'Staging did not answer with a page (HTTP 302 to https://tbox.cloudflareaccess.com/cdn-cgi/access/login/staging). If it is behind Cloudflare Access or a login, the desk cannot check it.');
  assert.equal(c.byId('noindex'), undefined);
  assert.equal(c.byId('canonical'), undefined);
  assert.equal(c.byId('old-files'), undefined);
  assert.equal(w.sites.calls.find((x) => x.url === `https://${STAGING}/`).redirect, 'manual');

  const down = await runCheck(world({ pages: { [`https://${STAGING}/`]: () => { throw new TypeError('fetch failed', { cause: new Error('certificate has expired') }); } } }));
  assert.match(down.byId('staging').detail, /\(no answer: certificate has expired\)/);
});

test('noindex on staging, by header or by meta tag, fails', async () => {
  const header = await runCheck(world({ pages: { [`https://${STAGING}/`]: { headers: { 'x-robots-tag': 'noindex, nofollow' }, body: stagingHtml() } } }));
  const n = header.byId('noindex');
  assert.equal(n.status, 'fail');
  assert.equal(n.detail, 'Staging still tells search engines not to index it, and the live site would inherit that. Delete the X-Robots-Tag block in public/_headers in tbox/acme-site, push, wait for the build, then check again.');
  assert.deepEqual(n.items, ['X-Robots-Tag: noindex, nofollow']);

  const meta = await runCheck(world({ pages: { [`https://${STAGING}/`]: { body: stagingHtml({ head: '<meta content="noindex,follow" name="Robots">' }) } } }), { site: { ...SITE, github_repo: null } });
  assert.equal(meta.byId('noindex').status, 'fail');
  assert.match(meta.byId('noindex').detail, /in public\/_headers, push/);
});

test('canonical: missing warns, another host fails', async () => {
  const missing = await runCheck(world({ pages: { [`https://${STAGING}/`]: { body: stagingHtml().replace(/<link rel="canonical"[^>]*>/, '') } } }));
  assert.equal(missing.byId('canonical').status, 'warn');
  const elsewhere = await runCheck(world({ pages: { [`https://${STAGING}/`]: { body: stagingHtml({ canonical: '/' }) } } }));
  assert.equal(elsewhere.byId('canonical').status, 'fail');
  assert.equal(elsewhere.byId('canonical').detail,
    `Staging's pages name ${STAGING} as their canonical address. Set site: 'https://acme.com' in the Astro config first, or search engines will index ${STAGING} instead of acme.com.`);
});

test('files from the old site: a wp-content path or the live host fails; img.<zone> and the build\'s own files do not', async () => {
  const body = '<img src="https://acme.com/wp-content/uploads/2020/team.jpg">'
    + '<div style="background:url(\'https://www.acme.com/hero.png\')"></div>'
    + '<script>const old = "https://acme.com/wp-includes/js/jquery.js";</script>';
  const c = await runCheck(world({ pages: { [`https://${STAGING}/`]: { body: stagingHtml({ body }) } } }));
  const old = c.byId('old-files');
  assert.equal(old.status, 'fail');
  assert.deepEqual(old.items, ['https://acme.com/wp-content/uploads/2020/team.jpg', 'https://www.acme.com/hero.png']);
  assert.match(old.detail, /^Staging's home page loads 2 files from the old site/);
  assert.equal((await runCheck(world())).byId('old-files').detail, 'Checked the home page; gate 19 checks every page.');
});

test('robots.txt: Disallow: / for every crawler fails, read past Cloudflare\'s managed preamble; a 404 passes', async () => {
  const txt = (body) => ({ [`https://${STAGING}/robots.txt`]: { headers: { 'content-type': 'text/plain' }, body } });
  const blocked = await runCheck(world({ pages: txt(MANAGED_ROBOTS + '\nUser-agent: *\nDisallow: /\n') }));
  assert.equal(blocked.byId('robots').status, 'fail');
  assert.equal(blocked.byId('robots').detail, 'Staging\'s robots.txt blocks every crawler (Disallow: /). The live site would inherit it.');
  assert.equal((await runCheck(world({ pages: txt(MANAGED_ROBOTS) }))).byId('robots').status, 'pass', 'the preamble blocks named bots, not every crawler');
  const none = await runCheck(world({ pages: { [`https://${STAGING}/robots.txt`]: { status: 404 } } }));
  assert.equal(none.byId('robots').status, 'pass');
  const odd = await runCheck(world({ pages: { [`https://${STAGING}/robots.txt`]: { status: 500 } } }));
  assert.equal(odd.byId('robots').status, 'warn');
});

test('nameservers: both resolvers must give the zone\'s assigned ones; one resolver silent only warns', async () => {
  const w = world();
  w.resolvers.set('acme.com', 'NS', ['ns1.oldhost.net', 'ns2.oldhost.net'], 'cloudflare-dns.com');
  const c = await runCheck(w);
  const ns = c.byId('nameservers');
  assert.equal(ns.status, 'fail');
  assert.equal(ns.detail, 'Public DNS says acme.com\'s nameservers are ns1.oldhost.net, ns2.oldhost.net, not the ones Cloudflare assigned (ada.ns.cloudflare.com, bob.ns.cloudflare.com). The desk would change records nobody reads.');
  assert.deepEqual(ns.items, ['dns.google: ada.ns.cloudflare.com, bob.ns.cloudflare.com', 'cloudflare-dns.com: ns1.oldhost.net, ns2.oldhost.net']);

  const quiet = world();
  quiet.resolvers.answers['dns.google'] = () => { throw new Error('timed out'); };
  assert.equal((await runCheck(quiet)).byId('nameservers').status, 'warn');
  const servfail = world();
  servfail.resolvers.answers['cloudflare-dns.com'] = () => ({ Status: 2 });
  assert.equal((await runCheck(servfail)).byId('nameservers').status, 'warn');
  const pass = await runCheck(world());
  assert.equal(pass.byId('nameservers').status, 'pass');
  assert.equal(pass.byId('nameservers').detail,
    'dns.google and cloudflare-dns.com both give acme.com the nameservers Cloudflare assigned (ada.ns.cloudflare.com, bob.ns.cloudflare.com).');
});

test('Friday in Toronto warns and adds an ack; the Worker\'s UTC clock does not decide it', async () => {
  const friday = await runCheck(world(), { now: FRIDAY });
  assert.equal(friday.byId('friday').status, 'warn');
  assert.equal(friday.byId('friday').detail, 'It is Friday. Gate 13 says not on a Friday.');
  assert.ok(friday.ready, 'a warning, not a block');
  assert.deepEqual(friday.acks.map((a) => a.id), ['gate12', 'wrangler', 'friday']);
  assert.equal(friday.acks[2].label, 'It is Friday and this cannot wait');

  assert.equal((await runCheck(world(), { now: THURSDAY })).byId('friday'), undefined);
  assert.equal(isFriday(Date.parse('2026-09-26T02:00:00Z')), true, 'Saturday in UTC, Friday evening in Toronto');
  assert.equal(isFriday(Date.parse('2026-09-25T03:00:00Z')), false, 'Friday in UTC, Thursday night in Toronto');
});

test('the acks always include gate 12 and the wrangler config', async () => {
  const c = await runCheck(world());
  assert.deepEqual(c.acks, [
    { id: 'gate12', label: 'Gate 12 is approved in sites/acme.com.md' },
    { id: 'wrangler', label: 'I have checked tbox/acme-site’s wrangler config (routes and custom domains)' },
  ]);
  const www = requiredAcks({ plan: { zone: { name: 'acme.com' } }, site: { ...SITE, live_domain: 'www.acme.com', github_repo: null }, now: THURSDAY });
  assert.equal(www[0].label, 'Gate 12 is approved in sites/acme.com.md', 'the zone names the record file');
  assert.equal(www[1].label, 'I have checked the repo’s wrangler config (routes and custom domains)');
  const early = await runCheck(world(), { site: { ...SITE, staging_domain: null } });
  assert.deepEqual(early.acks.map((a) => a.id), ['gate12', 'wrangler'], 'even when the check stopped early');
});

// --- The plan hash ---

test('the plan hash is SHA-256 of what the switch acts on: stable, and it changes when that does', async () => {
  const w = world();
  const a = await runCheck(w);
  const b = await runCheck(w);
  const hash = await planHash(a.plan);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await planHash(b.plan), hash);
  const p = a.plan;
  const expected = createHash('sha256').update(JSON.stringify([
    p.zone.id, p.worker, p.hosts.map((h) => [h.hostname, h.role]),
    p.delete_records.map((r) => [r.id, r.type, r.name, r.content, !!r.proxied, r.ttl]),
    p.saved_domains.map((d) => [d.id, d.hostname, d.service]), [p.redirect.from, p.redirect.to],
  ])).digest('hex');
  assert.equal(hash, expected);

  w.fake.state.sslMode = 'flexible';
  w.resolvers.set('acme.com', 'MX', ['10 mx.other.net']);
  assert.equal(await planHash((await runCheck(w)).plan), hash, 'the SSL mode and public DNS are not part of it');
  assert.notEqual(await planHash((await runCheck(w, { includePair: false })).plan), hash);

  const [apex] = await w.admin.listDnsRecords(ZONE, 'acme.com').then((rs) => rs.filter((r) => r.type === 'A'));
  await w.admin.deleteDnsRecord(ZONE, apex.id);
  await w.admin.createDnsRecord(ZONE, { ...apex, content: '192.0.2.99' });
  assert.notEqual(await planHash((await runCheck(w)).plan), hash, 'a changed record is a changed plan');
  assert.match(await planHash(null), /^[0-9a-f]{64}$/, 'no plan still hashes');
});

test('the checks digest is SHA-256 of each plan check\'s id, status and items, so a start sees a new warning', async () => {
  const w = world();
  const checked = await runCheck(w);
  const built = await buildPlan({ site: SITE, cf: request(w).cf, deskHost: DESK });
  const digest = await checksDigest(built.checks);
  assert.equal(digest, createHash('sha256').update(JSON.stringify(built.checks.map((c) => [c.id, c.status, c.items || []]))).digest('hex'));
  assert.deepEqual(checked.planChecks, built.checks, 'the check hands back the plan\'s own checks, without the page checks');
  assert.equal(await checksDigest(checked.planChecks), digest);

  // A name that would follow the apex to the Worker appears after the check.
  const hash = await planHash(built.plan);
  await w.admin.createDnsRecord(ZONE, { type: 'CNAME', name: 'cpanel.acme.com', content: 'acme.com', proxied: false, ttl: 1 });
  const again = await buildPlan({ site: SITE, cf: request(w).cf, deskHost: DESK });
  assert.equal(await planHash(again.plan), hash, 'the plan itself is the same');
  assert.ok(isReady(again.checks));
  assert.equal(again.checks.find((c) => c.id === 'mail').status, 'warn');
  assert.notEqual(await checksDigest(again.checks), digest, 'but what the person read is not');
});

// --- The switch ---

test('the switch guard: a record or domain the plan could not have made stops it before anything is touched', async () => {
  const w = world();
  const { plan } = await runCheck(w);
  const base = rowOf(plan);
  const [a] = base.saved_records;
  const bad = [
    { saved_records: [...base.saved_records, { id: 'd1', type: 'MX', name: 'acme.com', content: 'mx.mailhost.net' }] },
    { saved_records: [{ ...a, id: 'd2', name: 'mail.acme.com' }] },
    { saved_records: [{ ...a, meta: { read_only: true } }] },
    { saved_records: [{ ...a, id: undefined }] },
    { saved_domains: [{ id: 'c1', hostname: 'acme.com', service: 'acme-live' }] },
    { saved_records: [], saved_domains: [{ id: 'c1', hostname: 'acme.com', service: W }] },
    { saved_records: [], saved_domains: [{ id: 'c1', hostname: 'shop.acme.com', service: 'acme-live' }] },
    { hosts: [] },
    // The redirect's hosts go into the rule's expression, and its ref is how
    // a Roll back finds the rule: both must be this plan's.
    { redirect: { ...base.redirect, from: 'shop.acme.com' } },
    { redirect: { ...base.redirect, to: 'acme.com" or true or "x' } },
    { redirect: { ...base.redirect, from: 'acme.com' } },
    { redirect: { ...base.redirect, ref: 'desk-00000000-0000-4000-8000-000000000000' } },
  ];
  for (const change of bad) {
    const req = request(w);
    const stepper = steps();
    const err = await switchOn({ record: { ...base, ...change }, cf: req.cf, step: stepper.step, budget: req.budget }).catch((e) => e);
    assert.ok(err instanceof SwitchError, JSON.stringify(change));
    assert.match(err.message, /^The desk did not start: .* Nothing was changed\.$/);
    assert.equal(req.calls(), 0);
    assert.equal(stepper.entries.length, 0);
  }
});

test('a failure before every host is attached throws SwitchError, and the restore puts back exactly what was there', async () => {
  const w = world();
  const before = zoneState(w);
  const req = request(w);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  const row = rowOf(plan);
  // Cloudflare starts failing attaches once the first host is on.
  const stepper = steps({
    onStep: (e) => {
      if (e.log?.[0]?.action === 'domain-attached') w.fake.failOn('PUT', `/accounts/${ACCOUNT}/workers/domains`, { status: 500, codes: [10013], message: 'Internal error' });
    },
  });
  const err = await switchOn({ record: row, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError);
  assert.equal(err.message, 'Could not attach www.acme.com to staging-acme. Cloudflare said: Internal error (code 10013).');
  assert.equal(err.stale, false);
  assert.deepEqual(err.attached.map((a) => a.hostname), ['acme.com']);
  assert.deepEqual(stepper.actions(), ['record-deleted', 'record-deleted', 'domain-attached']);
  assert.equal(ourRules(w).length, 0, 'no redirect before every host is on');

  // The automatic restore, in the same request, from the row as stored.
  const back = await restore({ record: { ...row, ...stepper.row }, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(zoneState(w), before);
  assert.deepEqual(domainState(w), []);
  withinBudget(req);
});

test('a step that cannot be written before every host is attached stops the switch, and the restore puts it all back', async () => {
  // The Durable Object fails at the second delete, then at the first attach.
  for (const throwOn of [(e, n) => n === 1, (e) => e.log?.[0]?.action === 'domain-attached']) {
    const w = world();
    const before = zoneState(w);
    const req = request(w);
    const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
    const stepper = steps({ throwOn });
    const err = await switchOn({ record: plan, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget }).catch((e) => e);
    assert.ok(err instanceof SwitchError, String(err));
    assert.equal(err.message, 'Could not record a step, so the desk stopped and is putting everything back: Durable Object reset because its code was updated.');
    assert.equal(err.stale, false);
    assert.equal(ourRules(w).length, 0);
    // What the route restores from after a SwitchError: the plan and what was attached.
    const back = await restore({ record: { ...plan, attached: err.attached }, cf: req.cf, sleep: sleeper().sleep, step: steps().step, budget: req.budget });
    assert.equal(back.ok, true, back.errors.join(' '));
    assert.deepEqual(zoneState(w), before);
    assert.deepEqual(domainState(w), []);
    withinBudget(req);
  }
});

test('a step that cannot be written once every host is attached does not stop the switch, and Check now finds the redirect by its ref', async () => {
  const w = world();
  const req = request(w);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  const row = rowOf(plan);
  // The Durable Object fails from the last attach's step on.
  const stepper = steps({ throwOn: (e, n) => n >= 3 });
  const result = await switchOn({ record: row, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget });
  assert.deepEqual(result.attached.map((a) => a.hostname), ['acme.com', 'www.acme.com']);
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);
  assert.equal(ourRules(w).length, 1, 'the redirect went in');
  assert.deepEqual(stepper.actions(), ['record-deleted', 'record-deleted', 'domain-attached']);
  withinBudget(req);

  // The row never heard of the rule. Check now looks it up and hands it back.
  const record = { ...row, ...stepper.row, switched_at: new Date(THURSDAY).toISOString(), error: null };
  assert.equal(record.redirect_rule, null);
  const v = await checkNow(w, record);
  assert.equal(v.byId('redirect').status, 'pass', v.byId('redirect').detail);
  assert.deepEqual(v.redirectRule, result.redirectRule);
  assert.equal(v.done, true);
});

test('the redirect failing is not fatal once every host is attached', async () => {
  const w = world();
  w.fake.failOn('POST', /\/rulesets$/, { status: 403, codes: [10000], message: 'Authentication error' });
  const { record, result, stepper } = await goLive(w);
  assert.deepEqual(result.attached.map((a) => a.hostname), ['acme.com', 'www.acme.com']);
  assert.equal(result.redirectRule, null);
  assert.equal(result.redirectError.message, 'Authentication error (code 10000)');
  assert.equal(stepper.actions().at(-1), 'redirect-failed');
  assert.equal(stepper.texts().at(-1),
    'Could not add the redirect from www.acme.com to acme.com. Cloudflare said: Authentication error (code 10000). The API token may be missing a permission; see the README. The site works on both addresses, but www.acme.com does not redirect yet.');
  assert.ok(!record.steps_done.includes('redirect'));
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);

  const v = await checkNow(w, record);
  assert.equal(v.byId('redirect').status, 'fail');
  assert.equal(v.byId('redirect').detail,
    'The redirect rule was not added: Authentication error (code 10000). www.acme.com shows the site without redirecting.');
  assert.equal(v.done, false);
});

test('a leftover rule from an earlier run is removed before the redirect is added', async () => {
  const w = world({
    rulesets: [{ zone_id: ZONE, rules: [{ ...redirectRuleFor({ from: 'www.acme.com', to: 'acme.com', ref: REF }), id: 'b0000000000000000000000000000077' }] }],
  });
  const { stepper } = await goLive(w);
  assert.deepEqual(stepper.actions().slice(-2), ['redirect-removed', 'redirect-added']);
  assert.equal(ourRules(w).length, 1);
  assert.notEqual(ourRules(w)[0].id, 'b0000000000000000000000000000077');
});

test('records already gone and domains already detached count as done', async () => {
  const w = world();
  const req = request(w);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  await w.admin.deleteDnsRecord(ZONE, plan.delete_records[1].id);
  const stepper = steps();
  await switchOn({ record: rowOf(plan), cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget });
  assert.equal(stepper.texts()[1], 'CNAME www.acme.com → acme.com (proxied, TTL auto) was already gone.');
  assert.equal(stepper.entries[1].log[0].detail.already_gone, true);
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme']);
});

test('a stale answer from a step stops the run at once', async () => {
  const w = world();
  const req = request(w);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  const row = rowOf(plan);
  const stepper = steps({ staleFrom: 0 });
  const err = await switchOn({ record: row, cf: req.cf, step: stepper.step, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError);
  assert.equal(err.stale, true);
  assert.equal(err.message, 'Another run took over this go-live, so this one stopped.');
  assert.deepEqual(callLabels(w, 0).filter((l) => l === 'delete record' || l.startsWith('attach')), ['delete record'], 'the first delete only');
  assert.ok(zoneState(w).includes('CNAME www.acme.com acme.com proxied ttl=1'));

  // A restore from a run that has lost the row touches nothing either.
  const before = w.fake.calls.length;
  const back = await restore({ record: row, cf: req.cf, step: stepper.step, budget: req.budget });
  assert.equal(back.ok, false);
  assert.equal(back.stale, true);
  assert.deepEqual(back.errors, ['Another run took over this go-live, so this restore stopped.']);
  assert.equal(w.fake.calls.length, before);

  // Stale after the attaches: nothing more happens, not even the redirect.
  const w2 = world();
  const stepper2 = steps({ staleFrom: 3 });
  const req2 = request(w2);
  const { plan: plan2 } = await buildPlan({ site: SITE, cf: req2.cf, deskHost: DESK });
  const err2 = await switchOn({ record: rowOf(plan2), cf: req2.cf, step: stepper2.step, budget: req2.budget }).catch((e) => e);
  assert.equal(err2.stale, true);
  assert.deepEqual(err2.attached.map((a) => a.hostname), ['acme.com', 'www.acme.com']);
  assert.equal(ourRules(w2).length, 0);
});

test('the switch stops before a step that would eat into the calls a restore needs', async () => {
  const w = world();
  const { plan } = await runCheck(w);
  const row = rowOf(plan);
  const reserve = restoreCost(row);
  assert.equal(reserve, 19);
  // Enough for both deletes, and then one call short of an attach.
  const req = request(w, { used: LIMIT - reserve - 2 });
  const stepper = steps();
  const err = await switchOn({ record: row, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError);
  assert.equal(err.message, 'Stopped before attaching acme.com: the Cloudflare calls left in this request are kept for putting everything back.');
  assert.equal(req.budget.remaining(), reserve);
  assert.deepEqual(stepper.actions(), ['record-deleted', 'record-deleted']);

  const back = await restore({ record: { ...row, ...stepper.row }, cf: req.cf, sleep: sleeper().sleep, step: stepper.step, budget: req.budget });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(zoneState(w), zoneState(world()));
  withinBudget(req);

  // Past the deadline nothing starts either.
  const late = request(world());
  const err2 = await switchOn({ record: row, cf: late.cf, deadline: Date.now() - 1 }).catch((e) => e);
  assert.match(err2.message, /^Ran out of time before deleting A acme\.com/);
  assert.equal(late.calls(), 0);
});

test('an attach that keeps clashing is tried three times, then the switch fails', async () => {
  const w = world();
  const req = request(w);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  w.fake.failOn('PUT', `/accounts/${ACCOUNT}/workers/domains`, { status: 409, codes: [100117], message: 'Hostname already has externally managed DNS records' });
  const sleep = sleeper();
  const err = await switchOn({ record: rowOf(plan), cf: req.cf, sleep: sleep.sleep, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError);
  assert.deepEqual(sleep.waits, [1000, 2000]);
  assert.equal(callLabels(w, 0).filter((l) => l.startsWith('attach')).length, 3);
  assert.match(err.message, /^Could not attach acme\.com to staging-acme\. Cloudflare said: Hostname already has externally managed DNS records \(code 100117\)\.$/);
  withinBudget(req);
});

test('with no zone listing after the attaches the switch still succeeds; the Roll back finds the Worker records itself', async () => {
  const w = world();
  const stepper = steps({
    onStep: (e) => { if (e.add?.steps_done?.[0] === 'attached:www.acme.com') w.fake.failOn('GET', `/zones/${ZONE}/dns_records`, { status: 500, times: 1 }); },
  });
  const { record, result } = await goLive(w, { stepper });
  assert.ok(result.attached.every((a) => a.dns_id === undefined));
  assert.ok(stepper.actions().includes('worker-records-unknown'));
  const back = await rollBack(w, record);
  assert.equal(back.ok, true);
});

// --- The restore ---

test('the restore works one host at a time: detach, wait, put back, then the next', async () => {
  const w = world();
  const { record, result } = await goLive(w);
  const names = Object.fromEntries(result.attached.map((a) => [a.id, a.hostname]));
  const from = w.fake.calls.length;
  const back = await rollBack(w, record);
  assert.ok(back.ok);
  assert.deepEqual(callLabels(w, from, names), [
    'rules', 'delete rule', 'domains', 'records',
    'detach acme.com', 'records', 'create A acme.com',
    'detach www.acme.com', 'records', 'create CNAME www.acme.com',
    'domains', 'records',
  ]);
});

test('a host now on a third Worker is left alone, as a note; ok can still be true', async () => {
  const w = world();
  const { record, result } = await goLive(w);
  const www = result.attached.find((a) => a.hostname === 'www.acme.com');
  await w.admin.detachCustomDomain(www.id);
  await w.admin.attachCustomDomain({ hostname: 'www.acme.com', service: 'someone-else', zone_id: ZONE });

  const back = await rollBack(w, record);
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.equal(back.notes[0], 'www.acme.com is now on someone-else, so the desk left it and did not put its old records back.');
  assert.ok(back.stepper.actions().includes('host-left'));
  assert.deepEqual(domainState(w), ['www.acme.com on someone-else']);
  assert.ok(zoneState(w).includes('A acme.com 192.0.2.10 proxied ttl=1'));
  assert.ok(!zoneState(w).some((s) => s.startsWith('CNAME www.acme.com')), 'its old record was not put back');
});

test('a host that carries other records now is left alone, as a note; its old records are not put back next to them', async () => {
  const w = world();
  const { record, result } = await goLive(w);
  // A Workers Builds deploy drops both Custom Domains, and someone points
  // the apex at a new host by hand to get the site up.
  for (const a of result.attached) await w.admin.detachCustomDomain(a.id);
  await w.admin.createDnsRecord(ZONE, { type: 'A', name: 'acme.com', content: '198.51.100.7', proxied: true, ttl: 1 });

  const back = await rollBack(w, record);
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.ok(back.notes.includes('acme.com has other records now (A 198.51.100.7), so the desk did not put its old ones back next to them.'), back.notes.join(' '));
  assert.ok(back.stepper.actions().includes('host-left'));
  assert.ok(zoneState(w).includes('A acme.com 198.51.100.7 proxied ttl=1'));
  assert.ok(!zoneState(w).includes('A acme.com 192.0.2.10 proxied ttl=1'), 'not added next to the new one');
  assert.ok(zoneState(w).includes('CNAME www.acme.com acme.com proxied ttl=1'), 'www had nothing, so its record is back');
});

test('a step the restore cannot write goes into its notes, and the restore still finishes', async () => {
  const w = world();
  const { record } = await goLive(w);
  const back = await rollBack(w, record, { stepper: steps({ throwOn: () => true }) });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(zoneState(w), zoneState(world()));
  assert.deepEqual(domainState(w), []);
  assert.deepEqual(ourRules(w), []);
  assert.deepEqual(back.notes.filter((n) => n.startsWith('Could not record')),
    ['Could not record a step, so the log may miss it: Durable Object reset because its code was updated.'], 'said once');
});

test('the restore tells the Worker\'s own records apart with no noted dns_id: the www AAAA 100:: placeholder comes back', async () => {
  const placeholder = { type: 'AAAA', name: 'www.acme.com', content: '100::', proxied: true };
  const records = [RECORDS[0], placeholder, ...RECORDS.slice(2)];
  const start = zoneState(world({ records }));
  // Unmarked Worker records (Cloudflare does not promise the mark), and a
  // detach that takes a moment. Once the restore is done, the lingering
  // ones are let go before the zone is compared.
  const unmark = (w) => { for (const r of w.fake.state.records) if (r.meta.read_only && r.zone_id === ZONE) r.meta = {}; };
  const settled = async (w) => { for (let i = 0; i < 5; i++) await w.admin.listDnsRecords(ZONE, 'www.acme.com'); return zoneState(w); };

  // Roll back after a switch whose listing of the Worker records failed.
  const w = world({ records });
  const stepper = steps({
    onStep: (e) => { if (e.add?.steps_done?.[0] === 'attached:www.acme.com') w.fake.failOn('GET', `/zones/${ZONE}/dns_records`, { status: 500, times: 1 }); },
  });
  const { record, result } = await goLive(w, { stepper });
  assert.ok(result.attached.every((a) => a.dns_id === undefined));
  unmark(w);
  w.fake.state.detachLag = 3;
  const back = await rollBack(w, record);
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.ok(back.stepper.texts().includes('Put back AAAA www.acme.com → 100:: (proxied, TTL auto).'));
  assert.deepEqual(await settled(w), start);

  // The automatic restore: the www attach lands but answers an error, so
  // www is not in `attached` and no dns_id was ever noted.
  const auto = world({
    records,
    wrap: (fetchImpl) => async (input, init = {}) => {
      const res = await fetchImpl(input, init);
      if (init.method === 'PUT' && JSON.parse(init.body).hostname === 'www.acme.com') {
        unmark(auto);
        return Response.json({ success: false, errors: [{ code: 10013, message: 'Gateway timeout' }], messages: [], result: null }, { status: 504 });
      }
      return res;
    },
  });
  const req = request(auto);
  const { plan } = await buildPlan({ site: SITE, cf: req.cf, deskHost: DESK });
  auto.fake.state.detachLag = 3;
  const err = await switchOn({ record: plan, cf: req.cf, sleep: sleeper().sleep, budget: req.budget }).catch((e) => e);
  assert.ok(err instanceof SwitchError, String(err));
  assert.deepEqual(err.attached.map((a) => a.hostname), ['acme.com']);
  const put = await restore({ record: { ...plan, attached: err.attached }, cf: req.cf, sleep: sleeper().sleep, budget: req.budget });
  assert.equal(put.ok, true, put.errors.join(' '));
  assert.deepEqual(await settled(auto), start);
  assert.deepEqual(domainState(auto), []);
  withinBudget(req);
});

test('"the record already exists" (81057) for a record that looks like the Worker\'s own is not taken as present: it is tried again', async () => {
  const placeholder = { type: 'AAAA', name: 'www.acme.com', content: '100::', proxied: true };
  let armed = false;
  let tries = 0;
  const w = world({
    records: [RECORDS[0], placeholder, ...RECORDS.slice(2)],
    wrap: (fetchImpl) => async (input, init = {}) => {
      if (init.method === 'POST' && String(input).endsWith('/dns_records') && JSON.parse(init.body).content === '100::') {
        tries++;
        if (armed) {
          armed = false;
          return Response.json({ success: false, errors: [{ code: 81057, message: 'The record already exists.' }], messages: [], result: null }, { status: 400 });
        }
      }
      return fetchImpl(input, init);
    },
  });
  const { record } = await goLive(w);
  armed = true;
  const sleep = sleeper();
  const back = await rollBack(w, record, { sleep: sleep.sleep });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.equal(tries, 2, 'tried again');
  assert.deepEqual(sleep.waits, [1000]);
  assert.deepEqual(zoneState(w), zoneState(world({ records: [RECORDS[0], placeholder, ...RECORDS.slice(2)] })));
});

test('the restore waits for the Worker\'s record by its dns_id when Cloudflare does not mark it read-only', async () => {
  const w = world();
  const { record } = await goLive(w);
  // The real API does not document read_only; only the noted id says whose it is.
  for (const r of w.fake.state.records) if (r.meta.read_only) r.meta = {};
  w.fake.state.detachLag = 2;
  const sleep = sleeper();
  const back = await rollBack(w, record, { sleep: sleep.sleep });
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.deepEqual(sleep.waits, [1000, 2000, 1000, 2000]);
  assert.deepEqual(zoneState(w), zoneState(world()));
});

test('a read-only or dns_id record is never counted as present: the www AAAA 100:: placeholder case', async () => {
  const placeholder = { type: 'AAAA', name: 'www.acme.com', content: '100::', proxied: true };
  for (const unmarked of [false, true]) {
    const w = world({ records: [RECORDS[0], placeholder, ...RECORDS.slice(2)] });
    const { record } = await goLive(w);
    if (unmarked) for (const r of w.fake.state.records) if (r.meta.read_only) r.meta = {};
    // The Worker's records outlast every look the restore takes.
    w.fake.state.detachLag = 50;
    const sleep = sleeper();
    const back = await rollBack(w, record, { sleep: sleep.sleep });
    assert.equal(back.ok, false, unmarked ? 'by dns_id' : 'by read-only');
    assert.ok(back.errors.includes('AAAA www.acme.com → 100:: (proxied, TTL auto) is not back.'), back.errors.join(' '));
    assert.ok(back.errors.includes('A acme.com → 192.0.2.10 (proxied, TTL auto) is not back.'));
    assert.ok(!back.stepper.actions().includes('record-restored'), 'nothing was created over the Worker\'s record');
    assert.deepEqual(sleep.waits, [1000, 2000, 4000, 1000, 2000, 4000], 'four looks per host');
    assert.ok(back.stepper.texts().includes('The Worker\'s DNS record on www.acme.com is still there after the detach, so the desk did not put www.acme.com back yet. Roll back again in a minute.'));
  }
});

test('"the record already exists" (81057) counts as present', async () => {
  let armed = false;
  const w = world({
    wrap: (fetchImpl) => async (input, init = {}) => {
      const res = await fetchImpl(input, init);
      if (armed && init.method === 'POST' && String(input).endsWith('/dns_records')) {
        armed = false;
        return Response.json({ success: false, errors: [{ code: 81057, message: 'The record already exists.' }], messages: [], result: null }, { status: 400 });
      }
      return res;
    },
  });
  const { record } = await goLive(w);
  armed = true;
  const from = w.fake.calls.length;
  const back = await rollBack(w, record);
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.equal(callLabels(w, from).filter((l) => l.startsWith('create')).length, 2, 'no retry');
  assert.deepEqual(back.stepper.actions().filter((a) => a === 'record-restored' || a === 'restore-problem'), ['record-restored']);
  assert.deepEqual(zoneState(w), zoneState(world()));
});

test('the final listing decides ok: a create that errored but landed is fine, a record still missing is not', async () => {
  let armed = false;
  const w = world({
    wrap: (fetchImpl) => async (input, init = {}) => {
      const res = await fetchImpl(input, init);
      if (armed && init.method === 'POST' && String(input).endsWith('/dns_records')) {
        armed = false;
        return Response.json({ success: false, errors: [{ code: 10013, message: 'Gateway timeout' }], messages: [], result: null }, { status: 504 });
      }
      return res;
    },
  });
  const { record } = await goLive(w);
  armed = true;
  const back = await rollBack(w, record);
  assert.equal(back.ok, true);
  assert.deepEqual(back.errors, []);
  assert.ok(back.stepper.texts().includes('Could not put back A acme.com → 192.0.2.10 (proxied, TTL auto). Cloudflare said: Gateway timeout (code 10013).'), 'the log still says what happened');

  const w2 = world();
  const { record: r2 } = await goLive(w2);
  w2.fake.failOn('POST', `/zones/${ZONE}/dns_records`, { status: 400, codes: [1004], message: 'DNS Validation Error', times: 1 });
  const bad = await rollBack(w2, r2);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['A acme.com → 192.0.2.10 (proxied, TTL auto) is not back.']);
});

test('a second restore changes nothing', async () => {
  const w = world({
    records: RECORDS.filter((r) => r.name !== 'acme.com' || r.type !== 'A'),
    domains: [{ hostname: 'acme.com', service: 'acme-live' }],
  });
  const { record } = await goLive(w);
  const first = await rollBack(w, record);
  assert.ok(first.ok);
  const records = JSON.stringify(w.fake.state.records);
  const domains = JSON.stringify(w.fake.state.domains);
  const rules = JSON.stringify(w.fake.state.rulesets);
  const from = w.fake.calls.length;

  const again = await rollBack(w, record);
  assert.equal(again.ok, true, again.errors.join(' '));
  assert.deepEqual(again.notes, []);
  assert.equal(JSON.stringify(w.fake.state.records), records);
  assert.equal(JSON.stringify(w.fake.state.domains), domains);
  assert.equal(JSON.stringify(w.fake.state.rulesets), rules);
  const writes = w.fake.calls.slice(from).filter((c) => c.method !== 'GET');
  assert.ok(writes.every((c) => c.method === 'DELETE' && c.path.includes('/workers/domains/')), 'only detaches of ids already gone');
  assert.deepEqual(again.stepper.actions(), []);
});

test('a detach that fails leaves that host for the final listing to report, and the next host is still done', async () => {
  const w = world();
  const { record, result } = await goLive(w);
  const acme = result.attached.find((a) => a.hostname === 'acme.com');
  w.fake.failOn('DELETE', `/accounts/${ACCOUNT}/workers/domains/${acme.id}`, { status: 500, message: 'Internal error' });
  const back = await rollBack(w, record);
  assert.equal(back.ok, false);
  assert.deepEqual(back.errors, ['acme.com is still attached to staging-acme.', 'A acme.com → 192.0.2.10 (proxied, TTL auto) is not back.']);
  assert.ok(zoneState(w).includes('CNAME www.acme.com acme.com proxied ttl=1'), 'www was put back');
});

test('a restore that runs out of calls stops waiting at once, says so, and never claims it finished', async () => {
  const w = world();
  const { record } = await goLive(w);
  // Enough to remove the redirect and list the domains, and nothing more.
  const req = request(w, { used: LIMIT - 3 });
  const sleep = sleeper();
  const stepper = steps();
  const back = await restore({ record, cf: req.cf, sleep: sleep.sleep, step: stepper.step, budget: req.budget });
  withinBudget(req);
  assert.equal(back.ok, false);
  assert.deepEqual(sleep.waits, [], 'no waiting for calls that cannot be made');
  assert.equal(back.errors.at(-1), 'Could not check what is back. The desk has used its Cloudflare calls for this request.');
  assert.ok(back.errors.includes('Could not detach acme.com from staging-acme. The desk has used its Cloudflare calls for this request.'));
  assert.deepEqual(domainState(w), ['acme.com on staging-acme', 'www.acme.com on staging-acme'], 'nothing half done');

  // A second Roll back, with a fresh request, finishes the job.
  const again = await rollBack(w, record);
  assert.equal(again.ok, true, again.errors.join(' '));
  assert.deepEqual(zoneState(w), zoneState(world()));
});

test('without the Custom Domain listing the restore still works from the stored ids', async () => {
  const w = world();
  const { record } = await goLive(w);
  w.fake.failOn('GET', `/accounts/${ACCOUNT}/workers/domains`, { status: 500, message: 'Internal error', times: 1 });
  const back = await rollBack(w, record);
  assert.equal(back.ok, true, back.errors.join(' '));
  assert.ok(back.stepper.texts().some((t) => t.startsWith('Could not list the Custom Domains, so the desk could not see')));
  assert.deepEqual(domainState(w), []);
  assert.deepEqual(zoneState(w), zoneState(world()));
});

test('a redirect rule that cannot be removed is an error of its own', async () => {
  const w = world();
  const { record } = await goLive(w);
  w.fake.failOn('DELETE', /\/rules\//, { status: 500, message: 'Internal error' });
  const back = await rollBack(w, record);
  assert.equal(back.ok, false);
  assert.deepEqual(back.errors, ['Could not remove the redirect rule from www.acme.com to acme.com. Cloudflare said: Internal error.']);
  assert.deepEqual(domainState(w), [], 'the hosts were still put back');
});

// --- Verification ---

test('verify: HTTPS waits for a network error, and for a 5xx only within two minutes of the switch', async () => {
  const w = world();
  const { record } = await goLive(w);
  w.sites.pages['https://acme.com/*'] = () => { throw new TypeError('fetch failed', { cause: new Error('SSL handshake failed') }); };
  let v = await checkNow(w, record);
  assert.equal(v.byId('https').status, 'wait');
  assert.equal(v.byId('https').detail, 'Waiting for HTTPS on acme.com…');
  assert.equal(v.byId('noindex'), undefined, 'no page, no page checks');
  assert.equal(v.done, false);

  w.sites.pages['https://acme.com/*'] = { status: 522, body: 'Connection timed out' };
  v = await checkNow(w, record, THURSDAY + 90 * 1000);
  assert.equal(v.byId('https').status, 'wait');
  v = await checkNow(w, record, THURSDAY + 3 * MINUTE);
  assert.equal(v.byId('https').status, 'fail');
  assert.equal(v.byId('https').detail, 'The live address answers HTTP 522. Visitors see an error now. Roll back if it does not clear.');

  w.sites.pages['https://acme.com/*'] = { status: 404 };
  v = await checkNow(w, record);
  assert.equal(v.byId('https').status, 'fail');
});

test('verify: a host with no answer over HTTPS 15 minutes after the switch fails; before then, or with no switch time, it waits', async () => {
  const w = world();
  const { record } = await goLive(w);
  const down = () => { throw new TypeError('fetch failed', { cause: new Error('SSL handshake failed') }); };
  w.sites.pages['https://acme.com/*'] = down;
  w.sites.pages['https://www.acme.com/*'] = down;
  let v = await checkNow(w, record, THURSDAY + 15 * MINUTE);
  assert.equal(v.byId('https').status, 'wait');
  assert.equal(v.byId('redirect').status, 'wait');

  v = await checkNow(w, record, THURSDAY + 24 * 60 * MINUTE);
  assert.equal(v.byId('https').status, 'fail');
  assert.equal(v.byId('https').detail, 'acme.com has not answered over HTTPS for 15 minutes since the switch. Visitors may not reach it. Roll back if it does not clear.');
  assert.equal(v.byId('redirect').status, 'fail');
  assert.equal(v.byId('redirect').detail, 'www.acme.com has not answered over HTTPS for 15 minutes since the switch. Visitors may not reach it. Roll back if it does not clear.');
  assert.equal(v.done, false);

  v = await checkNow(w, { ...record, switched_at: null }, THURSDAY + 24 * 60 * MINUTE);
  assert.equal(v.byId('https').status, 'wait', 'no switch time, nothing to count from');
  assert.equal(v.byId('redirect').status, 'wait');
});

test('verify: with no rule on the row, the redirect is looked up by its ref, and the pair is tested either way', async () => {
  const w = world();
  const { record, result } = await goLive(w);
  // The rule went in, but its answer (or the step that wrote it down) was lost.
  const lost = { ...record, redirect_rule: null, error: 'Could not reach Cloudflare: The operation was aborted due to timeout' };
  let v = await checkNow(w, lost);
  assert.equal(v.byId('redirect').status, 'pass', v.byId('redirect').detail);
  assert.deepEqual(v.redirectRule, result.redirectRule, 'handed back, so the route can store it');
  assert.equal(v.done, true);
  assert.equal((await checkNow(w, record)).redirectRule, null, 'a row that has its rule is not looked up');

  // None of ours, but the pair answers the right 301 anyway: it works.
  await w.admin.deleteRedirectRule(ZONE, result.redirectRule.ruleset_id, result.redirectRule.rule_id);
  const site = w.sites.pages['https://www.acme.com/*'];
  w.sites.pages['https://www.acme.com/*'] = { status: 301, headers: { location: 'https://acme.com/desk-check?x=1' } };
  v = await checkNow(w, lost);
  assert.equal(v.byId('redirect').status, 'pass');
  assert.equal(v.redirectRule, null);

  // Nothing redirects it: only now is the rule missing.
  w.sites.pages['https://www.acme.com/*'] = site;
  v = await checkNow(w, lost);
  assert.equal(v.byId('redirect').status, 'fail');
  assert.equal(v.byId('redirect').detail,
    'The redirect rule was not added: Could not reach Cloudflare: The operation was aborted due to timeout. www.acme.com shows the site without redirecting.');
});

test('verify: the redirect passes only on a 301 with exactly the right Location', async () => {
  const w = world();
  const { record } = await goLive(w);
  const answers = [
    [{ status: 301, headers: { location: 'https://acme.com/desk-check?x=1' } }, 'pass'],
    [{ status: 301, headers: { location: 'https://acme.com/' } }, 'fail'],
    [{ status: 302, headers: { location: 'https://acme.com/desk-check?x=1' } }, 'fail'],
    [{ status: 308, headers: { location: 'https://acme.com/desk-check?x=1' } }, 'fail'],
    [{ status: 200, body: stagingHtml() }, 'fail'],
    [() => { throw new TypeError('fetch failed'); }, 'wait'],
  ];
  for (const [answer, status] of answers) {
    w.sites.pages['https://www.acme.com/*'] = answer;
    const v = await checkNow(w, record);
    assert.equal(v.byId('redirect').status, status, JSON.stringify(answer));
  }
  const v = await checkNow(w, record);
  assert.equal(v.byId('redirect').detail, 'Waiting for HTTPS on www.acme.com…');
  w.sites.pages['https://www.acme.com/*'] = { status: 308, headers: { location: 'https://acme.com/desk-check?x=1' } };
  const v308 = await checkNow(w, record);
  assert.equal(v308.byId('redirect').detail,
    'www.acme.com answers HTTP 308 to https://acme.com/desk-check?x=1, not a 301 to https://acme.com/desk-check?x=1. A 308 means another rule answered first.');
  assert.equal(w.sites.calls.at(-1).redirect, 'manual');
});

test('verify: a host no longer attached fails and says why', async () => {
  const w = world();
  const { record, result } = await goLive(w);
  await w.admin.detachCustomDomain(result.attached[1].id);
  const v = await checkNow(w, record);
  assert.equal(v.byId('still-attached').status, 'fail');
  assert.equal(v.byId('still-attached').detail,
    'www.acme.com is no longer attached to staging-acme (a Workers Builds deploy replaces Custom Domains with the repo\'s list). The site is down on www.acme.com.');
  assert.equal(v.done, false);
});

test('verify: MX and TXT are compared with the snapshot, on Cloudflare and on dns.google', async () => {
  const w = world();
  const { record } = await goLive(w);
  // Straight to the fake: the client's createDnsRecord makes website
  // records only and does not send an MX priority.
  await w.fake.fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`, {
    method: 'POST', headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'MX', name: 'acme.com', content: 'mx2.mailhost.net', priority: 20, ttl: 1 }),
  });
  let v = await checkNow(w, record);
  const mx = v.byId('mx-txt');
  assert.equal(mx.status, 'fail');
  assert.equal(mx.detail, 'MX or TXT at acme.com is not what it was before the switch.');
  assert.deepEqual(mx.items, ['New: MX 20 mx2.mailhost.net']);

  const w2 = world();
  const { record: r2 } = await goLive(w2);
  w2.resolvers.set('acme.com', 'MX', ['10 mx.elsewhere.net'], 'dns.google');
  v = await checkNow(w2, r2);
  assert.deepEqual(v.byId('mx-txt').items, ['dns.google gives MX mx.elsewhere.net, not mx.mailhost.net.']);

  const w3 = world();
  const { record: r3 } = await goLive(w3);
  const [txt] = (await w3.admin.listDnsRecords(ZONE, 'acme.com')).filter((r) => r.type === 'TXT');
  await w3.admin.deleteDnsRecord(ZONE, txt.id);
  v = await checkNow(w3, r3);
  assert.deepEqual(v.byId('mx-txt').items, ['Gone: TXT v=spf1 include:_spf.mailhost.net ~all']);
  assert.equal(v.byId('mx-txt').status, 'fail');

  const w4 = world();
  const { record: r4 } = await goLive(w4);
  w4.resolvers.answers['dns.google'] = () => { throw new Error('timed out'); };
  v = await checkNow(w4, r4);
  assert.equal(v.byId('mx-txt').status, 'warn');
});

test('verify: the live build must be staging\'s, a page past the home page must answer, and noindex fails', async () => {
  const w = world();
  const { record } = await goLive(w);
  w.sites.pages['https://acme.com/'] = { body: stagingHtml().replace('index.B1x2y3.css', 'index.OLD999.css') };
  w.sites.pages['https://acme.com/services/'] = { status: 404 };
  let v = await checkNow(w, record);
  assert.equal(v.byId('same-site').status, 'fail');
  assert.equal(v.byId('same-site').detail, 'acme.com is not serving the staging build yet.');
  assert.equal(v.byId('deep-page').status, 'fail');
  assert.equal(v.byId('deep-page').detail, '/services/ on acme.com answers HTTP 404.');

  w.sites.pages['https://acme.com/'] = { body: stagingHtml({ assets: false }) };
  w.sites.pages[`https://${STAGING}/`] = { body: stagingHtml({ assets: false }) };
  v = await checkNow(w, record);
  assert.equal(v.byId('same-site').status, 'warn');
  assert.equal(v.byId('same-site').detail, 'Same title; could not compare the builds.');
  w.sites.pages['https://acme.com/'] = { body: stagingHtml({ assets: false, title: 'Acme Plumbing – Just another WordPress site' }) };
  assert.equal((await checkNow(w, record)).byId('same-site').status, 'fail', 'different titles');

  // A trailing-slash redirect on the same site is followed once.
  w.sites.pages['https://acme.com/'] = { headers: { 'x-robots-tag': 'noindex' }, body: stagingHtml({ assets: false, body: '<a href="/about">About</a>' }).replace('<a href="/services/">Services</a>', '') };
  w.sites.pages['https://acme.com/about'] = { status: 308, headers: { location: '/about/' } };
  w.sites.pages['https://acme.com/about/'] = { body: '<title>About</title>' };
  v = await checkNow(w, record);
  assert.equal(v.byId('deep-page').status, 'pass');
  assert.equal(v.byId('noindex').status, 'fail');
  assert.deepEqual(v.byId('noindex').items, ['X-Robots-Tag: noindex']);

  w.sites.pages['https://acme.com/'] = { body: '<title>Acme Plumbing</title><a href="/">Home</a><a href="mailto:a@acme.com">Mail</a>' };
  v = await checkNow(w, record);
  assert.equal(v.byId('deep-page').status, 'warn');
});

test('verify costs well under the budget, and every call is counted', async () => {
  const w = world({ records: [...RECORDS.slice(0, 1).map((r) => ({ ...r, proxied: false })), { type: 'AAAA', name: 'acme.com', content: '2001:db8::10', proxied: false }, ...RECORDS.slice(1)] });
  const { record } = await goLive(w);
  const req = request(w);
  await verify({ record, cf: req.cf, siteFetch: req.fetch, doh: req.fetch, now: THURSDAY + 5 * MINUTE });
  withinBudget(req);
  assert.ok(req.calls() <= 20, 'called ' + req.calls());
  assert.ok(w.resolvers.calls.some((c) => c.type === 'AAAA'), 'an old DNS-only AAAA is looked for too');
});

// --- The helpers ---

test('readCapped reads no more than it is allowed, and stops the download', async () => {
  assert.equal(await readCapped(new Response('héllo')), 'héllo');
  assert.equal(await readCapped(new Response(null)), '');
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(1000))); },
    cancel() { cancelled = true; },
  });
  const text = await readCapped(new Response(endless), 2500);
  assert.equal(text.length, 2500);
  assert.ok(cancelled);
});

test('robotsNoindex finds the header or a robots / googlebot meta tag, in any attribute order', () => {
  const h = (v) => new Headers(v ? { 'x-robots-tag': v } : {});
  assert.equal(robotsNoindex(h('noindex'), ''), 'X-Robots-Tag: noindex');
  assert.equal(robotsNoindex(h('none'), ''), 'X-Robots-Tag: none');
  assert.equal(robotsNoindex(h('googlebot: noindex, nofollow'), ''), 'X-Robots-Tag: googlebot: noindex, nofollow');
  assert.equal(robotsNoindex(h('noarchive'), ''), null);
  assert.equal(robotsNoindex({ 'x-robots-tag': 'noindex' }, ''), 'X-Robots-Tag: noindex', 'a plain object works too');
  assert.equal(robotsNoindex(h(), '<meta name="robots" content="noindex, follow">'), '<meta name="robots" content="noindex, follow">');
  assert.ok(robotsNoindex(h(), "<META CONTENT='NONE' NAME='GoogleBot'>"));
  assert.equal(robotsNoindex(h(), '<meta name="robots" content="index, follow">'), null);
  assert.equal(robotsNoindex(h(), '<meta name="description" content="We never noindex anything">'), null);
  assert.equal(robotsNoindex(h(), '<!-- <meta name="robots" content="noindex"> -->'), null, 'a comment is not a tag');
});

test('canonicalHost reads the canonical link, resolving a relative one against the page', () => {
  assert.equal(canonicalHost('<link rel="canonical" href="https://Acme.com/">'), 'acme.com');
  assert.equal(canonicalHost('<link href="/about/" rel="canonical">', 'https://staging.example.net/'), 'staging.example.net');
  assert.equal(canonicalHost('<link href="/about/" rel="canonical">'), null, 'relative with nothing to resolve against');
  assert.equal(canonicalHost('<link rel="alternate" href="https://acme.com/fr/">'), null);
  assert.equal(canonicalHost('<link rel="canonical" data-x="a > b" href="https://acme.com/">'), 'acme.com', 'a quoted > does not end the tag');
});

test('resourceUrls finds every file the page loads, and nothing a script only mentions', () => {
  const html = `<link rel="stylesheet" href="/a.css"><link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/touch.png"><link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/font.woff2" as="font"><link rel="modulepreload" href="/m.js">
<link rel="alternate" href="/feed.xml"><a href="/page/">not a file</a>
<img src="/i.png" srcset="/i-1x.png 1x, https://cdn.example.net/i-2x.png 2x" data-src="/lazy.png" data-srcset="/l1.png 1x,/l2.png 2x">
<video poster="/poster.jpg"></video><div style="background-image:url(&quot;/bg.png&quot;)"></div>
<style>.hero{background:url('/hero.jpg')} .x{background:url(data:image/png;base64,AAAA)}</style>
<script>var u = "/wp-content/from-a-script.js";</script><script src="/app.js"></script>`;
  assert.deepEqual(resourceUrls(html, 'https://s.example.net/'), [
    'https://s.example.net/a.css', 'https://s.example.net/favicon.ico', 'https://s.example.net/touch.png',
    'https://s.example.net/site.webmanifest', 'https://s.example.net/font.woff2', 'https://s.example.net/m.js',
    'https://s.example.net/i.png', 'https://s.example.net/lazy.png', 'https://s.example.net/i-1x.png',
    'https://cdn.example.net/i-2x.png', 'https://s.example.net/l1.png', 'https://s.example.net/l2.png',
    'https://s.example.net/poster.jpg', 'https://s.example.net/bg.png', 'https://s.example.net/app.js',
    'https://s.example.net/hero.jpg',
  ]);
});

test('oldFiles names WordPress paths and files on the hosts that change hands', () => {
  const urls = [
    'https://s.example.net/_astro/a.css', 'https://img.acme.com/wp-content/x.jpg', 'https://acme.com/logo.png',
    'https://WWW.acme.com/hero.png', 'https://s.example.net/wp-includes/js/x.js', 'https://cdn.example.net/ok.png',
  ];
  assert.deepEqual(oldFiles(urls, ['acme.com', 'www.acme.com', null]), [
    'https://img.acme.com/wp-content/x.jpg', 'https://acme.com/logo.png', 'https://WWW.acme.com/hero.png',
    'https://s.example.net/wp-includes/js/x.js',
  ]);
  assert.deepEqual(oldFiles(['not a url', 'https://acme.com/x'], ['acme.com']), ['https://acme.com/x']);
});

test('the page helpers stay linear on odd pages: nothing unclosed makes them slow', () => {
  const MB = 1024 * 1024;
  const fill = (s) => s.repeat(Math.ceil(MB / s.length)).slice(0, MB);
  const odd = ['<a b="', '<a b ', '<!--', '<script>', '<style>', '<title>', '<<<<3 ', '<img a="=" '].map(fill);
  odd.push('<style>' + fill('url(url('), '<div style="' + fill('url(') + '">');
  const started = performance.now();
  for (const html of odd) {
    robotsNoindex(new Headers(), html);
    canonicalHost(html, 'https://s.example.net/');
    oldFiles(resourceUrls(html, 'https://s.example.net/'), ['acme.com']);
    astroAssets(html);
    pageTitle(html);
    firstInternalLink(html, 'https://s.example.net/');
  }
  // A quadratic scan of any one of these takes minutes, not seconds.
  assert.ok(performance.now() - started < 5000, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(robotsNoindex(new Headers(), '<meta name="robots" content="noindex"><a href="x'), '<meta name="robots" content="noindex">', 'tags before an unclosed one still count');
  assert.equal(pageTitle('<title>Unclosed'), 'Unclosed', 'a title never closed runs to the end, as in a browser');
});

test('each page is read as itself, never as the page read before it', () => {
  const a = '<meta name="robots" content="noindex"><title>A</title><link rel="canonical" href="https://a.example/">';
  const b = '<title>B</title><link rel="canonical" href="https://b.example/">';
  assert.ok(robotsNoindex(new Headers(), a));
  assert.equal(robotsNoindex(new Headers(), b), null);
  assert.equal(pageTitle(a), 'A');
  assert.equal(canonicalHost(b), 'b.example');
  assert.equal(canonicalHost(a), 'a.example');
  assert.equal(pageTitle(b), 'B');
  assert.equal(pageTitle(''), null);
});

test('astroAssets, pageTitle and firstInternalLink', () => {
  const html = '<title> Acme &amp;\n Sons </title><link href="https://s.example.net/_astro/b.css"><script src="/_astro/a.js?v=1"></script><img src="/_astro/b.css">';
  assert.deepEqual(astroAssets(html), ['/_astro/a.js', '/_astro/b.css']);
  assert.equal(pageTitle(html), 'Acme & Sons');
  assert.equal(pageTitle('<p>no title</p>'), null);
  const links = '<a href="#top">Top</a><a href="/">Home</a><a href="mailto:x@acme.com">Mail</a><a href="https://other.com/x">Out</a><a href="/about/#team">About</a>';
  assert.equal(firstInternalLink(links, 'https://acme.com/'), 'https://acme.com/about/');
  assert.equal(firstInternalLink('<a href="/?page=2">2</a>', 'https://acme.com/'), null);
});

test('robotsBlocksAll reads every group for *, and only Disallow: / blocks all', () => {
  assert.equal(robotsBlocksAll('User-agent: *\nDisallow: /'), true);
  assert.equal(robotsBlocksAll('User-agent: *\r\nDisallow: /*  # everything'), true);
  assert.equal(robotsBlocksAll('User-agent: *\nDisallow: /admin/'), false);
  assert.equal(robotsBlocksAll('User-agent: GPTBot\nDisallow: /'), false);
  assert.equal(robotsBlocksAll('User-agent: Googlebot\nUser-agent: *\nDisallow: /'), true, 'a group may name several agents');
  assert.equal(robotsBlocksAll('User-agent: *\nAllow: /\n\nUser-agent: Bingbot\nDisallow: /'), false);
  assert.equal(robotsBlocksAll(MANAGED_ROBOTS + '\nUser-agent: *\nDisallow: /'), true);
  assert.equal(robotsBlocksAll(''), false);
});

test('spfHasBareA: a, +a and a/nn allow the domain\'s own address; a:other does not', () => {
  assert.equal(spfHasBareA('v=spf1 a mx ~all'), true);
  assert.equal(spfHasBareA('"v=spf1 +a -all"'), true);
  assert.equal(spfHasBareA('v=spf1 a/24 ~all'), true);
  assert.equal(spfHasBareA('"v=spf1 include:_spf.google.com " "a ~all"'), true, 'chunks join');
  assert.equal(spfHasBareA('v=spf1 a:mail.acme.com ~all'), false);
  assert.equal(spfHasBareA('v=spf1 -a ~all'), false);
  assert.equal(spfHasBareA('v=spf1 mx ~all'), false);
  assert.equal(spfHasBareA('google-site-verification=a'), false);
  // Given the hosts whose address moves, a:<one of them> counts as well.
  assert.equal(spfHasBareA('v=spf1 a:acme.com ~all', ['acme.com']), true);
  assert.equal(spfHasBareA('v=spf1 +a:ACME.com./24 ~all', ['acme.com']), true);
  assert.equal(spfHasBareA('v=spf1 a:mail.acme.com ~all', ['acme.com']), false);
  assert.equal(spfHasBareA('v=spf1 -a:acme.com ~all', ['acme.com']), false);
  assert.equal(spfHasBareA('v=spf1 a:acme.com ~all'), false, 'with no hosts, a:<name> is another domain, as before');
});

test('cnameChain follows the zone\'s own CNAMEs, five hops at most, and stops at a loop', () => {
  const c = (name, content) => ({ type: 'CNAME', name, content });
  const records = [c('a.x.com', 'b.x.com.'), c('b.x.com', 'X.com'), c('loop1.x.com', 'loop2.x.com'), c('loop2.x.com', 'loop1.x.com'),
    c('h1', 'h2'), c('h2', 'h3'), c('h3', 'h4'), c('h4', 'h5'), c('h5', 'h6'), c('h6', 'h7')];
  assert.deepEqual(cnameChain(records, 'a.x.com'), ['b.x.com', 'x.com']);
  assert.deepEqual(cnameChain(records, 'x.com'), []);
  assert.deepEqual(cnameChain(records, 'loop1.x.com'), ['loop2.x.com']);
  assert.deepEqual(cnameChain(records, 'h1'), ['h2', 'h3', 'h4', 'h5', 'h6']);
});

test('routeCovers matches the host part of a route pattern, * matching any run of characters', () => {
  assert.equal(routeCovers('acme.com/*', 'acme.com'), true);
  assert.equal(routeCovers('*acme.com/*', 'www.acme.com'), true);
  assert.equal(routeCovers('*.acme.com/*', 'acme.com'), false);
  assert.equal(routeCovers('*.acme.com/*', 'www.acme.com'), true);
  assert.equal(routeCovers('https://ACME.com/shop*', 'acme.com'), true);
  assert.equal(routeCovers('acme.com.evil.net/*', 'acme.com'), false);
  assert.equal(routeCovers('acmexcom/*', 'acme.com'), false, 'a dot is a dot');
  assert.equal(routeCovers('', 'acme.com'), false);
});

test('doh asks each resolver the way it answers, and returns plain names', async () => {
  const resolvers = createFakeDoh({
    'dns.google': { 'acme.com': { NS: NS.map((n) => n + '.'), MX: '10 MX.Mailhost.net', TXT: '"v=spf1 -all"' }, 'www.acme.com': { CNAME: 'acme.com' } },
    'cloudflare-dns.com': { 'acme.com': { NS, A: '104.21.0.1' } },
  });
  assert.deepEqual((await doh(resolvers.fetch, 'dns.google', 'acme.com', 'NS')).map((a) => a.data), NS);
  assert.deepEqual(await doh(resolvers.fetch, 'dns.google', 'acme.com', 'MX'), [{ name: 'acme.com', type: 'MX', ttl: 300, data: '10 mx.mailhost.net' }]);
  assert.equal((await doh(resolvers.fetch, 'cloudflare-dns.com', 'acme.com', 'NS'))[0].name, 'acme.com');
  assert.deepEqual((await doh(resolvers.fetch, 'dns.google', 'acme.com', 'TXT'))[0].data, 'v=spf1 -all');
  assert.deepEqual(await doh(resolvers.fetch, 'dns.google', 'nope.acme.com', 'A'), [], 'NXDOMAIN is an answer of nothing');
  assert.equal(resolvers.calls.find((c) => c.resolver === 'cloudflare-dns.com').accept, 'application/dns-json');

  resolvers.answers['dns.google'] = () => ({ Status: 2 });
  await assert.rejects(doh(resolvers.fetch, 'dns.google', 'acme.com', 'A'), /could not look up acme\.com \(status 2\)/);
  resolvers.answers['dns.google'] = () => new Response('busy', { status: 503 });
  await assert.rejects(doh(resolvers.fetch, 'dns.google', 'acme.com', 'A'), /dns\.google answered HTTP 503/);
  await assert.rejects(doh(resolvers.fetch, 'dns.example', 'acme.com', 'A'), /does not ask dns\.example/);
});

test('the redirect rule is exactly the spec\'s', () => {
  assert.deepEqual(redirectRuleFor({ from: 'www.acme.com', to: 'acme.com', ref: REF }), {
    ref: REF,
    description: 'Website Desk: www.acme.com to acme.com',
    expression: '(http.host eq "www.acme.com")',
    action: 'redirect',
    action_parameters: { from_value: {
      status_code: 301,
      target_url: { expression: 'concat("https://acme.com", http.request.uri.path)' },
      preserve_query_string: true } },
    enabled: true,
  });
});

test('records read as a person would say them', () => {
  assert.equal(recordText({ type: 'A', name: 'Acme.com.', content: '192.0.2.10', proxied: true, ttl: 1 }), 'A acme.com → 192.0.2.10 (proxied, TTL auto)');
  assert.equal(recordText({ type: 'CNAME', name: 'www.acme.com', content: 'acme.com', proxied: false, ttl: 3600 }), 'CNAME www.acme.com → acme.com (DNS only, TTL 3600)');
});
