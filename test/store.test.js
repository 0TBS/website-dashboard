import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Store } from '../src/store.js';
import { transaction, pgConnector, pgSession } from '../src/db.js';
import { migrate } from '../src/schema.js';
import { freshDatabase } from './pglite.js';

async function desk() {
  const { db, connect } = await freshDatabase();
  return { db, store: new Store(connect) };
}

const history = async (db) => (await db.query(
  'SELECT who, item, action, field, old_value, new_value FROM history ORDER BY id'
)).rows;

test('ids are 0001, 0002 and on, each table counting on its own, and never reused', async () => {
  const { db, store } = await desk();
  const a = await store.create({ name: 'Acme' });
  const b = await store.create({ name: 'Beta' });
  assert.deepEqual([a.id, b.id], ['0001', '0002']);
  const s1 = (await store.createItem('services', a.id, { kind: 'ga4' })).item;
  const s2 = (await store.createItem('services', b.id, { kind: 'gtm' })).item;
  const c1 = (await store.createItem('contacts', a.id, { name: 'Ana' })).item;
  const x1 = (await store.createItem('x', a.id, { url: 'https://x.com/acme' })).item;
  assert.deepEqual([s1.id, s2.id, c1.id, x1.id], ['0001', '0002', '0001', '0001']);
  // A number that was used, even by a row now gone, is not handed out again.
  await store.remove(b.id);
  assert.equal((await store.create({ name: 'Gamma' })).id, '0003');
  // Past 9999 the id simply grows.
  await db.query("SELECT setval('sites_number', 9999)");
  assert.equal((await store.create({ name: 'Ten thousand' })).id, '10000');
});

test('step 4 renumbers what is already there, and everything that names it follows', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgliteConnector } = await import('./pglite.js');
  const db = new PGlite();
  const connect = pgliteConnector(db);
  await migrate(connect, { upTo: 3 });
  const A = 'a0000000-0000-4000-8000-000000000001';
  const B = 'b0000000-0000-4000-8000-000000000002';
  const SVC = 'c0000000-0000-4000-8000-000000000003';
  // Beta was made first, so it becomes 0001.
  await db.exec(`
    INSERT INTO sites (id, name, created_at, updated_at) VALUES ('${A}', 'Acme', '2026-09-25T15:00:00.000Z', 'u'),
                                                                ('${B}', 'Beta', '2026-09-25T14:00:00.000Z', 'u');
    INSERT INTO site_services (id, site_id, kind, created_at, updated_at) VALUES ('${SVC}', '${A}', 'ga4', 'c', 'u');
    INSERT INTO site_x (id, site_id, url, created_at, updated_at) VALUES ('d0000000-0000-4000-8000-000000000004', '${A}', 'https://x.com/acme', 'c', 'u');
    INSERT INTO golive_log (site_id, at, action, text) VALUES ('${A}', 'a', 'switch-started', 'Started.');
  `);
  const before = (await db.query('SELECT count(*)::int AS n FROM history')).rows[0].n;
  await migrate(connect);
  const rows = async (q) => (await db.query(q)).rows;
  assert.deepEqual(await rows('SELECT id, name FROM sites ORDER BY id'), [{ id: '0001', name: 'Beta' }, { id: '0002', name: 'Acme' }]);
  assert.deepEqual(await rows('SELECT id, site_id FROM site_services'), [{ id: '0001', site_id: '0002' }]);
  assert.deepEqual(await rows('SELECT id, site_id FROM site_x'), [{ id: '0001', site_id: '0002' }]);
  assert.deepEqual(await rows('SELECT site_id FROM golive_log'), [{ site_id: '0002' }]);
  // The history's rows name the new ids, and the renumber added none of its own.
  const hist = await rows("SELECT item, item_id, site_id FROM history WHERE action = 'added' ORDER BY id");
  assert.deepEqual(hist, [
    { item: 'site', item_id: '0002', site_id: '0002' }, { item: 'site', item_id: '0001', site_id: '0001' },
    { item: 'service', item_id: '0001', site_id: '0002' }, { item: 'x', item_id: '0001', site_id: '0002' },
  ]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM history')).rows[0].n, before);
  // New rows carry on from there.
  const store = new Store(connect);
  assert.equal((await store.create({ name: 'Gamma' })).id, '0003');
  assert.equal((await store.createItem('services', '0002', { kind: 'gtm' })).item.id, '0002');
  // A site's details still go with it.
  await store.remove('0002');
  assert.deepEqual(await rows('SELECT count(*)::int AS n FROM site_services'), [{ n: 0 }]);
  await db.close();
});

test('the list is in name order, whatever the case', async () => {
  const { store } = await desk();
  for (const name of ['beta', 'Acme', 'Zeta', 'alpha']) await store.create({ name });
  assert.deepEqual((await store.list()).map((s) => s.name), ['Acme', 'alpha', 'beta', 'Zeta']);
});

test('a site comes back as the page gets it: flags as true/false/null, no go-live yet', async () => {
  const { store } = await desk();
  const site = await store.create({ name: 'Acme', astro_staging: 1, domain_ours: 0 });
  assert.equal(site.id, '0001');
  assert.equal(site.astro_staging, true);
  assert.equal(site.domain_ours, false);
  assert.equal(site.needs_seo_ppc, null);
  assert.equal(site.golive, null);
  assert.equal(site.created_at, site.updated_at);
  assert.deepEqual(await store.read(site.id), site);
  assert.equal(await store.read('9999'), null);
});

test('an edit from a stale copy is refused and changes nothing', async () => {
  const { store } = await desk();
  const site = await store.create({ name: 'Acme' });
  await new Promise((r) => setTimeout(r, 2));
  const first = await store.update(site.id, { notes: 'mine' }, site.updated_at);
  assert.equal(first.site.notes, 'mine');
  const second = await store.update(site.id, { notes: 'theirs' }, site.updated_at);
  assert.equal(second.conflict, true);
  assert.equal(second.site.notes, 'mine');
  assert.deepEqual(await store.update('9999', { notes: 'x' }, null), { missing: true });
});

test('every change to a site is in its history, field by field', async () => {
  const { db, store } = await desk();
  const site = await store.create({ name: 'Acme', needs_seo_ppc: 1 });
  await store.update(site.id, { name: 'Acme Glass', needs_seo_ppc: null, notes: null }, null);
  assert.deepEqual(await history(db), [
    { who: null, item: 'site', action: 'added', field: null, old_value: null, new_value: '{"name": "Acme", "needs_seo_ppc": 1}' },
    { who: null, item: 'site', action: 'changed', field: 'name', old_value: 'Acme', new_value: 'Acme Glass' },
    { who: null, item: 'site', action: 'changed', field: 'needs_seo_ppc', old_value: '1', new_value: null },
  ], 'notes was null and stays null, so it is not a change');
});

test('a go-live run is named in the history of what it changed', async () => {
  const { db, store } = await desk();
  const site = await store.create({ name: 'Acme', live_domain: 'acme.com', live_platform: 'wordpress' });
  const record = {
    zone_id: 'z', zone_name: 'acme.com', worker: 'staging-acme', staging_host: 'staging-acme.10xid.com',
    main_host: 'acme.com', hosts: [{ hostname: 'acme.com', role: 'main' }],
  };
  const who = 'ana@example.com';
  assert.equal((await store.goliveBegin(site.id, { kind: 'switch', who, record, token: 't1' })).ok, true);
  await store.goliveFinish(site.id, 't1', { state: 'checking', platform: { to: 'astro' }, who });
  const change = (await history(db)).at(-1);
  assert.deepEqual(change, { who, item: 'site', action: 'changed', field: 'live_platform', old_value: 'wordpress', new_value: 'astro' });
});

test('a site with a go-live still running cannot be deleted', async () => {
  const { store } = await desk();
  const site = await store.create({ name: 'Acme' });
  const record = {
    zone_id: 'z', zone_name: 'acme.com', worker: 'w', staging_host: 's.10xid.com', main_host: 'acme.com',
    hosts: [{ hostname: 'acme.com', role: 'main' }],
  };
  await store.goliveBegin(site.id, { kind: 'switch', record, token: 't1' });
  assert.deepEqual(await store.remove(site.id), { blocked: 'golive-active' });
  assert.ok(await store.read(site.id));
});

test('services, contacts and domains are added, edited and removed per site', async () => {
  const { store } = await desk();
  const a = await store.create({ name: 'Acme' });
  const b = await store.create({ name: 'Beta' });
  const { item: svc } = await store.createItem('services', a.id, { kind: 'ga4', identifier: 'G-1' });
  assert.equal(svc.site_id, a.id);
  assert.equal(svc.url, null);
  const { item: dom } = await store.createItem('domains', a.id, { hostname: 'acme.com', role: 'live', dns_on_cloudflare: 1 });
  assert.equal(dom.dns_on_cloudflare, true);
  await store.createItem('contacts', a.id, { name: 'zed' });
  await store.createItem('contacts', a.id, { name: 'Ana' });

  const details = await store.details(a.id);
  assert.deepEqual(details.services.map((s) => s.identifier), ['G-1']);
  assert.deepEqual(details.contacts.map((c) => c.name), ['Ana', 'zed']);
  assert.deepEqual(details.domains.map((d) => d.hostname), ['acme.com']);
  const other = await store.details(b.id);
  assert.deepEqual([other.services, other.contacts, other.domains], [[], [], []]);
  assert.deepEqual(other.history.map((h) => [h.item, h.action]), [['site', 'added']]);
  assert.equal(await store.details('9999'), null);

  // Another site's id does not reach this one's rows.
  assert.deepEqual(await store.updateItem('services', b.id, svc.id, { notes: 'x' }, null), { missing: true });
  assert.equal(await store.removeItem('services', b.id, svc.id), false);

  const edited = await store.updateItem('services', a.id, svc.id, { identifier: 'G-2' }, svc.updated_at);
  assert.equal(edited.item.identifier, 'G-2');
  const stale = await store.updateItem('services', a.id, svc.id, { identifier: 'G-3' }, svc.updated_at);
  assert.equal(stale.conflict, true);
  assert.equal(stale.item.identifier, 'G-2');

  assert.equal(await store.removeItem('services', a.id, svc.id), true);
  assert.equal(await store.removeItem('services', a.id, svc.id), false);
  assert.deepEqual((await store.details(a.id)).services, []);
  assert.deepEqual(await store.createItem('contacts', '9999', { name: 'x' }), { missing: true });
});

test('a domain is listed once per site', async () => {
  const { store } = await desk();
  const a = await store.create({ name: 'Acme' });
  const b = await store.create({ name: 'Beta' });
  const { item } = await store.createItem('domains', a.id, { hostname: 'acme.com', role: 'live' });
  assert.deepEqual(await store.createItem('domains', a.id, { hostname: 'acme.com', role: 'old' }), { duplicate: 'hostname' });
  assert.ok((await store.createItem('domains', b.id, { hostname: 'acme.com', role: 'old' })).item, 'another site may list it');
  const { item: img } = await store.createItem('domains', a.id, { hostname: 'img.acme.com', role: 'image' });
  assert.deepEqual(await store.updateItem('domains', a.id, img.id, { hostname: 'acme.com' }, null), { duplicate: 'hostname' });
  assert.equal((await store.updateItem('domains', a.id, item.id, { hostname: 'acme.com', notes: 'same host' }, null)).item.notes, 'same host');
});

test('each platform has its own table, and a link is listed once per site', async () => {
  const { db, store } = await desk();
  const a = await store.create({ name: 'Acme' });
  const b = await store.create({ name: 'Beta' });
  for (const [platform, url] of [['tiktok', 'https://tiktok.com/@acme'], ['linkedin', 'https://linkedin.com/company/acme'],
    ['facebook', 'https://facebook.com/acme'], ['x', 'https://x.com/acme'], ['instagram', 'https://instagram.com/acme']]) {
    const { item } = await store.createItem(platform, a.id, { url, handle: 'acme' });
    assert.equal(item.url, url);
    const rows = (await db.query(`SELECT url FROM site_${platform}`)).rows;
    assert.deepEqual(rows, [{ url }], platform + ' is in its own table');
  }
  assert.deepEqual(await store.createItem('x', a.id, { url: 'https://x.com/acme' }), { duplicate: 'url' });
  assert.ok((await store.createItem('x', b.id, { url: 'https://x.com/acme' })).item, 'another site may list it');
  const { item: second } = await store.createItem('x', a.id, { url: 'https://x.com/acme_help' });
  assert.deepEqual(await store.updateItem('x', a.id, second.id, { url: 'https://x.com/acme' }, null), { duplicate: 'url' });

  const details = await store.details(a.id);
  for (const p of ['tiktok', 'linkedin', 'facebook', 'instagram']) assert.equal(details[p].length, 1, p);
  assert.equal(details.x.length, 2);
  const added = (await history(db)).filter((h) => h.action === 'added' && h.item !== 'site').map((h) => h.item);
  assert.deepEqual(added, ['tiktok', 'linkedin', 'facebook', 'x', 'instagram', 'x', 'x']);

  assert.equal(await store.remove(a.id), true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM site_x')).rows[0].n, 1, 'only the other site\'s link is left');
});

test('deleting a site takes its details with it, and the history keeps them', async () => {
  const { db, store } = await desk();
  const site = await store.create({ name: 'Acme' });
  await store.createItem('contacts', site.id, { name: 'Ana', email: 'ana@acme.com' });
  assert.equal(await store.remove(site.id), true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM site_contacts')).rows[0].n, 0);
  const removed = (await history(db)).filter((h) => h.action === 'removed').map((h) => [h.item, JSON.parse(h.old_value)]);
  assert.deepEqual(removed, [['site', { name: 'Acme' }], ['contact', { name: 'Ana', email: 'ana@acme.com' }]]);
  assert.equal(await store.remove(site.id), false);
});

test('a read cannot write, and a write that throws leaves nothing behind', async () => {
  const { db, connect } = await freshDatabase();
  await assert.rejects(transaction(connect, (tx) => tx.run("INSERT INTO desk_meta VALUES ('a', 'b')")), /read-only/);
  await assert.rejects(transaction(connect, async (tx) => {
    await tx.run("INSERT INTO desk_meta VALUES ('a', 'b')");
    throw new Error('part-way');
  }, { write: true }), /part-way/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM desk_meta')).rows[0].n, 0);
});

// What the live Durable Object held: an old row made before chat_url and
// environment existed, a go-live with its log and check.
const DUMP = {
  sites: [
    { id: 's1', name: 'Acme', live_domain: 'acme.com', staging_domain: null, github_repo: null, live_platform: 'astro',
      astro_staging: 1, domain_ours: 0, needs_seo_ppc: null, notes: 'Old host "WP Engine"; ça va', created_at: 'c1', updated_at: 'u1' },
    { id: 's2', name: 'Beta', chat_url: 'https://claude.ai/code/x', environment: 'backblaze/CF', created_at: 'c2', updated_at: 'u2' },
  ],
  golive: [{
    site_id: 's1', state: 'live', run_token: null, finished_token: 't1', zone_id: 'z', zone_name: 'acme.com', worker: 'w',
    staging_host: 's.10xid.com', main_host: 'acme.com', hosts: '[{"hostname":"acme.com","role":"main"}]', saved_records: '[]',
    saved_domains: '[]', redirect: null, redirect_rule: null, attached: '[]', steps_done: '[]', mx_txt: '[]', ssl_mode: 'full',
    previous_platform: 'wordpress', restored: null, checks: null, notes: null, error: null, acks: null, started_by: 'ana@example.com',
    started_at: 'a', switched_at: 'b', verified_at: 'c', rolled_back_by: null, rolled_back_at: null, updated_at: 'd',
  }],
  golive_log: [
    { seq: 1, site_id: 's1', at: 'a', who: 'ana@example.com', action: 'switch-started', text: 'Started.', detail: '{"x":1}' },
    { seq: 7, site_id: 's1', at: 'c', who: 'ana@example.com', action: 'verified', text: 'Verified.', detail: null },
  ],
  golive_checks: [{
    site_id: 's1', plan_hash: 'p', checks_hash: 'h', include_pair: 1, ready: 1, acks: '[]', checked_by: 'ana@example.com', checked_at: 'a',
  }],
};

test('the Durable Object is copied across once, exactly, and makes no history', async () => {
  const { db, store } = await desk();
  assert.equal(await store.hasImported(), false);
  assert.deepEqual(await store.importRows(DUMP), { sites: 2, golive: 1, golive_log: 2, golive_checks: 1 });
  assert.equal(await store.hasImported(), true);
  assert.equal(await store.importRows(DUMP), null, 'a second copy does nothing');

  // Each site is numbered in the order it was made, and its go-live record
  // follows it; everything else is exactly as the object held it.
  const renumbered = { s1: '0001', s2: '0002' };
  for (const table of ['sites', 'golive', 'golive_log', 'golive_checks']) {
    const key = table === 'sites' ? 'id' : table === 'golive_log' ? 'seq' : 'site_id';
    const rows = (await db.query(`SELECT * FROM ${table} ORDER BY ${key}`)).rows;
    assert.equal(rows.length, DUMP[table].length, table);
    DUMP[table].forEach((want, i) => {
      for (const [k, v] of Object.entries(want)) {
        const expected = (k === 'id' || k === 'site_id') ? renumbered[v] : v;
        assert.deepEqual(rows[i][k], expected, `${table}.${k}`);
      }
    });
  }
  const acme = await store.read('0001');
  assert.equal(acme.golive.state, 'live');
  assert.equal(acme.chat_url, null, 'a column the old row never had is not set');
  assert.deepEqual(await history(db), []);

  // The next log entry comes after the last one copied.
  await store.goliveBegin('0001', { kind: 'rollback', token: 't2' });
  assert.deepEqual((await store.goliveDetail('0001')).log.map((e) => e.seq), [1, 7, 8]);
  // And the copy switched history off for itself only.
  assert.equal((await history(db)).length, 0, 'a rollback start changes no site field');
  await store.update('0002', { notes: 'after' }, null);
  assert.equal((await history(db)).length, 1);
  assert.equal((await store.create({ name: 'Next' })).id, '0003', 'a new site comes after the copied ones');
});

test('a copy that cannot land every row lands none of them', async () => {
  const { db, store } = await desk();
  // Two checks for the same site: the second cannot land.
  const twice = { ...DUMP, golive_checks: [DUMP.golive_checks[0], { ...DUMP.golive_checks[0], plan_hash: 'q' }] };
  await assert.rejects(store.importRows(twice), /Copied 1 of the Durable Object's 2 golive_checks rows; copied nothing/);
  assert.equal(await store.hasImported(), false);
  assert.deepEqual((await db.query('SELECT count(*)::int AS n FROM sites')).rows, [{ n: 0 }]);
});

test('an empty Durable Object is copied as nothing, and remembered', async () => {
  const { store } = await desk();
  assert.deepEqual(await store.importRows({}), { sites: 0, golive: 0, golive_log: 0, golive_checks: 0 });
  assert.equal(await store.hasImported(), true);
});

// Real concurrency needs a real server: PGlite has one connection. Set
// TEST_DATABASE_URL to a throwaway database on a Postgres you run, e.g.
// postgres://desk@127.0.0.1:5433/desk_test.
test('writes from many connections at once still run one at a time', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await admin.end();
  const connect = pgConnector(process.env.TEST_DATABASE_URL);
  await Promise.all([migrate(connect), migrate(connect), migrate(connect)]);
  const store = new Store(connect);
  const site = await store.create({ name: 'Acme' });

  // Twenty editors who all opened the same copy: exactly one save wins.
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(site.id, { notes: 'n' + i }, site.updated_at)));
  assert.equal(results.filter((r) => !r.conflict).length, 1);
  assert.equal(results.filter((r) => r.conflict).length, 19);

  // Twenty go-live starts on the same hosts from two sites: one holds them.
  const other = await store.create({ name: 'Acme (new build)' });
  const record = {
    zone_id: 'z', zone_name: 'acme.com', worker: 'w', staging_host: 's.10xid.com', main_host: 'acme.com',
    hosts: [{ hostname: 'acme.com', role: 'main' }],
  };
  const starts = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.goliveBegin(i % 2 ? site.id : other.id, { kind: 'switch', record, token: 'tok' + i })));
  assert.equal(starts.filter((r) => r.ok).length, 1);
});

test('a request holds one connection for all its calls, and opens another only if it drops', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = process.env.TEST_DATABASE_URL;
  const session = pgSession(url);
  const pid = () => transaction(session.connect, async (tx) => (await tx.row('SELECT pg_backend_pid() AS pid')).pid);
  const pids = await Promise.all(Array.from({ length: 10 }, pid));
  assert.equal(new Set(pids).size, 1, 'ten calls, one connection');

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend($1)', [pids[0]]);
  await assert.rejects(pid(), 'the call on the dropped connection fails');
  const again = await pid();
  assert.notEqual(again, pids[0], 'the next call opens a new one');

  await session.close();
  const left = (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [again])).rows[0].n;
  await admin.end();
  assert.equal(left, 0, 'close() ends it');
});
