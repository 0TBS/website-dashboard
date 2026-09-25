import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budget, countedFetch, BudgetError, LIMIT } from '../src/budget.js';
import { cloudflare } from '../src/cloudflare.js';
import { createFakeCloudflare, createFakeSites, createFakeDoh, combineFetches } from './fake-cloudflare.js';

// A fetch that answers every call with its number, and remembers each one.
function numbered() {
  const seen = [];
  const fetchImpl = async (input, init) => {
    seen.push({ input, init });
    return new Response(String(seen.length));
  };
  return { fetchImpl, seen };
}

test('a request may make 46 calls: the Free plan\'s 50, less a few spare', () => {
  assert.equal(LIMIT, 46);
  const b = budget();
  assert.equal(b.limit, 46);
  assert.equal(b.used, 0);
  assert.equal(b.remaining(), 46);
  assert.equal(budget(10).remaining(), 10);
});

test('every call is counted and passed through unchanged', async () => {
  const { fetchImpl, seen } = numbered();
  const b = budget(5);
  const counted = countedFetch(fetchImpl, b);
  const init = { method: 'POST', headers: { 'x-a': '1' }, redirect: 'manual' };
  const res = await counted('https://example.com/a', init);
  assert.equal(await res.text(), '1');
  assert.equal(seen[0].input, 'https://example.com/a');
  assert.equal(seen[0].init, init, 'the very same init');
  await counted(new Request('https://example.com/b'));
  assert.equal(b.used, 2);
  assert.equal(b.remaining(), 3);
});

test('the call that would go over the limit is refused before it is made', async () => {
  const { fetchImpl, seen } = numbered();
  const b = budget(2);
  const counted = countedFetch(fetchImpl, b);
  await counted('https://example.com/1');
  await counted('https://example.com/2');
  const refused = counted('https://example.com/3');
  assert.ok(refused instanceof Promise, 'refused like any failed fetch: a rejected promise, not a throw');
  await assert.rejects(refused, (e) => {
    assert.ok(e instanceof BudgetError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'BudgetError');
    assert.equal(e.message, 'The desk has used its Cloudflare calls for this request.');
    return true;
  });
  await assert.rejects(counted('https://example.com/4'), BudgetError, 'and every call after it');
  assert.equal(seen.length, 2, 'the refused calls never went out');
  assert.equal(b.used, 2);
  assert.equal(b.remaining(), 0);
});

test('a call that fails still counts: it went out', async () => {
  const b = budget(3);
  const counted = countedFetch(async () => { throw new TypeError('fetch failed'); }, b);
  await assert.rejects(counted('https://example.com/'), TypeError);
  assert.equal(b.used, 1);
});

test('a budget of nothing refuses the first call', async () => {
  const { fetchImpl, seen } = numbered();
  await assert.rejects(countedFetch(fetchImpl, budget(0))('https://example.com/'), BudgetError);
  assert.equal(seen.length, 0);
});

test('two counted fetches on one budget share it', async () => {
  const { fetchImpl } = numbered();
  const b = budget(3);
  const one = countedFetch(fetchImpl, b);
  const two = countedFetch(fetchImpl, b);
  await one('https://example.com/');
  await two('https://example.com/');
  await one('https://example.com/');
  await assert.rejects(two('https://example.com/'), BudgetError);
  assert.equal(b.used, 3);
});

test('one counted fetch in front of every fake counts Cloudflare, the sites and public DNS alike', async () => {
  const ZONE = 'e0000000000000000000000000000001';
  const fake = createFakeCloudflare({ accountId: 'acc', zones: [{ id: ZONE, name: 'example.com' }] });
  const sites = createFakeSites({ 'https://staging.example.com/': { body: '<title>Staging</title>' } });
  const doh = createFakeDoh({ 'dns.google': { 'example.com': { NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] } } });
  const certs = async () => Response.json({ keys: [] });
  const net = combineFetches(fake, sites, doh, ['tbox.cloudflareaccess.com', certs]);
  const b = budget(6);
  const counted = countedFetch(net, b);
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: counted });

  await cf.findZone('www.example.com');                                  // 2 calls
  await counted('https://staging.example.com/', { redirect: 'manual' }); // 1
  await counted('https://dns.google/resolve?name=example.com&type=NS');   // 1
  await counted('https://tbox.cloudflareaccess.com/cdn-cgi/access/certs'); // 1
  assert.equal(b.used, 5);
  assert.equal(b.used, net.calls.length, 'the count matches what went out');
  assert.equal(b.used, fake.calls.length + sites.calls.length + doh.calls.length + 1);

  await cf.getSslMode(ZONE);
  await assert.rejects(counted('https://staging.example.com/'), BudgetError);
  await assert.rejects(cf.getSslMode(ZONE), BudgetError);
  assert.equal(net.calls.length, 6, 'nothing past the limit reached any fake');
});
