import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare, CfError, isConflict, isNotFound } from '../src/cloudflare.js';
import { budget, countedFetch, BudgetError } from '../src/budget.js';
import { createFakeCloudflare, createFakeSites, createFakeDoh, combineFetches } from './fake-cloudflare.js';

const TOKEN = 'tok-5ecret-never-shown';
const ACCOUNT = 'acc00000000000000000000000000001';
const ZONE = 'e0000000000000000000000000000001';
const API = 'https://api.cloudflare.com/client/v4';
const ENTRYPOINT = `/zones/${ZONE}/rulesets/phases/http_request_dynamic_redirect/entrypoint`;

function setup(options = {}) {
  const fake = createFakeCloudflare({ accountId: ACCOUNT, zones: [{ id: ZONE, name: 'example.com' }], ...options });
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: fake.fetch });
  return { fake, cf };
}

// A fetch that plays back fixed answers in order, for the client's own rules
// without the fake's. An Error in the list is thrown, like a network failure.
function scripted(...answers) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    const body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return new Response(body, { status: a.status ?? 200, headers: a.headers });
  };
  return { cf: cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl }), seen };
}

const redirectRule = (ref, from = 'www.example.com', to = 'example.com') => ({
  ref,
  description: `Website Desk: ${from} to ${to}`,
  expression: `(http.host eq "${from}")`,
  action: 'redirect',
  action_parameters: { from_value: {
    status_code: 301,
    target_url: { expression: `concat("https://${to}", http.request.uri.path)` },
    preserve_query_string: true } },
  enabled: true,
});

const otherRule = (ref) => ({ ...redirectRule(ref, 'old.example.com', 'example.com') });

async function rejects(promise, check) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof CfError, 'a CfError, not ' + e?.constructor?.name);
    assert.ok(!e.message.includes(TOKEN), 'the token never appears in an error');
    check(e);
    return true;
  });
}

// --- The client ---

test('every call carries the token in the Authorization header and nowhere else, and never follows a redirect', async () => {
  const { fake, cf } = setup({
    records: [{ type: 'A', name: 'example.com', content: '192.0.2.10', proxied: true }],
    workers: ['staging-acme'],
    secrets: { 'staging-acme': ['RESEND_KEY'] },
  });
  const zone = await cf.findZone('www.example.com');
  const [rec] = await cf.listDnsRecords(zone.id, 'example.com');
  await cf.listZoneRecords(zone.id);
  await cf.listWorkerRoutes(zone.id);
  await cf.deleteDnsRecord(zone.id, rec.id);
  const domain = await cf.attachCustomDomain({ hostname: 'example.com', service: 'staging-acme', zone_id: zone.id });
  await cf.listCustomDomains({ zone_id: zone.id });
  await cf.listSecretNames('staging-acme');
  await cf.getSslMode(zone.id);
  const rule = await cf.addRedirectRule(zone.id, redirectRule('desk-1'));
  await cf.findRedirectRules(zone.id, 'desk-1');
  await cf.deleteRedirectRule(zone.id, rule.ruleset_id, rule.rule_id);
  await cf.detachCustomDomain(domain.id);
  await cf.createDnsRecord(zone.id, rec);

  assert.ok(fake.calls.length >= 16);
  for (const c of fake.calls) {
    const where = `${c.method} ${c.path}`;
    assert.ok(c.url.startsWith(API + '/'), where);
    assert.equal(c.headers.authorization, 'Bearer ' + TOKEN, where);
    assert.ok(!c.url.includes(TOKEN), where);
    assert.ok(!JSON.stringify(c.body ?? '').includes(TOKEN), where);
    assert.equal(c.redirect, 'manual', where);
    assert.ok(c.signal instanceof AbortSignal, where + ' has a timeout');
    assert.equal(c.headers['content-type'], c.body === undefined ? undefined : 'application/json', where);
  }
  assert.ok(!fake.calls.some((c) => c.method === 'PUT' && c.path.includes('/rulesets')), 'never a PUT on a ruleset');
});

test('each method calls the documented URL with the documented query', async () => {
  const { fake, cf } = setup({ workers: ['staging-acme'] });
  const last = () => fake.calls.at(-1);

  await cf.findZone('Www.Example.com');
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path, c.query]), [
    ['GET', '/zones', { name: 'www.example.com', 'account.id': ACCOUNT }],
    ['GET', '/zones', { name: 'example.com', 'account.id': ACCOUNT }],
  ]);

  await cf.listDnsRecords(ZONE, 'WWW.example.com');
  assert.deepEqual([last().method, last().path, last().query],
    ['GET', `/zones/${ZONE}/dns_records`, { name: 'www.example.com', per_page: '100' }]);

  await cf.listZoneRecords(ZONE);
  assert.deepEqual([last().method, last().path, last().query],
    ['GET', `/zones/${ZONE}/dns_records`, { per_page: '5000' }]);

  await cf.listWorkerRoutes(ZONE);
  assert.deepEqual([last().method, last().path, last().query], ['GET', `/zones/${ZONE}/workers/routes`, {}]);

  await cf.listCustomDomains({ hostname: 'staging.example.com' });
  assert.deepEqual([last().method, last().path, last().query],
    ['GET', `/accounts/${ACCOUNT}/workers/domains`, { hostname: 'staging.example.com' }]);
  await cf.listCustomDomains({ zone_id: ZONE, service: 'staging-acme' });
  assert.deepEqual(last().query, { zone_id: ZONE, service: 'staging-acme' });

  const d = await cf.attachCustomDomain({ hostname: 'example.com', service: 'staging-acme', zone_id: ZONE });
  assert.deepEqual([last().method, last().path, last().body],
    ['PUT', `/accounts/${ACCOUNT}/workers/domains`, { hostname: 'example.com', service: 'staging-acme', zone_id: ZONE }]);
  assert.ok(!('environment' in last().body), 'environment is deprecated and never sent');
  assert.deepEqual(Object.keys(d).sort(), ['hostname', 'id', 'service', 'zone_id', 'zone_name']);

  await cf.detachCustomDomain(d.id);
  assert.deepEqual([last().method, last().path], ['DELETE', `/accounts/${ACCOUNT}/workers/domains/${d.id}`]);

  await cf.listSecretNames('staging-acme');
  assert.deepEqual([last().method, last().path], ['GET', `/accounts/${ACCOUNT}/workers/scripts/staging-acme/secrets`]);

  await cf.getSslMode(ZONE);
  assert.deepEqual([last().method, last().path], ['GET', `/zones/${ZONE}/settings/ssl`]);

  await cf.getRedirectEntrypoint(ZONE);
  assert.deepEqual([last().method, last().path], ['GET', ENTRYPOINT]);

  await cf.deleteDnsRecord(ZONE, 'd0000000000000000000000000000404').catch(() => {});
  assert.deepEqual([last().method, last().path], ['DELETE', `/zones/${ZONE}/dns_records/d0000000000000000000000000000404`]);

  const r = await cf.addRedirectRule(ZONE, redirectRule('desk-1'));
  await cf.deleteRedirectRule(ZONE, r.ruleset_id, r.rule_id);
  assert.deepEqual([last().method, last().path], ['DELETE', `/zones/${ZONE}/rulesets/${r.ruleset_id}/rules/${r.rule_id}`]);
});

test('a Cloudflare error becomes a CfError with its status, codes and messages', async () => {
  const msg = "Hostname 'example.com' already has externally managed DNS records (A, CNAME, etc). Delete them first or try a different hostname.";
  const { cf } = scripted({ status: 409, body: { success: false, errors: [{ code: 100117, message: msg }], messages: [], result: null } });
  await rejects(cf.attachCustomDomain({ hostname: 'example.com', service: 's', zone_id: ZONE }), (e) => {
    assert.equal(e.status, 409);
    assert.deepEqual(e.codes, [100117]);
    assert.equal(e.message, msg + ' (code 100117)');
    assert.equal(e.name, 'CfError');
    assert.ok(isConflict(e));
  });
});

test('nested error_chain details are kept, so a token problem says what is wrong', async () => {
  const { cf } = scripted({ status: 400, body: { success: false, errors: [{ code: 6003, message: 'Invalid request headers',
    error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }] }] } });
  await rejects(cf.getSslMode(ZONE), (e) => {
    assert.deepEqual(e.codes, [6003, 6111]);
    assert.equal(e.message, 'Invalid request headers (code 6003); Invalid format for Authorization header (code 6111)');
  });
});

test('success: false fails even with HTTP 200; no errors listed still gives a plain message', async () => {
  const { cf } = scripted(
    { status: 200, body: { success: false, errors: [{ code: 1000, message: 'Something broke' }] } },
    { status: 500, body: {} },
  );
  await rejects(cf.getSslMode(ZONE), (e) => {
    assert.equal(e.status, 200);
    assert.equal(e.message, 'Something broke (code 1000)');
  });
  await rejects(cf.getSslMode(ZONE), (e) => {
    assert.equal(e.status, 500);
    assert.deepEqual(e.codes, []);
    assert.equal(e.message, 'Cloudflare answered HTTP 500.');
  });
});

test('a body that is not JSON, a redirect, or no answer at all is a CfError too', async () => {
  const { cf, seen } = scripted(
    { status: 502, body: '<html>Bad gateway</html>' },
    { status: 302, body: '', headers: { location: 'https://elsewhere.example/' } },
    new TypeError('fetch failed'),
  );
  await rejects(cf.getSslMode(ZONE), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /HTTP 502 without JSON/);
  });
  await rejects(cf.getSslMode(ZONE), (e) => assert.equal(e.status, 302));
  assert.equal(seen.length, 2, 'the redirect was not followed');
  assert.equal(seen[1].init.redirect, 'manual');
  await rejects(cf.getSslMode(ZONE), (e) => {
    assert.equal(e.status, 0);
    assert.equal(e.message, 'Could not reach Cloudflare: fetch failed');
  });
  for (const s of seen) assert.ok(!JSON.stringify(s.url).includes(TOKEN));
});

test('DELETE dns_records answers with only { result: { id } }, and that counts as done', async () => {
  const { cf } = scripted({ status: 200, body: { result: { id: 'abc' } } });
  await cf.deleteDnsRecord(ZONE, 'abc');
});

test('findZone walks up the hostname to the zone our account holds', async () => {
  const { fake, cf } = setup({ zones: [{ id: 'z-uk', name: 'example.co.uk' }] });
  assert.deepEqual(await cf.findZone('www.example.co.uk'), {
    id: 'z-uk', name: 'example.co.uk', status: 'active', paused: false,
    type: 'full', plan: 'free', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
  });
  assert.deepEqual(fake.calls.map((c) => c.query.name), ['www.example.co.uk', 'example.co.uk']);

  fake.calls.length = 0;
  assert.equal(await cf.findZone('shop.other.co.uk'), null);
  assert.deepEqual(fake.calls.map((c) => c.query.name), ['shop.other.co.uk', 'other.co.uk', 'co.uk'],
    'stops at two labels, never asks for a bare TLD');
});

test('findZone reports pending and paused zones as they are, and ignores zones on other accounts', async () => {
  const { cf } = setup({ zones: [
    { id: 'z1', name: 'pending.com', status: 'pending' },
    { id: 'z2', name: 'paused.com', paused: true },
    { id: 'z3', name: 'theirs.com', account_id: 'someone-else' },
  ] });
  assert.equal((await cf.findZone('pending.com')).status, 'pending');
  assert.equal((await cf.findZone('www.paused.com')).paused, true);
  assert.equal(await cf.findZone('theirs.com'), null);
});

test('findZone does not take a zone whose name only looks close', async () => {
  const { cf } = scripted(
    { body: { success: true, result: [{ id: 'x', name: 'notexample.com', status: 'active' }] } },
    { body: { success: true, result: [] } },
  );
  assert.equal(await cf.findZone('example.com'), null);
});

test('findZone also says what kind of zone it is, its plan and the nameservers Cloudflare assigned', async () => {
  const { cf } = setup({ zones: [
    { id: 'z1', name: 'pro.com', plan: 'pro', name_servers: ['Ada.NS.Cloudflare.com.', 'bob.ns.cloudflare.com'] },
    { id: 'z2', name: 'partial.com', type: 'partial', plan: 'business' },
    { id: 'z3', name: 'custom.com', plan: { id: 'p', name: 'Some Contract Plan' } },
    { id: 'z4', name: 'noplan.com', plan: null },
  ] });
  const pro = await cf.findZone('www.pro.com');
  assert.equal(pro.type, 'full');
  assert.equal(pro.plan, 'pro');
  assert.deepEqual(pro.name_servers, ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], 'lower case, no trailing dot');
  const partial = await cf.findZone('partial.com');
  assert.deepEqual([partial.type, partial.plan], ['partial', 'business']);
  assert.equal((await cf.findZone('custom.com')).plan, 'Some Contract Plan', 'no legacy id: the plan keeps its own name');
  assert.equal((await cf.findZone('noplan.com')).plan, null);
});

test('findZone copes with a zone that leaves out its type, plan or nameservers', async () => {
  const { cf } = scripted(
    { body: { success: true, result: [{ id: 'z', name: 'example.com', status: 'active', plan: { legacy_id: 'Enterprise', name: 'Enterprise Website' } }] } },
    { body: { success: true, result: [{ id: 'z', name: 'example.com', status: 'pending', name_servers: 'not a list' }] } },
  );
  assert.deepEqual(await cf.findZone('example.com'),
    { id: 'z', name: 'example.com', status: 'active', paused: false, type: null, plan: 'enterprise', name_servers: [] });
  const odd = await cf.findZone('example.com');
  assert.deepEqual([odd.plan, odd.name_servers], [null, []]);
});

test('DNS listing keeps only records named exactly the host, whatever the server sends', async () => {
  const records = ['www.example.com', 'WWW.Example.com', 'xwww.example.com', 'example.com', 'a.www.example.com']
    .map((name, i) => ({ id: 'r' + i, type: 'A', name, content: '192.0.2.' + i }));
  const { cf } = scripted({ body: { success: true, result: records, result_info: { page: 1, total_pages: 1 } } });
  assert.deepEqual((await cf.listDnsRecords(ZONE, 'www.example.com')).map((r) => r.id), ['r0', 'r1']);
});

test('DNS listing follows every page', async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ type: 'A', name: 'example.com', content: `10.0.${i >> 8}.${i & 255}` }));
  const { fake, cf } = setup({ records: [...many, { type: 'A', name: 'www.example.com', content: '192.0.2.1' }] });
  const list = await cf.listDnsRecords(ZONE, 'example.com');
  assert.equal(list.length, 130);
  assert.equal(new Set(list.map((r) => r.id)).size, 130);
  assert.deepEqual(fake.calls.map((c) => c.query.page), [undefined, '2']);
});

test('the whole zone is listed 5,000 records a page, every name and type', async () => {
  const many = Array.from({ length: 5001 }, (_, i) => ({ type: 'A', name: `h${i}.example.com`, content: '192.0.2.1' }));
  const { fake, cf } = setup({
    records: [...many,
      { type: 'MX', name: 'example.com', content: 'mx.example.net', priority: 10 },
      { type: 'TXT', name: 'example.com', content: 'v=spf1 -all' }],
    domains: [{ hostname: 'example.com', service: 'acme' }],
  });
  const list = await cf.listZoneRecords(ZONE);
  assert.equal(list.length, 5004);
  assert.equal(new Set(list.map((r) => r.id)).size, 5004);
  assert.deepEqual(fake.calls.map((c) => c.query), [{ per_page: '5000' }, { per_page: '5000', page: '2' }]);
  assert.deepEqual(list.filter((r) => r.name === 'example.com').map((r) => r.type).sort(), ['AAAA', 'MX', 'TXT']);
  assert.ok(list.find((r) => r.type === 'AAAA').meta.read_only, 'the Worker record comes as Cloudflare lists it');
});

const page = (n, of, result = [{ id: 'r' + n }]) => ({ body: { success: true, result, result_info: { page: n, total_pages: of } } });

test('the zone listing follows total_pages, up to twenty pages', async () => {
  const { cf, seen } = scripted(page(1, 3), page(2, 3), page(3, 3));
  assert.deepEqual((await cf.listZoneRecords(ZONE)).map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(seen.map((s) => new URL(s.url).searchParams.get('page')), [null, '2', '3']);

  const empty = scripted({ body: { success: true, result: null } });
  assert.deepEqual(await empty.cf.listZoneRecords(ZONE), [], 'no result_info and no result is an empty zone');

  const twenty = scripted(...Array.from({ length: 20 }, (_, i) => page(i + 1, 20)));
  assert.equal((await twenty.cf.listZoneRecords(ZONE)).length, 20);
});

test('a listing stops at an empty page, and a zone of more than twenty pages is refused after the first', async () => {
  // One odd answer must not spend every call the request has.
  const b = budget();
  const odd = async () => Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1e9 } });
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: countedFetch(odd, b) });
  assert.deepEqual(await cf.listZoneRecords(ZONE), []);
  assert.equal(b.used, 1);

  const short = scripted(page(1, 3), page(2, 3, []), page(3, 3));
  assert.deepEqual((await short.cf.listZoneRecords(ZONE)).map((r) => r.id), ['r1']);
  assert.equal(short.seen.length, 2, 'the empty second page ends it');

  const huge = scripted(page(1, 21), page(2, 21));
  await rejects(huge.cf.listZoneRecords(ZONE), (e) => {
    assert.equal(e.status, 0);
    assert.match(e.message, /too large to read in one go/);
  });
  assert.equal(huge.seen.length, 1);
  const host = scripted(page(1, 1e9));
  await rejects(host.cf.listDnsRecords(ZONE, 'example.com'), (e) => assert.match(e.message, /too large to read in one go/));
});

// An id goes into a URL path. new URL() takes '..' (and %2e%2e) as a step
// up, so a rule id of '..' would turn "delete this rule" into a call on the
// whole ruleset, and a domain id could reach any path in the account.
test('an id that is not a plain id is refused before anything is sent', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(`${init.method} ${new URL(url).pathname}`);
    return Response.json({ success: true, result: [] });
  };
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl });
  const rec = { type: 'A', name: 'example.com', content: '192.0.2.1', ttl: 1 };
  const odd = ['..', '.', '%2e%2e', '../scripts/website-dashboard', 'abc?x=1', 'a/b', 'a b', '', 'x'.repeat(65), 'é', undefined, null, 42];
  for (const id of odd) {
    const refused = (e) => {
      assert.equal(e.status, 0);
      assert.deepEqual(e.codes, []);
      assert.equal(e.message, `Refused an odd id from Cloudflare: ${id}.`);
    };
    for (const attempt of [
      () => cf.deleteRedirectRule(ZONE, 'rs1', id),
      () => cf.deleteRedirectRule(ZONE, id, 'r1'),
      () => cf.deleteRedirectRule(id, 'rs1', 'r1'),
      () => cf.detachCustomDomain(id),
      () => cf.deleteDnsRecord(ZONE, id),
      () => cf.deleteDnsRecord(id, 'd1'),
      () => cf.createDnsRecord(id, rec),
      () => cf.listDnsRecords(id, 'example.com'),
      () => cf.listZoneRecords(id),
      () => cf.listWorkerRoutes(id),
      () => cf.getSslMode(id),
      () => cf.getRedirectEntrypoint(id),
      () => cf.findRedirectRules(id, 'desk-1'),
      () => cf.addRedirectRule(id, redirectRule('desk-1')),
      () => cf.listSecretNames(id),
    ]) await rejects(attempt(), refused);
  }
  for (const script of ['-acme', '_acme', 'a'.repeat(64), 'acme.old']) {
    await rejects(cf.listSecretNames(script), (e) => assert.equal(e.message, `Refused an odd id from Cloudflare: ${script}.`));
  }
  assert.deepEqual(sent, []);

  // Ids as Cloudflare makes them pass: 32 or 40 hex characters, and names.
  await cf.detachCustomDomain('c'.repeat(40));
  await cf.listSecretNames('staging-acme_2');
  await cf.deleteRedirectRule(ZONE, 'a'.repeat(32), 'b'.repeat(64));
  assert.equal(sent.length, 3);
});

test('a ruleset id in Cloudflare\'s own answer is checked too, before the rule is sent to it', async () => {
  const { cf, seen } = scripted({ body: { success: true, result: { id: '..', rules: [] } } });
  await rejects(cf.addRedirectRule(ZONE, redirectRule('desk-1')), (e) => assert.match(e.message, /^Refused an odd id from Cloudflare: \.\.\.$/));
  assert.equal(seen.length, 1, 'only the look');
});

test('Worker routes are listed for one zone, as id, pattern and script', async () => {
  const { fake, cf } = setup({
    zones: [{ id: ZONE, name: 'example.com' }, { id: 'z2', name: 'other.com' }],
    routes: [
      { id: 'rt1', pattern: 'example.com/*', script: 'old-site' },
      { id: 'rt2', pattern: '*.example.com/blog/*' },
      { id: 'rt3', pattern: 'other.com/*', script: 'other' },
    ],
  });
  assert.deepEqual(await cf.listWorkerRoutes(ZONE), [
    { id: 'rt1', pattern: 'example.com/*', script: 'old-site' },
    { id: 'rt2', pattern: '*.example.com/blog/*', script: null },
  ]);
  assert.deepEqual(await cf.listWorkerRoutes('z2'), [{ id: 'rt3', pattern: 'other.com/*', script: 'other' }]);
  assert.ok(fake.state.workers.has('old-site'), 'a route\'s Worker exists');
  assert.throws(() => createFakeCloudflare({ routes: [{ pattern: 'nowhere.com/*', script: 'x' }] }), /no zone for route/);

  const extra = scripted({ body: { success: true, result: [{ id: 'r', pattern: 'a.example.com/*', script: 's', request_limit_fail_open: true }] } });
  assert.deepEqual(await extra.cf.listWorkerRoutes(ZONE), [{ id: 'r', pattern: 'a.example.com/*', script: 's' }]);
});

test('recreating a record sends only the fields it is made from, never the read-only ones', async () => {
  const { fake, cf } = setup({ records: [{
    type: 'A', name: 'old.example.com', content: '192.0.2.10', proxied: false, ttl: 3600,
    comment: 'Old host', tags: ['owner:tbox'], private_routing: true,
  }] });
  const [rec] = await cf.listDnsRecords(ZONE, 'old.example.com');
  for (const k of ['id', 'proxiable', 'created_on', 'modified_on', 'meta', 'comment_modified_on', 'tags_modified_on']) {
    assert.ok(k in rec, 'the listing has ' + k);
  }
  await cf.deleteDnsRecord(ZONE, rec.id);
  const made = await cf.createDnsRecord(ZONE, rec);
  assert.deepEqual(fake.calls.at(-1).body, {
    type: 'A', name: 'old.example.com', content: '192.0.2.10', ttl: 3600, proxied: false,
    comment: 'Old host', tags: ['owner:tbox'], private_routing: true,
  });
  assert.notEqual(made.id, rec.id, 'Cloudflare gives it a new id');
  for (const k of ['type', 'name', 'content', 'ttl', 'proxied', 'comment', 'tags', 'settings', 'private_routing']) {
    assert.deepEqual(made[k], rec[k], k);
  }
});

test('empty comment, tags and settings, and private_routing false, are left out', async () => {
  const { fake, cf } = setup();
  await cf.createDnsRecord(ZONE, {
    id: 'old', type: 'CNAME', name: 'www.example.com', content: 'host.example.net', ttl: 1, proxied: true,
    comment: '', tags: [], settings: {}, private_routing: false, meta: { read_only: false }, proxiable: true,
    zone_id: ZONE, zone_name: 'example.com', created_on: 'x', modified_on: 'y',
  });
  assert.deepEqual(fake.calls.at(-1).body,
    { type: 'CNAME', name: 'www.example.com', content: 'host.example.net', ttl: 1, proxied: true });
});

test('a recreated record carries only the settings that are on, and only where they apply', async () => {
  const { fake, cf } = setup();
  const cases = [
    // [record, the settings sent]
    [{ type: 'CNAME', proxied: true, settings: { flatten_cname: false } }, undefined],
    [{ type: 'CNAME', proxied: true, settings: { flatten_cname: true, ipv4_only: true } }, { ipv4_only: true }],
    [{ type: 'CNAME', proxied: false, settings: { flatten_cname: true, ipv6_only: true } }, { flatten_cname: true }],
    [{ type: 'A', proxied: false, settings: { ipv4_only: false, ipv6_only: false } }, undefined],
    [{ type: 'A', proxied: false, settings: { ipv4_only: true } }, undefined],
    [{ type: 'A', settings: { ipv6_only: true } }, undefined],
    [{ type: 'A', proxied: true, settings: { ipv4_only: true, ipv6_only: false } }, { ipv4_only: true }],
    [{ type: 'AAAA', proxied: true, settings: { ipv6_only: true } }, { ipv6_only: true }],
    [{ type: 'A', proxied: true, settings: { ipv4_only: 'yes' } }, undefined],
    [{ type: 'A', proxied: true, settings: null }, undefined],
    [{ type: 'A', proxied: true, settings: 'ipv4_only' }, undefined],
  ];
  for (const [i, [rec, sent]] of cases.entries()) {
    const content = { CNAME: `host${i}.example.net`, A: `192.0.2.${i}`, AAAA: `2001:db8::${i}` }[rec.type];
    // The fake refuses a setting where it does not apply, so each create
    // passing is the proof.
    await cf.createDnsRecord(ZONE, { ...rec, name: `r${i}.example.com`, content, ttl: 1 });
    assert.deepEqual(fake.calls.at(-1).body.settings, sent, JSON.stringify(rec));
  }
});

test('a proxied CNAME listed with flatten_cname off goes back without it', async () => {
  const { cf } = setup({ records: [
    { type: 'CNAME', name: 'www.example.com', content: 'host.example.net', proxied: true, settings: { flatten_cname: false } },
    { type: 'A', name: 'ftp.example.com', content: '192.0.2.7', settings: { ipv4_only: false, ipv6_only: false } },
  ] });
  for (const rec of await cf.listZoneRecords(ZONE)) {
    await cf.deleteDnsRecord(ZONE, rec.id);
    const made = await cf.createDnsRecord(ZONE, rec);
    assert.deepEqual([made.type, made.name, made.content, made.proxied], [rec.type, rec.name, rec.content, rec.proxied]);
  }
});

test('the redirect entry point is null until the zone has one; other errors still throw', async () => {
  const { fake, cf } = setup();
  assert.equal(await cf.getRedirectEntrypoint(ZONE), null);
  assert.deepEqual(await cf.findRedirectRules(ZONE, 'desk-1'), []);
  fake.failOn('GET', ENTRYPOINT, { status: 403, codes: [10000], message: 'Authentication error', times: 1 });
  await rejects(cf.getRedirectEntrypoint(ZONE), (e) => assert.equal(e.status, 403));
});

test('the first redirect rule creates the entry point with a POST, never a PUT', async () => {
  const { fake, cf } = setup();
  const rule = redirectRule('desk-1');
  const added = await cf.addRedirectRule(ZONE, rule);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path]), [
    ['GET', ENTRYPOINT],
    ['POST', `/zones/${ZONE}/rulesets`],
  ]);
  assert.deepEqual(fake.calls[1].body,
    { name: 'Redirect rules ruleset', kind: 'zone', phase: 'http_request_dynamic_redirect', rules: [rule] });
  const [saved] = fake.redirectRules(ZONE);
  assert.deepEqual(added, { ruleset_id: fake.state.rulesets[0].id, rule_id: saved.id, ref: 'desk-1' });
  assert.equal(saved.expression, '(http.host eq "www.example.com")');
});

test('a later redirect rule is appended and the zone keeps its other rules', async () => {
  const { fake, cf } = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs-1'), otherRule('theirs-2')] }] });
  const added = await cf.addRedirectRule(ZONE, redirectRule('desk-1'));
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path]), [
    ['GET', ENTRYPOINT],
    ['POST', `/zones/${ZONE}/rulesets/rs1/rules`],
  ]);
  assert.deepEqual(fake.calls[1].body, redirectRule('desk-1'), 'only the one rule is sent');
  assert.deepEqual(fake.redirectRules(ZONE).map((r) => r.ref), ['theirs-1', 'theirs-2', 'desk-1']);
  assert.equal(added.rule_id, fake.redirectRules(ZONE)[2].id);
  assert.equal(added.ruleset_id, 'rs1');
});

test('the new rule is found by its ref, wherever it sits in the answer', async () => {
  const { cf } = scripted(
    { body: { success: true, result: { id: 'rs1', rules: [{ id: 'r-theirs', ref: 'theirs' }] } } },
    { body: { success: true, result: { id: 'rs1', rules: [{ id: 'r-new', ref: 'desk-1' }, { id: 'r-theirs', ref: 'theirs' }] } } },
  );
  assert.deepEqual(await cf.addRedirectRule(ZONE, redirectRule('desk-1')), { ruleset_id: 'rs1', rule_id: 'r-new', ref: 'desk-1' });
});

test('an answer without the new rule is an error, not a guess, once a fresh look does not show it either', async () => {
  const theirs = { body: { success: true, result: { id: 'rs1', rules: [{ id: 'r-theirs', ref: 'theirs' }] } } };
  const { cf, seen } = scripted({ body: { success: true, result: { id: 'rs1', rules: [] } } }, theirs, theirs);
  await assert.rejects(cf.addRedirectRule(ZONE, redirectRule('desk-1')), /desk-1 was not in Cloudflare's answer/);
  assert.deepEqual(seen.map((s) => s.init.method), ['GET', 'POST', 'GET']);
});

test('if the entry point appears between the look and the create, the rule is added to it', async () => {
  const { fake, cf } = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs')] }] });
  // The first look misses it, as if someone else created it a moment later.
  fake.failOn('GET', ENTRYPOINT, { status: 404, codes: [10003], message: 'could not find entrypoint ruleset', times: 1 });
  const added = await cf.addRedirectRule(ZONE, redirectRule('desk-1'));
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path]), [
    ['GET', ENTRYPOINT],
    ['POST', `/zones/${ZONE}/rulesets`],
    ['GET', ENTRYPOINT],
    ['POST', `/zones/${ZONE}/rulesets/rs1/rules`],
  ]);
  assert.equal(added.ruleset_id, 'rs1');
  assert.deepEqual(fake.redirectRules(ZONE).map((r) => r.ref), ['theirs', 'desk-1']);
  assert.ok(!fake.calls.some((c) => c.method === 'PUT'));
});

test('a create that fails for its own reason reports that reason', async () => {
  const { fake, cf } = setup();
  fake.failOn('POST', `/zones/${ZONE}/rulesets`, { status: 403, codes: [10000], message: 'Authentication error' });
  await rejects(cf.addRedirectRule(ZONE, redirectRule('desk-1')), (e) => {
    assert.equal(e.status, 403);
    assert.deepEqual(e.codes, [10000]);
  });
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'POST', 'GET']);

  // The same for an added rule: one look after the failure, then its reason.
  const later = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs')] }] });
  later.fake.failOn('POST', `/zones/${ZONE}/rulesets/rs1/rules`, { status: 400, codes: [20021], message: 'too many rules' });
  await rejects(later.cf.addRedirectRule(ZONE, redirectRule('desk-1')), (e) => assert.deepEqual(e.codes, [20021]));
  assert.deepEqual(later.fake.calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  // If that look cannot be had either, the POST's own error still says why.
  let looks = 0;
  const blind = async (url, init) => (init.method === 'GET' && ++looks > 1
    ? Response.json({ success: false, errors: [{ code: 10001, message: 'Look failed.' }] }, { status: 503 })
    : later.fake.fetch(url, init));
  const unseeing = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: blind });
  await rejects(unseeing.addRedirectRule(ZONE, redirectRule('desk-1')), (e) => assert.deepEqual(e.codes, [20021]));
  assert.equal(looks, 2);
});

// Cloudflare made the rule, but its answer never came (a timeout near the
// run's deadline, a dropped connection). Asking again by ref finds it, so
// the desk can record it, and there is never a second rule with that ref.
test('a redirect rule whose answer was lost is found by its ref, never added twice', async () => {
  for (const rulesets of [[], [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs')] }]]) {
    const { fake } = setup({ rulesets });
    let drop = true;
    const lossy = async (url, init) => {
      const res = await fake.fetch(url, init);
      if (drop && init.method === 'POST') {
        drop = false;
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return res;
    };
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: lossy });
    const added = await cf.addRedirectRule(ZONE, redirectRule('desk-1'));
    const ours = fake.redirectRules(ZONE).filter((r) => r.ref === 'desk-1');
    assert.equal(ours.length, 1);
    assert.deepEqual(added, { ruleset_id: fake.state.rulesets[0].id, rule_id: ours[0].id, ref: 'desk-1' });
    assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'POST', 'GET'], 'one POST, then a look');

    // Asked again, it answers the same rule and sends nothing new.
    fake.calls.length = 0;
    assert.deepEqual(await cf.addRedirectRule(ZONE, redirectRule('desk-1')), added);
    assert.deepEqual(fake.calls.map((c) => c.method), ['GET']);
    assert.equal(fake.redirectRules(ZONE).filter((r) => r.ref === 'desk-1').length, 1);
  }
});

test('a failed POST whose rule did land anyway answers that rule', async () => {
  const { fake, cf } = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs')] }] });
  // A 502 from the edge after Cloudflare had saved the rule.
  const lands = (fetchImpl) => async (url, init) => {
    const res = await fetchImpl(url, init);
    return init.method === 'POST' ? Response.json({ success: false, errors: [{ code: 10013, message: 'Bad gateway' }] }, { status: 502 }) : res;
  };
  const flaky = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: lands(fake.fetch) });
  const added = await flaky.addRedirectRule(ZONE, redirectRule('desk-1'));
  assert.equal(added.rule_id, (await cf.findRedirectRules(ZONE, 'desk-1'))[0].rule_id);
  assert.equal(fake.redirectRules(ZONE).length, 2);
});

test('the desk finds and removes its own rule by ref and leaves the others', async () => {
  const { fake, cf } = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs'), redirectRule('desk-7')] }] });
  const found = await cf.findRedirectRules(ZONE, 'desk-7');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { ruleset_id: 'rs1', rule_id: fake.redirectRules(ZONE)[1].id, ref: 'desk-7' });
  await cf.deleteRedirectRule(ZONE, found[0].ruleset_id, found[0].rule_id);
  assert.deepEqual(fake.redirectRules(ZONE).map((r) => r.ref), ['theirs']);
  assert.deepEqual(await cf.findRedirectRules(ZONE, 'desk-7'), []);
});

test('Custom Domains are listed with exact filters, even if the server matches loosely', async () => {
  const { cf } = scripted({ body: { success: true, result: [
    { id: 'c1', hostname: 'example.com', service: 'acme', zone_id: ZONE, zone_name: 'example.com', environment: 'production', cert_id: 'x' },
    { id: 'c2', hostname: 'www.example.com', service: 'acme', zone_id: ZONE, zone_name: 'example.com' },
  ] } });
  assert.deepEqual(await cf.listCustomDomains({ hostname: 'Example.com' }),
    [{ id: 'c1', hostname: 'example.com', service: 'acme', zone_id: ZONE, zone_name: 'example.com' }]);
});

test('secret names come back, never their values', async () => {
  const { cf } = scripted({ body: { success: true, result: [
    { name: 'RESEND_KEY', type: 'secret_text', text: 'value-that-must-not-leak' },
    { name: 'TURNSTILE_SECRET', type: 'secret_text' },
  ] } });
  const names = await cf.listSecretNames('acme');
  assert.deepEqual(names, ['RESEND_KEY', 'TURNSTILE_SECRET']);
  assert.ok(!JSON.stringify(names).includes('value-that-must-not-leak'));
});

test('SSL mode is read as Cloudflare names it', async () => {
  const { cf } = setup({ zones: [{ id: 'z1', name: 'a.com' }, { id: 'z2', name: 'b.com' }], sslMode: { z1: 'strict' } });
  assert.equal(await cf.getSslMode('z1'), 'strict');
  assert.equal(await cf.getSslMode('z2'), 'full');
  const flexible = setup({ sslMode: 'flexible' });
  assert.equal(await flexible.cf.getSslMode(ZONE), 'flexible');
});

test('isConflict knows the Custom Domain and DNS record clashes; isNotFound is a 404', () => {
  const err = (status, codes, message = '') => new CfError(status, codes, message);
  assert.ok(isConflict(err(409, [])));
  assert.ok(isConflict(err(400, [100117])));
  assert.ok(isConflict(err(400, [81053])));
  assert.ok(isConflict(err(400, [81057])));
  assert.ok(isConflict(err(400, [81058])));
  assert.ok(isConflict(err(400, [], 'An A, AAAA, or CNAME record with that host already exists.')));
  assert.ok(isConflict(err(400, [], "Hostname 'x' already has externally managed DNS records (A, CNAME, etc).")));
  assert.ok(isConflict({ status: 400, message: 'Conflicts with an existing DNS record' }), 'works without the class');
  assert.ok(!isConflict(err(400, [1004], 'DNS Validation Error')));
  assert.ok(!isConflict(err(404, [81044], 'Record does not exist.')));
  assert.ok(!isConflict(null));

  assert.ok(isNotFound(err(404, [81044])));
  assert.ok(!isNotFound(err(400, [7003])));
  assert.ok(!isNotFound(undefined));
});

// --- Time and calls ---

// Records the wait of every timeout the client asks for, and can shorten
// the real one, so a ten-second timeout can be seen without waiting for it.
function spyTimeouts(t, shortenTo) {
  const real = AbortSignal.timeout;
  const waits = [];
  AbortSignal.timeout = (ms) => {
    waits.push(ms);
    return real.call(AbortSignal, shortenTo ?? ms);
  };
  t.after(() => { AbortSignal.timeout = real; });
  return waits;
}

// A fetch that never answers until its signal gives up. Node does not keep
// itself running for a timeout alone, so the test holds a timer of its own.
function hanging(t) {
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  const seen = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    seen.push(url);
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  return { fetchImpl, seen };
}

const outOfTime = (e) => {
  assert.equal(e.status, 0);
  assert.deepEqual(e.codes, []);
  assert.match(e.message, /^Ran out of time/);
};

test('at or past the deadline nothing is sent, and the error says the run ran out of time', async () => {
  const { fake } = setup();
  const b = budget();
  for (const deadline of [Date.now() - 1000, Date.now()]) {
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: countedFetch(fake.fetch, b), deadline });
    await rejects(cf.getSslMode(ZONE), outOfTime);
    await rejects(cf.listZoneRecords(ZONE), outOfTime);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(b.used, 0, 'and no call is counted');
});

test('each call waits ten seconds at most, and never past the deadline', async (t) => {
  const waits = spyTimeouts(t);
  const { fake } = setup();
  const client = (deadline) => cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: fake.fetch, deadline });
  await client().getSslMode(ZONE);
  await client(Date.now() + 60000).getSslMode(ZONE);
  await client(Date.now() + 3000).getSslMode(ZONE);
  await client(Date.now() + 2500.2).getSslMode(ZONE);
  assert.deepEqual(waits.slice(0, 2), [10000, 10000]);
  assert.ok(waits[2] > 2900 && waits[2] <= 3000, 'what is left: ' + waits[2]);
  assert.ok(Number.isInteger(waits[3]) && waits[3] <= 2501, 'a whole number of ms, as AbortSignal.timeout needs');
});

test('a call still waiting at the deadline is cut off there', async (t) => {
  const { fetchImpl, seen } = hanging(t);
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl, deadline: Date.now() + 50 });
  const started = Date.now();
  await rejects(cf.getSslMode(ZONE), outOfTime);
  assert.ok(Date.now() - started < 2000, 'at the deadline, not ten seconds later');
  assert.equal(seen.length, 1);
});

test('the ten-second timeout, with no deadline near, is Cloudflare out of reach', async (t) => {
  const waits = spyTimeouts(t, 20);
  const { fetchImpl } = hanging(t);
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl, deadline: Date.now() + 60000 });
  await rejects(cf.getSslMode(ZONE), (e) => {
    assert.equal(e.status, 0);
    assert.match(e.message, /^Could not reach Cloudflare: .*timeout/);
  });
  assert.deepEqual(waits, [10000]);
});

test('the deadline also covers reading the answer', async (t) => {
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  const slowBody = async (url, init) => new Response(new ReadableStream({
    start(c) { init.signal.addEventListener('abort', () => c.error(init.signal.reason)); },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: slowBody, deadline: Date.now() + 50 });
  await rejects(cf.getSslMode(ZONE), outOfTime);
});

test('a run that reaches its deadline part-way stops before the next call', async () => {
  const seen = [];
  // The first page arrives late (after the deadline) but whole.
  const fetchImpl = async (url) => {
    seen.push(url);
    await new Promise((r) => setTimeout(r, 60));
    return Response.json({ success: true, result: [{ id: 'r1' }], result_info: { page: 1, total_pages: 2 } });
  };
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl, deadline: Date.now() + 30 });
  await rejects(cf.listZoneRecords(ZONE), outOfTime);
  assert.equal(seen.length, 1, 'the second page was never asked for');
});

test('a request that has used its calls gets a BudgetError, not a Cloudflare error', async () => {
  const { fake } = setup({ records: Array.from({ length: 101 }, (_, i) => ({ type: 'A', name: 'example.com', content: '10.0.0.' + i })) });
  const b = budget(2);
  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: countedFetch(fake.fetch, b) });
  await cf.getSslMode(ZONE);
  await cf.getSslMode(ZONE);
  await assert.rejects(cf.getSslMode(ZONE), (e) => {
    assert.ok(e instanceof BudgetError, 'passed up unchanged');
    assert.ok(!(e instanceof CfError));
    assert.equal(e.message, 'The desk has used its Cloudflare calls for this request.');
    return true;
  });
  assert.equal(fake.calls.length, 2, 'the refused call never went out');

  // 101 records are two pages of 100: with one call left, the listing stops
  // after the first rather than answering with half the records.
  fake.calls.length = 0;
  const paging = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: countedFetch(fake.fetch, budget(1)) });
  await assert.rejects(paging.listDnsRecords(ZONE, 'example.com'), BudgetError);
  assert.equal(fake.calls.length, 1);
});

// --- The fake, so the go-live tests can trust it ---

test('fake: a zone is found by exact name within our account', async () => {
  const { fake } = setup({ zones: [{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'example.com', account_id: 'other' }] });
  const get = async (q) => (await (await fake.fetch(`${API}/zones?${q}`, { headers: { authorization: 'Bearer t' } })).json()).result;
  assert.deepEqual((await get(`name=example.com&account.id=${ACCOUNT}`)).map((z) => z.id), ['z1']);
  assert.deepEqual((await get('name=example.co')).map((z) => z.id), []);
  assert.deepEqual((await get('name=EXAMPLE.com')).map((z) => z.id), ['z1', 'z2']);
});

test('fake: an unknown account is refused, as is a request with no token', async () => {
  const { fake } = setup();
  const stranger = cloudflare({ token: TOKEN, accountId: 'not-ours', fetchImpl: fake.fetch });
  await rejects(stranger.listCustomDomains({}), (e) => {
    assert.equal(e.status, 403);
    assert.deepEqual(e.codes, [10000]);
  });
  const res = await fake.fetch(`${API}/zones`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors[0].code, 9106);
});

test('fake: a CNAME cannot share a name with A, AAAA or CNAME; an A/AAAA cannot share with a CNAME', async () => {
  const { cf } = setup({ records: [
    { type: 'A', name: 'a.example.com', content: '192.0.2.1' },
    { type: 'CNAME', name: 'c.example.com', content: 'host.example.net' },
    { type: 'AAAA', name: 'six.example.com', content: '2001:db8::1' },
  ] });
  const clash = (e) => {
    assert.equal(e.status, 400);
    assert.deepEqual(e.codes, [81053]);
    assert.ok(isConflict(e));
  };
  await rejects(cf.createDnsRecord(ZONE, { type: 'CNAME', name: 'a.example.com', content: 'x.example.net', ttl: 1 }), clash);
  await rejects(cf.createDnsRecord(ZONE, { type: 'CNAME', name: 'six.example.com', content: 'x.example.net', ttl: 1 }), clash);
  await rejects(cf.createDnsRecord(ZONE, { type: 'CNAME', name: 'c.example.com', content: 'y.example.net', ttl: 1 }), clash);
  await rejects(cf.createDnsRecord(ZONE, { type: 'A', name: 'C.example.com', content: '192.0.2.9', ttl: 1 }), clash);
  await rejects(cf.createDnsRecord(ZONE, { type: 'AAAA', name: 'c.example.com', content: '2001:db8::9', ttl: 1 }), clash);
  await rejects(cf.createDnsRecord(ZONE, { type: 'A', name: 'a.example.com', content: '192.0.2.1', ttl: 1 }), (e) => {
    assert.deepEqual(e.codes, [81057], 'an identical record');
    assert.ok(isConflict(e));
  });

  // What DNS does allow: several A records, A beside AAAA, TXT beside anything.
  await cf.createDnsRecord(ZONE, { type: 'A', name: 'a.example.com', content: '192.0.2.2', ttl: 1 });
  await cf.createDnsRecord(ZONE, { type: 'AAAA', name: 'a.example.com', content: '2001:db8::2', ttl: 1 });
  await cf.createDnsRecord(ZONE, { type: 'TXT', name: 'c.example.com', content: 'v=spf1 -all', ttl: 1 });
  assert.equal((await cf.listDnsRecords(ZONE, 'a.example.com')).length, 3);
});

test('fake: a setting where the docs say it does not apply is refused, even set to false', async () => {
  const { fake } = setup();
  const post = async (rec) => {
    const res = await fake.fetch(`${API}/zones/${ZONE}/dns_records`, {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 1, ...rec }),
    });
    return { status: res.status, body: await res.json() };
  };
  const cname = { type: 'CNAME', name: 'c.example.com', content: 'host.example.net' };
  const a = { type: 'A', name: 'a.example.com', content: '192.0.2.1' };
  for (const rec of [
    { ...cname, proxied: true, settings: { flatten_cname: true } },
    { ...cname, proxied: true, settings: { flatten_cname: false } },
    { ...a, proxied: false, settings: { ipv4_only: true } },
    { ...a, settings: { ipv4_only: false } },
    { ...a, type: 'AAAA', content: '2001:db8::1', proxied: false, settings: { ipv6_only: false } },
    { ...cname, proxied: false, settings: { flatten_cname: true, ipv4_only: true } },
  ]) {
    const { status, body } = await post(rec);
    assert.equal(status, 400, JSON.stringify(rec));
    assert.deepEqual(body.errors[0].code, 1004);
    assert.equal(body.errors[0].error_chain[0].code, 9041);
  }
  assert.equal(fake.state.records.length, 0);

  for (const rec of [
    { ...cname, proxied: false, settings: { flatten_cname: true } },
    { ...a, proxied: true, settings: { ipv4_only: true, ipv6_only: false } },
    { ...a, name: 'b.example.com', proxied: false, settings: {} },
    { ...a, name: 'd.example.com' },
  ]) {
    assert.equal((await post(rec)).status, 200, JSON.stringify(rec));
  }
  assert.deepEqual(fake.recordsAt('c.example.com')[0].settings, { flatten_cname: true });
});

test('fake: zones carry a type, a plan and their assigned nameservers', async () => {
  const { fake } = setup({ zones: [
    { id: 'z1', name: 'example.com' },
    { id: 'z2', name: 'pro.com', plan: 'pro', type: 'partial', name_servers: ['kim.ns.cloudflare.com', 'lee.ns.cloudflare.com'] },
  ] });
  const zone = async (name) => (await (await fake.fetch(`${API}/zones?name=${name}`, { headers: { authorization: 'Bearer t' } })).json()).result[0];
  const plain = await zone('example.com');
  assert.equal(plain.type, 'full');
  assert.deepEqual([plain.plan.legacy_id, plain.plan.name], ['free', 'Free Website']);
  assert.deepEqual(plain.name_servers, ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
  const pro = await zone('pro.com');
  assert.deepEqual([pro.type, pro.plan.legacy_id, pro.plan.name], ['partial', 'pro', 'Pro Website']);
  assert.deepEqual(pro.name_servers, ['kim.ns.cloudflare.com', 'lee.ns.cloudflare.com']);
});

test('fake: a DNS listing gives at most 5,000 records a page', async () => {
  const { fake } = setup({ records: Array.from({ length: 5002 }, (_, i) => ({ type: 'TXT', name: `t${i}.example.com`, content: 'x' })) });
  const list = async (q) => (await (await fake.fetch(`${API}/zones/${ZONE}/dns_records?${q}`, { headers: { authorization: 'Bearer t' } })).json());
  const big = await list('per_page=100000');
  assert.equal(big.result.length, 5000);
  assert.deepEqual([big.result_info.per_page, big.result_info.total_pages, big.result_info.total_count], [5000, 2, 5002]);
  assert.equal((await list('per_page=5000&page=2')).result.length, 2);
  assert.equal((await list('')).result.length, 100, '100 when not asked');
});

test('fake: bad record content fails validation, with the detail in error_chain', async () => {
  const { cf } = setup();
  await rejects(cf.createDnsRecord(ZONE, { type: 'A', name: 'x.example.com', content: 'not-an-ip', ttl: 1 }), (e) => {
    assert.deepEqual(e.codes, [1004, 9005]);
    assert.ok(!isConflict(e));
  });
});

test('fake: attaching a Custom Domain over an A record fails with 409 / 100117', async () => {
  const { fake, cf } = setup({ workers: ['staging-acme'], records: [
    { type: 'A', name: 'example.com', content: '192.0.2.10', proxied: true },
    { type: 'MX', name: 'example.com', content: 'mx.example.net', priority: 10 },
    { type: 'TXT', name: 'example.com', content: 'v=spf1 include:example.net -all' },
  ] });
  const attach = () => cf.attachCustomDomain({ hostname: 'example.com', service: 'staging-acme', zone_id: ZONE });
  await rejects(attach(), (e) => {
    assert.equal(e.status, 409);
    assert.deepEqual(e.codes, [100117]);
    assert.match(e.message, /already has externally managed DNS records/);
    assert.ok(isConflict(e));
  });
  assert.equal(fake.state.domains.length, 0);

  const [a] = (await cf.listDnsRecords(ZONE, 'example.com')).filter((r) => r.type === 'A');
  await cf.deleteDnsRecord(ZONE, a.id);
  const d = await attach();
  assert.deepEqual({ ...d, id: undefined },
    { id: undefined, hostname: 'example.com', service: 'staging-acme', zone_id: ZONE, zone_name: 'example.com' });
  assert.deepEqual((await attach()).id, d.id, 'attaching again to the same Worker changes nothing');

  const worker = (await cf.listDnsRecords(ZONE, 'example.com')).filter((r) => r.type === 'AAAA');
  assert.equal(worker.length, 1);
  assert.equal(worker[0].content, '100::');
  assert.equal(worker[0].proxied, true);
  assert.equal(worker[0].ttl, 1);
  assert.equal(worker[0].meta.read_only, true);
  assert.deepEqual(fake.recordsAt('example.com').map((r) => r.type).sort(), ['AAAA', 'MX', 'TXT'], 'MX and TXT untouched');
});

test('fake: nothing website-like can be created over, or delete, a Worker\'s own record', async () => {
  const { cf } = setup({ domains: [{ hostname: 'example.com', service: 'acme' }] });
  const [worker] = await cf.listDnsRecords(ZONE, 'example.com');
  assert.equal(worker.meta.read_only, true);
  await rejects(cf.createDnsRecord(ZONE, { type: 'A', name: 'example.com', content: '192.0.2.10', ttl: 1 }), (e) => {
    assert.deepEqual(e.codes, [81053]);
  });
  await rejects(cf.createDnsRecord(ZONE, { type: 'CNAME', name: 'example.com', content: 'x.example.net', ttl: 1 }),
    (e) => assert.ok(isConflict(e)));
  await rejects(cf.deleteDnsRecord(ZONE, worker.id), (e) => assert.equal(e.status, 400));
  await cf.createDnsRecord(ZONE, { type: 'TXT', name: 'example.com', content: 'google-site-verification=x', ttl: 1 });
});

test('fake: Custom Domains list by hostname, zone and Worker; one hostname has one Worker', async () => {
  const { cf } = setup({
    zones: [{ id: ZONE, name: 'example.com' }, { id: 'z2', name: 'other.com' }],
    workers: ['staging-acme'],
    domains: [
      { hostname: 'example.com', service: 'acme' },
      { hostname: 'staging.example.com', service: 'staging-acme' },
      { hostname: 'other.com', service: 'acme' },
    ],
  });
  assert.deepEqual((await cf.listCustomDomains({ hostname: 'staging.example.com' })).map((d) => d.service), ['staging-acme']);
  assert.deepEqual((await cf.listCustomDomains({ zone_id: ZONE })).map((d) => d.hostname), ['example.com', 'staging.example.com']);
  assert.deepEqual((await cf.listCustomDomains({ service: 'acme' })).map((d) => d.hostname), ['example.com', 'other.com']);
  assert.deepEqual(await cf.listCustomDomains({ hostname: 'nowhere.example.com' }), []);

  await rejects(cf.attachCustomDomain({ hostname: 'example.com', service: 'staging-acme', zone_id: ZONE }), (e) => {
    assert.equal(e.status, 409);
  });
  await rejects(cf.attachCustomDomain({ hostname: 'new.example.com', service: 'no-such-worker', zone_id: ZONE }), (e) => {
    assert.equal(e.status, 404);
    assert.deepEqual(e.codes, [10007]);
  });
});

test('fake: detaching removes the domain and its record at once by default', async () => {
  const { fake, cf } = setup({ domains: [{ hostname: 'example.com', service: 'acme' }] });
  const [d] = await cf.listCustomDomains({ hostname: 'example.com' });
  await cf.detachCustomDomain(d.id);
  assert.deepEqual(await cf.listCustomDomains({ zone_id: ZONE }), []);
  assert.deepEqual(await cf.listDnsRecords(ZONE, 'example.com'), []);
  await rejects(cf.detachCustomDomain(d.id), (e) => assert.ok(isNotFound(e)));
  assert.equal(fake.state.records.length, 0);
});

test('fake: with detachLag the Worker record lingers for that many more looks', async () => {
  const { fake, cf } = setup({ workers: ['staging-acme'], domains: [{ hostname: 'example.com', service: 'acme' }], detachLag: 3 });
  const [d] = await cf.listCustomDomains({ hostname: 'example.com' });
  await cf.detachCustomDomain(d.id);
  assert.deepEqual(await cf.listCustomDomains({ hostname: 'example.com' }), [], 'the domain itself goes at once');

  const [left] = await cf.listDnsRecords(ZONE, 'example.com');
  assert.equal(left.meta.read_only, true, 'first look: still there');
  await rejects(cf.createDnsRecord(ZONE, { type: 'A', name: 'example.com', content: '192.0.2.10', ttl: 1 }), (e) => {
    assert.deepEqual(e.codes, [81053], 'second look: a restore cannot put the old record back yet');
  });
  await rejects(cf.attachCustomDomain({ hostname: 'example.com', service: 'staging-acme', zone_id: ZONE }), (e) => {
    assert.deepEqual(e.codes, [100117], 'third look: nor can another Worker take the hostname');
  });
  assert.deepEqual(await cf.listDnsRecords(ZONE, 'example.com'), [], 'gone after three looks');
  assert.equal((await cf.attachCustomDomain({ hostname: 'example.com', service: 'staging-acme', zone_id: ZONE })).service, 'staging-acme');
  assert.equal(fake.recordsAt('example.com').length, 1);
});

test('fake: the redirect entry point is 404 until created, and only one per phase', async () => {
  const { fake, cf } = setup();
  const res = await fake.fetch(API + ENTRYPOINT, { headers: { authorization: 'Bearer t' } });
  assert.equal(res.status, 404);
  await cf.addRedirectRule(ZONE, redirectRule('desk-1'));
  const [created] = fake.state.rulesets;
  assert.equal(created.phase, 'http_request_dynamic_redirect');

  const again = await fake.fetch(`${API}/zones/${ZONE}/rulesets`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', kind: 'zone', phase: 'http_request_dynamic_redirect', rules: [] }),
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).errors[0].code, 20217);

  const dup = await fake.fetch(`${API}/zones/${ZONE}/rulesets/${created.id}/rules`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify(redirectRule('desk-1')),
  });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).errors[0].message, /ref 'desk-1' already exists/);
  await rejects(cf.addRedirectRule(ZONE, { ...redirectRule('desk-2'), action: 'block' }), (e) => assert.equal(e.status, 400));
  assert.equal(fake.redirectRules(ZONE).length, 1);
});

test('fake: a PUT on a ruleset fails loudly and changes nothing', async () => {
  const { fake } = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs')] }] });
  for (const path of [ENTRYPOINT, `/zones/${ZONE}/rulesets/rs1`]) {
    const res = await fake.fetch(API + path, {
      method: 'PUT',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [] }),
    });
    assert.ok(res.status >= 400, path);
  }
  assert.deepEqual(fake.redirectRules(ZONE).map((r) => r.ref), ['theirs']);
  assert.equal(fake.calls.filter((c) => c.method === 'PUT' && c.path.includes('/rulesets')).length, 2, 'and the log shows it');
});

test('fake: deleting a rule answers with the whole ruleset; a missing rule is a 404', async () => {
  const { fake, cf } = setup({ rulesets: [{ zone_id: ZONE, id: 'rs1', rules: [otherRule('theirs'), redirectRule('desk-1')] }] });
  const [mine] = await cf.findRedirectRules(ZONE, 'desk-1');
  const res = await fake.fetch(`${API}/zones/${ZONE}/rulesets/rs1/rules/${mine.rule_id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer t' },
  });
  const body = await res.json();
  assert.deepEqual(body.result.rules.map((r) => r.ref), ['theirs']);
  assert.equal(body.result.version, '2');
  await rejects(cf.deleteRedirectRule(ZONE, 'rs1', mine.rule_id), (e) => assert.ok(isNotFound(e)));
});

test('fake: secrets are listed by name for a known Worker; an unknown one is a 404', async () => {
  const { cf } = setup({ secrets: { acme: ['RESEND_KEY', 'TURNSTILE_SECRET'], 'staging-acme': [] } });
  assert.deepEqual(await cf.listSecretNames('acme'), ['RESEND_KEY', 'TURNSTILE_SECRET']);
  assert.deepEqual(await cf.listSecretNames('staging-acme'), []);
  await rejects(cf.listSecretNames('nobody'), (e) => {
    assert.equal(e.status, 404);
    assert.deepEqual(e.codes, [10007]);
  });
});

test('fake: failOn answers with the given error for the given number of times', async () => {
  const { fake, cf } = setup({ workers: ['acme'] });
  fake.failOn('put', `/accounts/${ACCOUNT}/workers/domains`, { status: 409, codes: [100117], message: 'still there', times: 2 });
  const attach = () => cf.attachCustomDomain({ hostname: 'example.com', service: 'acme', zone_id: ZONE });
  await rejects(attach(), (e) => assert.equal(e.message, 'still there (code 100117)'));
  await rejects(attach(), (e) => assert.ok(isConflict(e)));
  assert.equal((await attach()).hostname, 'example.com');

  fake.failOn('*', /\/dns_records/, { status: 503 });
  await rejects(cf.listDnsRecords(ZONE, 'example.com'), (e) => {
    assert.equal(e.status, 503);
    assert.equal(e.message, 'Injected failure.');
  });
  await rejects(cf.createDnsRecord(ZONE, { type: 'TXT', name: 'example.com', content: 'x', ttl: 1 }), (e) => assert.equal(e.status, 503));
  assert.equal(await cf.getSslMode(ZONE), 'full', 'other paths answer as usual');
});

test('fake: the call log records what was sent', async () => {
  const { fake, cf } = setup();
  await cf.createDnsRecord(ZONE, { type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 1, proxied: true });
  const [c] = fake.calls;
  assert.equal(c.method, 'POST');
  assert.equal(c.path, `/zones/${ZONE}/dns_records`);
  assert.equal(c.url, `${API}/zones/${ZONE}/dns_records`);
  assert.equal(c.body.content, '192.0.2.1');
  assert.equal(c.headers.authorization, 'Bearer ' + TOKEN);
});

// --- The fake sites ---

test('fake sites: pages by exact URL, by path, or by a catch-all for the host', async () => {
  const sites = createFakeSites({
    'https://staging.example.com/': { body: '<title>Acme</title>' },
    'https://staging.example.com/about': { status: 200, headers: { 'x-robots-tag': 'noindex' }, body: 'About' },
    'https://www.example.com/*': (url) => ({ status: 301, headers: { location: 'https://example.com' + url.pathname + url.search } }),
  });
  const home = await sites.fetch('https://staging.example.com/', { redirect: 'manual' });
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /^text\/html/);
  assert.equal(await home.text(), '<title>Acme</title>');

  const about = await sites.fetch('https://staging.example.com/about?x=1');
  assert.equal(about.headers.get('x-robots-tag'), 'noindex');
  assert.match(about.headers.get('content-type'), /^text\/html/, 'html unless told otherwise');

  assert.equal((await sites.fetch('https://staging.example.com/missing')).status, 404);

  const moved = await sites.fetch('https://www.example.com/desk-check?x=1', { redirect: 'manual' });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), 'https://example.com/desk-check?x=1');
  assert.deepEqual(sites.calls.map((c) => c.redirect), ['manual', undefined, undefined, 'manual']);
});

test('fake sites: an unknown host fails like a DNS lookup, and a page can fail like TLS', async () => {
  const sites = createFakeSites({
    'https://example.com/': () => { throw new TypeError('fetch failed', { cause: new Error('certificate not yet valid') }); },
  });
  await assert.rejects(sites.fetch('https://nowhere.example/'), (e) => e instanceof TypeError && /ENOTFOUND/.test(e.cause.message));
  await assert.rejects(sites.fetch('https://example.com/'), /fetch failed/);
});

test('fake sites: redirects are followed unless the caller says manual; pages can change between calls', async () => {
  const sites = createFakeSites({
    'https://www.example.com/': { status: 301, headers: { location: 'https://example.com/' } },
    'https://example.com/': { status: 522, body: 'Connection timed out' },
  });
  assert.equal((await sites.fetch('https://www.example.com/')).status, 522);
  sites.pages['https://example.com/'] = { body: '<title>Live</title>' };
  const followed = await sites.fetch('https://www.example.com/');
  assert.equal(await followed.text(), '<title>Live</title>');
  assert.equal((await sites.fetch('https://www.example.com/', { redirect: 'manual' })).status, 301);
  await assert.rejects(sites.fetch('https://www.example.com/', { redirect: 'error' }), TypeError);
});

// --- The fake public DNS ---

const RESOLVE = {
  'dns.google': (name, type) => `https://dns.google/resolve?name=${name}&type=${type}`,
  'cloudflare-dns.com': (name, type) => `https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`,
};
const JSON_DNS = { headers: { accept: 'application/dns-json' } };

async function ask(doh, resolver, name, type) {
  const res = await doh.fetch(RESOLVE[resolver](name, type), JSON_DNS);
  assert.equal(res.status, 200);
  return res.json();
}

const table = () => ({
  'example.com': {
    NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
    A: [{ data: '192.0.2.10', TTL: 3600 }],
    MX: '10 mx.example.net',
    TXT: 'v=spf1 include:example.net -all',
  },
  'www.example.com': { CNAME: 'example.com' },
  'loop.example.com': { CNAME: 'loop.example.com.' },
  'empty.example.com': {},
});

test('fake DoH: both resolvers answer DoH JSON the way each is seen to', async () => {
  const doh = createFakeDoh({ 'dns.google': table(), 'cloudflare-dns.com': table() });
  const google = await ask(doh, 'dns.google', 'Example.com', 'NS');
  assert.equal(google.Status, 0);
  assert.deepEqual(google.Question, [{ name: 'example.com.', type: 2 }]);
  assert.deepEqual(google.Answer, [
    { name: 'example.com.', type: 2, TTL: 300, data: 'ada.ns.cloudflare.com.' },
    { name: 'example.com.', type: 2, TTL: 300, data: 'bob.ns.cloudflare.com.' },
  ]);
  const cf = await ask(doh, 'cloudflare-dns.com', 'example.com.', 'NS');
  assert.deepEqual(cf.Answer.map((a) => [a.name, a.data]),
    [['example.com', 'ada.ns.cloudflare.com.'], ['example.com', 'bob.ns.cloudflare.com.']]);

  assert.deepEqual((await ask(doh, 'dns.google', 'example.com', 'A')).Answer,
    [{ name: 'example.com.', type: 1, TTL: 3600, data: '192.0.2.10' }]);
  assert.deepEqual((await ask(doh, 'dns.google', 'example.com', 'MX')).Answer.map((a) => [a.type, a.data]), [[15, '10 mx.example.net.']]);
  assert.equal((await ask(doh, 'dns.google', 'example.com', 'TXT')).Answer[0].data, 'v=spf1 include:example.net -all');
  assert.equal((await ask(doh, 'cloudflare-dns.com', 'example.com', 'TXT')).Answer[0].data, '"v=spf1 include:example.net -all"');
  assert.equal((await ask(doh, 'dns.google', 'example.com', '2')).Answer.length, 2, 'a type may be given by number');

  const res = await doh.fetch(RESOLVE['cloudflare-dns.com']('example.com', 'A'), JSON_DNS);
  assert.equal(res.headers.get('content-type'), 'application/dns-json');
  assert.deepEqual(doh.calls.at(-1), {
    resolver: 'cloudflare-dns.com', url: RESOLVE['cloudflare-dns.com']('example.com', 'A'),
    name: 'example.com', type: 'A', accept: 'application/dns-json',
  });
});

test('fake DoH: an unknown name is NXDOMAIN; a known name without that type has no Answer', async () => {
  const doh = createFakeDoh({ 'dns.google': table() });
  const missing = await ask(doh, 'dns.google', 'nowhere.example.com', 'A');
  assert.equal(missing.Status, 3);
  assert.ok(!('Answer' in missing));
  for (const [name, type] of [['empty.example.com', 'A'], ['example.com', 'AAAA']]) {
    const none = await ask(doh, 'dns.google', name, type);
    assert.equal(none.Status, 0, name);
    assert.ok(!('Answer' in none), name);
  }
});

test('fake DoH: a CNAME is followed, the way a resolver answers an A query', async () => {
  const doh = createFakeDoh({ 'cloudflare-dns.com': table() });
  const www = await ask(doh, 'cloudflare-dns.com', 'www.example.com', 'A');
  assert.equal(www.Status, 0);
  assert.deepEqual(www.Answer.map((a) => [a.name, a.type, a.data]), [
    ['www.example.com', 5, 'example.com.'],
    ['example.com', 1, '192.0.2.10'],
  ]);
  assert.deepEqual((await ask(doh, 'cloudflare-dns.com', 'www.example.com', 'CNAME')).Answer.map((a) => a.data), ['example.com.']);
  assert.equal((await ask(doh, 'cloudflare-dns.com', 'loop.example.com', 'A')).Status, 2, 'a CNAME loop is SERVFAIL');

  doh.set('www.example.com', 'CNAME', 'gone.example.net');
  const dangling = await ask(doh, 'cloudflare-dns.com', 'www.example.com', 'A');
  assert.equal(dangling.Status, 3, 'a CNAME to nowhere is NXDOMAIN, with the CNAME in the answer');
  assert.equal(dangling.Answer.length, 1);
});

test('fake DoH: cloudflare-dns.com answers JSON only when asked for it', async () => {
  const doh = createFakeDoh({ 'dns.google': table(), 'cloudflare-dns.com': table() });
  assert.equal((await doh.fetch(RESOLVE['cloudflare-dns.com']('example.com', 'A'))).status, 400);
  assert.equal((await doh.fetch(RESOLVE['cloudflare-dns.com']('example.com', 'A') + '&ct=application/dns-json')).status, 200);
  assert.equal((await doh.fetch(RESOLVE['dns.google']('example.com', 'A'))).status, 200, 'dns.google does not mind');
  assert.equal((await doh.fetch('https://dns.google/dns-query?name=example.com')).status, 404);
  assert.equal((await doh.fetch('https://dns.google/resolve?type=A')).status, 400, 'no name');
  assert.equal((await doh.fetch(RESOLVE['dns.google']('example.com', 'BOGUS'))).status, 400);
});

test('fake DoH: answers change between calls, on both resolvers or on one', async () => {
  const doh = createFakeDoh({ 'dns.google': table(), 'cloudflare-dns.com': table() });
  const a = async (resolver) => (await ask(doh, resolver, 'example.com', 'A')).Answer?.map((x) => x.data);
  doh.set('example.com', 'A', ['198.51.100.1', '198.51.100.2']);
  assert.deepEqual(await a('dns.google'), ['198.51.100.1', '198.51.100.2']);
  assert.deepEqual(await a('cloudflare-dns.com'), ['198.51.100.1', '198.51.100.2']);
  doh.set('Example.com.', 'A', '192.0.2.99', 'dns.google');
  assert.deepEqual(await a('dns.google'), ['192.0.2.99']);
  assert.deepEqual(await a('cloudflare-dns.com'), ['198.51.100.1', '198.51.100.2'], 'the other keeps its answer, as a cache would');
  doh.set('example.com', 'A', null);
  assert.equal(await a('dns.google'), undefined);
  doh.answers['cloudflare-dns.com']['new.example.com'] = { A: '203.0.113.5' };
  assert.equal((await ask(doh, 'cloudflare-dns.com', 'new.example.com', 'A')).Answer[0].data, '203.0.113.5');
});

test('fake DoH: a resolver can be unreachable, or answer however a test says', async () => {
  const doh = createFakeDoh({
    'dns.google': () => ({ Status: 2, Comment: 'SERVFAIL' }),
  });
  assert.equal((await ask(doh, 'dns.google', 'example.com', 'NS')).Status, 2);
  await assert.rejects(doh.fetch(RESOLVE['cloudflare-dns.com']('example.com', 'NS'), JSON_DNS), TypeError, 'no table: unreachable');
  doh.answers['dns.google'] = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(doh.fetch(RESOLVE['dns.google']('example.com', 'NS')), /fetch failed/);

  doh.set('example.com', 'NS', 'ada.ns.cloudflare.com', 'cloudflare-dns.com');
  assert.equal((await ask(doh, 'cloudflare-dns.com', 'example.com', 'NS')).Answer.length, 1, 'set() on one resolver gives it a table');
  doh.set('example.com', 'A', '192.0.2.1');
  await assert.rejects(doh.fetch(RESOLVE['dns.google']('example.com', 'A')), /fetch failed/, 'set() leaves a function resolver alone');
});

// --- One fetch for all the fakes ---

test('combineFetches sends each URL to the fake that owns it, and logs every call', async () => {
  const fake = createFakeCloudflare({ accountId: ACCOUNT, zones: [{ id: ZONE, name: 'example.com' }] });
  const sites = createFakeSites({ 'https://staging.example.com/': { body: '<title>Staging</title>' } });
  const doh = createFakeDoh({ 'dns.google': table() });
  const certs = async () => Response.json({ keys: [] });
  const net = combineFetches(fake, sites, doh, ['tbox.cloudflareaccess.com', certs]);

  const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: net });
  assert.equal(await cf.getSslMode(ZONE), 'full');
  assert.equal(await (await net('https://staging.example.com/', { redirect: 'manual' })).text(), '<title>Staging</title>');
  assert.equal((await (await net(RESOLVE['dns.google']('example.com', 'NS'))).json()).Answer.length, 2);
  assert.deepEqual(await (await net('https://tbox.cloudflareaccess.com/cdn-cgi/access/certs')).json(), { keys: [] });
  await assert.rejects(net('https://nowhere.example/'), (e) => e instanceof TypeError && /ENOTFOUND nowhere\.example/.test(e.cause.message));

  assert.deepEqual(net.calls.map((c) => new URL(c.url).hostname),
    ['api.cloudflare.com', 'staging.example.com', 'dns.google', 'tbox.cloudflareaccess.com', 'nowhere.example']);
  assert.deepEqual([fake.calls.length, sites.calls.length, doh.calls.length], [1, 1, 1]);

  // A page added later belongs to the sites fake from then on.
  sites.pages['https://example.com/'] = { body: 'live' };
  assert.equal(await (await net('https://example.com/')).text(), 'live');
});

test('combineFetches takes a hostname, a RegExp or a function to say which URLs a part answers', async () => {
  const answer = (text) => async () => new Response(text);
  const net = combineFetches(
    [/^https:\/\/a\.example\/only\//, answer('regexp')],
    [(url) => url.hostname.endsWith('.b.example'), answer('function')],
    ['c.example', answer('hostname')],
    ['a.example', answer('fallback')],
  );
  assert.equal(await (await net('https://a.example/only/x')).text(), 'regexp');
  assert.equal(await (await net('https://a.example/other')).text(), 'fallback', 'the first part that claims it wins');
  assert.equal(await (await net('https://x.b.example/')).text(), 'function');
  assert.equal(await (await net(new Request('https://c.example/', { method: 'POST' }))).text(), 'hostname');
  assert.equal(net.calls.at(-1).method, 'POST');
});
