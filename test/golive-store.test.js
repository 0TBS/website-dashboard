import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteStorage } from './sqlite-adapter.js';
import {
  ensureGoliveSchema, goliveStale, goliveAllows, goliveSummary, goliveSummaries, siteWithGolive, goliveDetail,
  goliveSaveCheck, goliveLastCheck, goliveBegin, goliveStep, goliveFinish, goliveSaveVerify, goliveHostsInUse,
  goliveBlocksDelete, STALE_AFTER,
} from '../src/golive-store.js';

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

const T0 = '2026-09-25T15:00:00.000Z';
const CREATED = '2026-09-01T12:00:00.000Z';
const SEC = 1000;
const MIN = 60 * SEC;
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString();
const WHO = 'ana@example.com';

// Records as Cloudflare lists them, with the parts a round trip must keep:
// quotes and a semicolon in a comment, non-ASCII text, nested settings and meta.
const RECORDS = [
  {
    id: 'rec-apex', type: 'A', name: 'acme.com', content: '192.0.2.10', proxied: false, ttl: 1,
    comment: 'Old host "WP Engine"; don\'t delete — ça va?', tags: ['owner:ana'],
    settings: { ipv4_only: true }, meta: { read_only: false, origin: 'user' },
  },
  { id: 'rec-www', type: 'CNAME', name: 'www.acme.com', content: 'acme.com', proxied: true, ttl: 1, comment: null, tags: [], settings: {}, meta: {} },
];
const HOSTS = [{ hostname: 'acme.com', role: 'main' }, { hostname: 'www.acme.com', role: 'redirect' }];
const ACKS = [
  { id: 'gate12', label: 'Gate 12 is approved in sites/acme.com.md' },
  { id: 'wrangler', label: 'I have checked 0TBS/acme’s wrangler config (routes and custom domains)' },
];
const ATTACHED = [{ id: 'cd-apex', hostname: 'acme.com' }, { id: 'cd-www', hostname: 'www.acme.com' }];
const CHECKS = [
  { id: 'https', label: 'HTTPS', status: 'pass', detail: 'acme.com answers 200 with a page.' },
  { id: 'public-dns', label: 'Public DNS', status: 'wait', detail: 'Public DNS still returns <b>"192.0.2.10"</b> — `cached`; for up to 300 s.' },
];

function record(extra = {}) {
  return {
    zone_id: 'zone-acme', zone_name: 'acme.com', worker: 'staging-acme', staging_host: 'staging-acme.10xid.com',
    main_host: 'acme.com', hosts: HOSTS, saved_records: RECORDS, saved_domains: [],
    redirect: { from: 'www.acme.com', to: 'acme.com', ref: 'desk-site-a' },
    mx_txt: [
      { type: 'MX', name: 'acme.com', content: 'mx1.mail.example', priority: 10 },
      { type: 'TXT', name: 'acme.com', content: '"v=spf1 a include:_spf.mail.example -all"', priority: null },
    ],
    ...extra,
  };
}

function desk() {
  const storage = sqliteStorage();
  storage.sql.exec(SITES);
  ensureGoliveSchema(storage.sql);
  addSite(storage.sql, 'site-a', 'Acme');
  addSite(storage.sql, 'site-b', 'Acme (new build)');
  return storage;
}

function addSite(sql, id, name, live_platform = 'wordpress') {
  sql.exec(
    `INSERT INTO sites (id, name, live_domain, staging_domain, live_platform, astro_staging, created_at, updated_at)
     VALUES (?, ?, 'acme.com', 'staging-acme.10xid.com', ?, 1, ?, ?)`,
    id, name, live_platform, CREATED, CREATED
  );
}

const rawRow = (sql, id) => sql.exec('SELECT * FROM golive WHERE site_id = ?', id).toArray()[0];
const siteRow = (sql, id) => sql.exec('SELECT * FROM sites WHERE id = ?', id).toArray()[0];
const logOf = (sql, id) => goliveDetail(sql, id, T0).log;

// Everything the store can write, to prove a refused call wrote none of it.
const snapshot = (sql) => ({
  golive: sql.exec('SELECT * FROM golive ORDER BY site_id').toArray(),
  log: sql.exec('SELECT * FROM golive_log ORDER BY seq').toArray(),
  sites: sql.exec('SELECT * FROM sites ORDER BY id').toArray(),
  checks: sql.exec('SELECT * FROM golive_checks ORDER BY site_id').toArray(),
});

// The steps of a real run, as the routes take them.
const begin = (sql, id, kind, { token = kind + '-token', now = T0, rec = record(), acks = ACKS } = {}) =>
  goliveBegin(sql, id, { kind, who: WHO, record: rec, acks, token, now });

const attach = (sql, id, token, now, list = ATTACHED) => goliveStep(sql, id, token, {
  add: { attached: list, steps_done: list.map((a) => 'attached:' + a.hostname) },
  log: list.map((a) => ({ action: 'domain-attached', text: `Attached ${a.hostname} to staging-acme.`, detail: a })),
  now,
});

function switched(sql, id, { token = 'switch-token', now = T0 } = {}) {
  begin(sql, id, 'switch', { token, now });
  attach(sql, id, token, now);
  return goliveFinish(sql, id, token, {
    state: 'checking', fields: { switched_at: now, error: null },
    log: { action: 'switched', text: 'Switched acme.com and www.acme.com to staging-acme.' },
    platform: { to: 'astro' }, who: WHO, now,
  });
}

function rolledBack(sql, id, { state = 'rolled-back', token = 'rollback-token', now = at(MIN) } = {}) {
  begin(sql, id, 'rollback', { token, now });
  const { golive } = goliveDetail(sql, id, now);
  return goliveFinish(sql, id, token, {
    state, fields: { rolled_back_by: WHO, rolled_back_at: now, error: state === 'rolled-back' ? null : 'Cloudflare said: no.' },
    log: { action: state, text: 'Rolled back acme.com and www.acme.com.' },
    platform: state === 'rolled-back' ? { to: golive.previous_platform, onlyIf: 'astro' } : null, who: WHO, now,
  });
}

const failed = (sql, id, restored) => {
  begin(sql, id, 'switch');
  return goliveFinish(sql, id, 'switch-token', {
    state: 'switch-failed', fields: { restored, error: 'Cloudflare said: Record does not exist. (code 81044)', notes: ['A note.'] },
    log: { action: 'switch-failed', text: 'The switch failed.' }, now: T0,
  });
};

// Puts site-a into each state of the state table the way a real run gets
// there, and answers the time to act at.
const STATES = {
  'no row': () => at(MIN),
  switching: (sql) => { begin(sql, 'site-a', 'switch'); return at(MIN); },
  'switching, every host attached': (sql) => { begin(sql, 'site-a', 'switch'); attach(sql, 'site-a', 'switch-token', T0); return at(MIN); },
  'switching, stale': (sql) => { begin(sql, 'site-a', 'switch'); return at(3 * MIN); },
  'switching, stale, every host attached': (sql) => {
    begin(sql, 'site-a', 'switch');
    attach(sql, 'site-a', 'switch-token', T0);
    return at(3 * MIN);
  },
  checking: (sql) => { switched(sql, 'site-a'); return at(MIN); },
  live: (sql) => {
    switched(sql, 'site-a');
    goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, now: at(MIN) });
    return at(2 * MIN);
  },
  'switch-failed, put back': (sql) => { failed(sql, 'site-a', 1); return at(MIN); },
  'switch-failed, not all put back': (sql) => { failed(sql, 'site-a', 0); return at(MIN); },
  'rolling-back': (sql) => { switched(sql, 'site-a'); begin(sql, 'site-a', 'rollback', { now: at(MIN) }); return at(2 * MIN); },
  'rolling-back, stale': (sql) => { switched(sql, 'site-a'); begin(sql, 'site-a', 'rollback', { now: at(MIN) }); return at(4 * MIN); },
  'rolled-back': (sql) => { switched(sql, 'site-a'); rolledBack(sql, 'site-a'); return at(2 * MIN); },
  'rollback-failed': (sql) => { switched(sql, 'site-a'); rolledBack(sql, 'site-a', { state: 'rollback-failed' }); return at(2 * MIN); },
};

// The spec's state table. [state, Go live, Roll back, Check now, blocks a
// delete, holds its hosts against other sites]
const TABLE = [
  ['no row', true, false, false, false, false],
  ['switching', false, false, false, true, true],
  ['switching, every host attached', false, false, false, true, true],
  ['switching, stale', false, true, false, true, true],
  ['switching, stale, every host attached', false, true, true, true, true],
  ['checking', false, true, true, true, true],
  ['live', false, true, true, false, true],
  ['switch-failed, put back', true, false, false, false, false],
  ['switch-failed, not all put back', false, true, false, true, true],
  ['rolling-back', false, false, false, true, true],
  ['rolling-back, stale', false, true, false, true, true],
  ['rolled-back', true, false, false, false, false],
  ['rollback-failed', false, true, false, true, true],
];

function inState(name) {
  const storage = desk();
  const now = STATES[name](storage.sql);
  return { ...storage, now };
}

// ---- The adapter: node:sqlite standing in for ctx.storage ----

test('the adapter runs every statement, binds the last, and reads like the object\'s cursor', () => {
  const { sql } = sqliteStorage();
  sql.exec("CREATE TABLE t (a TEXT, b INTEGER); INSERT INTO t VALUES ('x;y', 1); -- a comment; with a semicolon\nINSERT INTO t VALUES (?, ?);", 'z', 2);
  assert.deepEqual(sql.exec('SELECT * FROM t ORDER BY b').toArray(), [{ a: 'x;y', b: 1 }, { a: 'z', b: 2 }]);
  assert.deepEqual(sql.exec('SELECT a FROM t WHERE b = ?', 2).one(), { a: 'z' });
  assert.throws(() => sql.exec('SELECT a FROM t WHERE b = 9').one(), /no results/);
  assert.throws(() => sql.exec('SELECT a FROM t').one(), /multiple results/);
  assert.deepEqual([...sql.exec('SELECT b FROM t ORDER BY b')], [{ b: 1 }, { b: 2 }]);
  assert.deepEqual(sql.exec('SELECT a, b FROM t').columnNames, ['a', 'b']);
  const cursor = sql.exec('SELECT b FROM t ORDER BY b');
  assert.deepEqual(cursor.next().value, { b: 1 });
  assert.deepEqual(cursor.toArray(), [{ b: 2 }], 'toArray() returns what is left');
});

test('the adapter refuses what a Durable Object refuses', () => {
  const { sql } = sqliteStorage();
  for (const q of ['BEGIN', 'begin transaction', 'COMMIT', 'SAVEPOINT s', 'SELECT 1; ROLLBACK']) {
    assert.throws(() => sql.exec(q), /transactionSync/, q);
  }
  for (const bad of [true, undefined, {}, ['x'], 1n]) {
    assert.throws(() => sql.exec('SELECT ?', bad), TypeError, String(bad));
  }
});

test('transactionSync commits, returns the result, and undoes everything when the callback throws', () => {
  const storage = sqliteStorage();
  const { sql } = storage;
  sql.exec('CREATE TABLE t (n INTEGER)');
  assert.equal(storage.transactionSync(() => { sql.exec('INSERT INTO t VALUES (1)'); return 'done'; }), 'done');
  assert.throws(() => storage.transactionSync(() => {
    sql.exec('INSERT INTO t VALUES (2)');
    throw new Error('boom');
  }), /boom/);
  storage.transactionSync(() => {
    sql.exec('INSERT INTO t VALUES (3)');
    assert.throws(() => storage.transactionSync(() => {
      sql.exec('INSERT INTO t VALUES (4)');
      throw new Error('inner');
    }), /inner/);
  });
  assert.throws(() => storage.transactionSync(async () => { sql.exec('INSERT INTO t VALUES (5)'); }), /must not be async/);
  assert.deepEqual(sql.exec('SELECT n FROM t ORDER BY n').toArray().map((r) => r.n), [1, 3]);
});

// ---- Schema ----

test('the schema can be made again and again without touching what is there', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  goliveSaveCheck(sql, 'site-a', { plan_hash: 'h', include_pair: true, ready: true, acks: ACKS, who: WHO, now: T0 });
  const before = snapshot(sql);
  ensureGoliveSchema(sql);
  ensureGoliveSchema(sql);
  assert.deepEqual(snapshot(sql), before);
  const names = sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'golive%' ORDER BY name").toArray().map((r) => r.name);
  assert.deepEqual(names, ['golive', 'golive_checks', 'golive_log', 'golive_log_site']);
  assert.ok(sql.exec("SELECT sql FROM sqlite_master WHERE name = 'sites'").one().sql.includes('live_platform'), 'the sites table is not altered');
});

// ---- The state table ----

for (const [name, canSwitch, canRollBack, canVerify, blocksDelete, holdsHosts] of TABLE) {
  test(`state table: ${name}`, () => {
    // Go live.
    {
      const { sql, now } = inState(name);
      const row = rawRow(sql, 'site-a');
      assert.equal(goliveAllows(row, 'switch', now), canSwitch);
      const before = snapshot(sql);
      const res = goliveBegin(sql, 'site-a', { kind: 'switch', who: WHO, record: record(), acks: ACKS, token: 'new-token', now });
      if (canSwitch) {
        assert.equal(res.ok, true);
        assert.equal(res.golive.state, 'switching');
        assert.equal(rawRow(sql, 'site-a').run_token, 'new-token');
        assert.equal(logOf(sql, 'site-a').at(-1).action, 'switch-started');
      } else {
        assert.equal(res.busy, true);
        assert.equal(res.golive.state, row.state);
        assert.match(res.reason, /^[A-Z].*\.$/);
        assert.deepEqual(snapshot(sql), before, 'a refused switch writes nothing');
      }
    }
    // Roll back.
    {
      const { sql, now } = inState(name);
      const row = rawRow(sql, 'site-a');
      assert.equal(goliveAllows(row, 'rollback', now), canRollBack);
      const before = snapshot(sql);
      const res = goliveBegin(sql, 'site-a', { kind: 'rollback', who: WHO, acks: [], token: 'new-token', now });
      if (canRollBack) {
        assert.equal(res.ok, true);
        assert.equal(res.golive.state, 'rolling-back');
        assert.equal(res.golive.stale, false);
        assert.equal(rawRow(sql, 'site-a').run_token, 'new-token');
        assert.equal(logOf(sql, 'site-a').at(-1).action, 'rollback-started');
      } else {
        assert.equal(res.busy, true);
        assert.equal(res.golive?.state, row?.state);
        assert.match(res.reason, /^[A-Z].*\.$/);
        assert.deepEqual(snapshot(sql), before, 'a refused rollback writes nothing');
      }
    }
    // Check now.
    {
      const { sql, now } = inState(name);
      const row = rawRow(sql, 'site-a');
      assert.equal(goliveAllows(row, 'verify', now), canVerify);
      const before = snapshot(sql);
      const res = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: false, now });
      if (canVerify) {
        assert.equal(res.site.id, 'site-a');
        assert.equal(res.golive.state, row.state === 'live' ? 'live' : 'checking');
        assert.deepEqual(res.golive.checks, CHECKS);
      } else {
        assert.deepEqual(res, row ? { notSwitched: true, golive: goliveDetail(sql, 'site-a', now).golive } : { missing: true });
        assert.deepEqual(snapshot(sql), before, 'a refused check writes nothing');
      }
    }
    // Delete, and the hostname lock on another site.
    {
      const { sql, now } = inState(name);
      assert.equal(goliveBlocksDelete(sql, 'site-a'), blocksDelete);
      assert.equal(goliveHostsInUse(sql, 'site-b', ['acme.com', 'www.acme.com']).length > 0, holdsHosts);
      const res = begin(sql, 'site-b', 'switch', { now, token: 'b-token' });
      assert.equal(res.ok === true, !holdsHosts);
      assert.equal(res.busy === true, holdsHosts);
    }
  });
}

test('an unknown state blocks the delete and holds its hosts: the desk fails closed', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  sql.exec("UPDATE golive SET state = 'mystery' WHERE site_id = 'site-a'");
  assert.equal(goliveBlocksDelete(sql, 'site-a'), true);
  assert.equal(goliveHostsInUse(sql, 'site-b', ['acme.com']).length, 1);
  assert.equal(goliveAllows(rawRow(sql, 'site-a'), 'switch', T0), false);
  assert.throws(() => goliveAllows(rawRow(sql, 'site-a'), 'dance', T0), /Unknown go-live action/);
  assert.match(begin(sql, 'site-a', 'switch').reason, /state the desk does not know: mystery\./);
});

test('a failed switch whose restored was never written counts as not put back', () => {
  const { sql } = desk();
  failed(sql, 'site-a', null);
  const row = rawRow(sql, 'site-a');
  assert.equal(row.restored, null);
  assert.equal(goliveAllows(row, 'switch', T0), false);
  assert.equal(goliveAllows(row, 'rollback', T0), true);
  assert.equal(goliveBlocksDelete(sql, 'site-a'), true);
});

test('refusals say why in a plain sentence', () => {
  const reason = (name, kind) => {
    const { sql, now } = inState(name);
    return goliveBegin(sql, 'site-a', { kind, who: WHO, record: record(), token: 't', now }).reason;
  };
  assert.equal(reason('no row', 'rollback'), 'This site has not gone live from the desk, so there is nothing to undo.');
  assert.equal(reason('switching', 'switch'), 'A switch on this site is running now. Wait for it to finish.');
  assert.equal(reason('switching', 'rollback'), 'A switch on this site is running now. Wait for it to finish.');
  assert.equal(reason('switching, stale', 'switch'), 'A switch on this site stopped part-way. Roll it back before going live again.');
  assert.equal(reason('rolling-back', 'rollback'), 'A rollback on this site is running now. Wait for it to finish.');
  assert.equal(reason('rolling-back, stale', 'switch'), 'A rollback on this site stopped part-way. Roll back again to finish it.');
  assert.equal(reason('live', 'switch'), 'This site is already switched to staging-acme. Roll it back first.');
  assert.equal(reason('checking', 'switch'), 'This site is already switched to staging-acme. Roll it back first.');
  assert.equal(reason('switch-failed, put back', 'rollback'), 'The failed switch was already put back, so there is nothing to undo.');
  assert.equal(reason('switch-failed, not all put back', 'switch'), 'The last switch failed and was not all put back. Roll it back first.');
  assert.equal(reason('rolled-back', 'rollback'), 'This site was already rolled back, so there is nothing to undo.');
  assert.equal(reason('rollback-failed', 'switch'), 'The last rollback did not finish. Roll back again first.');
});

// ---- Stale ----

test('a lock goes stale after exactly two minutes without a step', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  assert.equal(STALE_AFTER, 2 * MIN);
  const row = () => rawRow(sql, 'site-a');
  assert.equal(goliveStale(row(), at(2 * MIN)), false, 'two minutes is not yet stale');
  assert.equal(goliveStale(row(), at(2 * MIN + 1)), true);

  // Every step is a heartbeat.
  goliveStep(sql, 'site-a', 'switch-token', { log: { action: 'record-deleted', text: 'Deleted A acme.com.' }, now: at(90 * SEC) });
  assert.equal(row().updated_at, at(90 * SEC));
  assert.equal(goliveStale(row(), at(3 * MIN)), false);
  assert.equal(goliveStale(row(), at(90 * SEC + 2 * MIN + 1)), true);
  assert.equal(goliveSummary(row(), at(3 * MIN)).stale, false);
  assert.equal(goliveSummary(row(), at(4 * MIN)).stale, true);
  assert.equal(goliveDetail(sql, 'site-a', at(4 * MIN)).golive.stale, true);
});

test('only a switch or a rollback can go stale', () => {
  for (const name of ['checking', 'live', 'switch-failed, not all put back', 'rolled-back', 'rollback-failed']) {
    const { sql } = inState(name);
    assert.equal(goliveStale(rawRow(sql, 'site-a'), at(365 * 24 * 60 * MIN)), false, name);
  }
  assert.equal(goliveStale(null, T0), false);
});

test('times may be ISO strings or milliseconds; with none the clock is used', () => {
  const { sql } = desk();
  assert.equal(goliveSaveCheck(sql, 'site-a', { plan_hash: 'h', include_pair: false, ready: true, who: WHO, now: Date.parse(T0) }).checked_at, T0);
  const before = Date.now();
  const { checked_at } = goliveSaveCheck(sql, 'site-a', { plan_hash: 'h', include_pair: false, ready: true, who: WHO });
  assert.ok(Date.parse(checked_at) >= before && Date.parse(checked_at) <= Date.now());
  assert.throws(() => goliveSaveCheck(sql, 'site-a', { plan_hash: 'h', who: WHO, now: 'not a time' }), RangeError);
});

// ---- Starting a switch ----

test('a switch writes the whole record before anything else happens', () => {
  const { sql } = desk();
  const res = begin(sql, 'site-a', 'switch');
  assert.equal(res.ok, true);
  const g = res.golive;
  assert.deepEqual(g, goliveDetail(sql, 'site-a', T0).golive);
  assert.equal(g.state, 'switching');
  assert.equal(g.stale, false);
  assert.equal(g.zone_id, 'zone-acme');
  assert.equal(g.zone_name, 'acme.com');
  assert.equal(g.worker, 'staging-acme');
  assert.equal(g.staging_host, 'staging-acme.10xid.com');
  assert.equal(g.main_host, 'acme.com');
  assert.deepEqual(g.hosts, HOSTS);
  assert.deepEqual(g.saved_records, RECORDS, 'the rollback records survive the round trip exactly');
  assert.deepEqual(g.saved_domains, []);
  assert.deepEqual(g.redirect, record().redirect);
  assert.deepEqual(g.mx_txt, record().mx_txt);
  assert.deepEqual(g.attached, []);
  assert.deepEqual(g.steps_done, []);
  assert.deepEqual(g.acks, ACKS);
  assert.equal(g.previous_platform, 'wordpress');
  assert.equal(g.started_by, WHO);
  assert.equal(g.started_at, T0);
  assert.equal(g.updated_at, T0);
  for (const k of ['redirect_rule', 'restored', 'checks', 'notes', 'error', 'switched_at', 'verified_at', 'rolled_back_by', 'rolled_back_at', 'ssl_mode']) {
    assert.equal(g[k], null, k);
  }
  assert.ok(!('run_token' in g), 'the run token never leaves the store');
  assert.ok(!('finished_token' in g));
  assert.equal(rawRow(sql, 'site-a').run_token, 'switch-token');

  const log = logOf(sql, 'site-a');
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], {
    seq: log[0].seq, at: T0, who: WHO, action: 'switch-started',
    text: 'ana@example.com started switching acme.com and www.acme.com to staging-acme. Saved first, so Roll back can put them back: 2 DNS records.',
    detail: { worker: 'staging-acme', hosts: HOSTS, saved_records: RECORDS, saved_domains: [], redirect: record().redirect, acks: ACKS },
  });
});

test('the switch-started sentence counts what was saved, including Custom Domains taken from another Worker', () => {
  const text = (rec) => {
    const { sql } = desk();
    begin(sql, 'site-a', 'switch', { rec });
    return logOf(sql, 'site-a')[0].text;
  };
  const moved = { id: 'cd-old', hostname: 'www.acme.com', service: 'acme' };
  assert.equal(
    text(record({ saved_records: [RECORDS[0]], saved_domains: [moved] })),
    'ana@example.com started switching acme.com and www.acme.com to staging-acme. Saved first, so Roll back can put them back: 1 DNS record and 1 Custom Domain on another Worker.'
  );
  assert.equal(
    text(record({ hosts: [HOSTS[0]], saved_records: [], saved_domains: [], redirect: null })),
    'ana@example.com started switching acme.com to staging-acme. There was no DNS record or Custom Domain on them to save first.'
  );
});

test('a record shaped like the plan is taken as well', () => {
  const { sql } = desk();
  const plan = {
    site_id: 'site-a', zone: { id: 'zone-acme', name: 'acme.com', plan: 'free' }, worker: 'staging-acme',
    staging_host: 'staging-acme.10xid.com', main: 'acme.com', hosts: HOSTS, delete_records: RECORDS,
    saved_domains: [], redirect: null, mx_txt: [], ssl_mode: 'strict',
  };
  const { golive } = begin(sql, 'site-a', 'switch', { rec: plan });
  assert.equal(golive.zone_id, 'zone-acme');
  assert.equal(golive.zone_name, 'acme.com');
  assert.equal(golive.main_host, 'acme.com');
  assert.deepEqual(golive.saved_records, RECORDS);
  assert.equal(golive.redirect, null);
  assert.equal(golive.ssl_mode, 'strict', 'for the gate 13 record');
  assert.ok(!('ssl_mode' in goliveSummary(rawRow(sql, 'site-a'), T0)), 'the list does not carry it');
});

test('a switch or rollback for a site that is not there is missing, and writes nothing', () => {
  const { sql } = desk();
  const before = snapshot(sql);
  assert.deepEqual(begin(sql, 'nope', 'switch'), { missing: true });
  assert.deepEqual(begin(sql, 'nope', 'rollback'), { missing: true });
  assert.deepEqual(goliveSaveVerify(sql, 'nope', { checks: [], done: true, now: T0 }), { missing: true });
  assert.deepEqual(snapshot(sql), before);
});

test('a begin without a token, a kind or a whole record is refused before anything is written', () => {
  const { sql } = desk();
  const before = snapshot(sql);
  assert.throws(() => goliveBegin(sql, 'site-a', { kind: 'switch', who: WHO, record: record(), now: T0 }), /needs a token/);
  assert.throws(() => goliveBegin(sql, 'site-a', { kind: 'switch', who: WHO, record: record(), token: '', now: T0 }), /needs a token/);
  assert.throws(() => goliveBegin(sql, 'site-a', { kind: 'verify', who: WHO, record: record(), token: 't', now: T0 }), /switch or a rollback/);
  assert.throws(() => begin(sql, 'site-a', 'switch', { rec: record({ worker: '' }) }), /needs worker/);
  assert.throws(() => begin(sql, 'site-a', 'switch', { rec: record({ hosts: [] }) }), /needs its hosts/);
  assert.throws(() => begin(sql, 'site-a', 'switch', { rec: null }), /needs zone_id/);
  assert.deepEqual(snapshot(sql), before);
});

test('the object undoes a whole store call when its transaction throws', () => {
  const storage = desk();
  const before = snapshot(storage.sql);
  assert.throws(() => storage.transactionSync(() => {
    assert.equal(begin(storage.sql, 'site-a', 'switch').ok, true);
    throw new Error('the object was cut off');
  }), /cut off/);
  assert.deepEqual(snapshot(storage.sql), before);
});

// ---- Steps and tokens ----

test('a step adds to the lists, sets fields, logs, and refreshes the heartbeat', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  assert.deepEqual(goliveStep(sql, 'site-a', 'switch-token', {
    log: [{ action: 'record-deleted', text: 'Deleted A acme.com → 192.0.2.10.', detail: RECORDS[0] }],
    add: { steps_done: ['deleted:rec-apex'] },
    who: WHO,
    now: at(5 * SEC),
  }), { ok: true });
  attach(sql, 'site-a', 'switch-token', at(10 * SEC));
  // The record Cloudflare made for each host: the whole list is replaced.
  goliveStep(sql, 'site-a', 'switch-token', {
    fields: { attached: ATTACHED.map((a, i) => ({ ...a, dns_id: 'dns-' + i })) },
    log: { action: 'dns-ids', text: 'Noted the DNS record Cloudflare made for each host.' },
    now: at(12 * SEC),
  });
  const rule = { ruleset_id: 'rs-1', rule_id: 'r-1', ref: 'desk-site-a' };
  goliveStep(sql, 'site-a', 'switch-token', {
    fields: { redirect_rule: rule }, add: { steps_done: ['redirect'] },
    log: { action: 'redirect-added', text: 'Added a 301 from www.acme.com to acme.com.' },
    now: at(15 * SEC),
  });

  const { golive, log } = goliveDetail(sql, 'site-a', at(15 * SEC));
  assert.deepEqual(golive.steps_done, ['deleted:rec-apex', 'attached:acme.com', 'attached:www.acme.com', 'redirect']);
  assert.deepEqual(golive.attached, [
    { id: 'cd-apex', hostname: 'acme.com', dns_id: 'dns-0' },
    { id: 'cd-www', hostname: 'www.acme.com', dns_id: 'dns-1' },
  ]);
  assert.deepEqual(golive.redirect_rule, rule);
  assert.deepEqual(golive.saved_records, RECORDS, 'the saved records are never touched by a step');
  assert.equal(golive.updated_at, at(15 * SEC));
  assert.equal(golive.state, 'switching');
  assert.deepEqual(log.map((e) => e.action),
    ['switch-started', 'record-deleted', 'domain-attached', 'domain-attached', 'dns-ids', 'redirect-added']);
  assert.equal(log[1].who, WHO);
  assert.deepEqual(log[1].detail, RECORDS[0]);
  assert.equal(log[1].at, at(5 * SEC));
  assert.equal(log[2].who, null);
  assert.equal(log[4].detail, null);
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
});

test('a step that would overwrite the rollback data, the state or the lock is refused whole', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  const before = snapshot(sql);
  const step = (opts) => goliveStep(sql, 'site-a', 'switch-token', { now: at(SEC), ...opts });
  for (const k of ['saved_records', 'saved_domains', 'hosts', 'state', 'run_token', 'mx_txt', 'previous_platform', 'verified_at', 'checks']) {
    assert.throws(() => step({ fields: { [k]: [] } }), /cannot set/, k);
  }
  assert.throws(() => step({ add: { saved_records: [{}] } }), /cannot add to saved_records/);
  assert.throws(() => step({ add: { attached: { id: 'x' } } }), /cannot add to attached/);
  assert.throws(() => step({ add: { steps_done: ['x'] }, log: [{ action: 'x' }] }), /needs an action and a text/);
  assert.throws(() => step({ log: [{ text: 'No action.' }] }), /needs an action and a text/);
  assert.deepEqual(snapshot(sql), before);
});

test('a run whose token no longer holds the row writes nothing at all', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch', { token: 'first' });
  attach(sql, 'site-a', 'first', T0, [ATTACHED[0]]);
  const before = snapshot(sql);
  const stepFrom = (token, now = at(SEC)) => goliveStep(sql, 'site-a', token, {
    add: { steps_done: ['attached:www.acme.com'] }, fields: { error: 'x' },
    log: { action: 'domain-attached', text: 'Attached www.acme.com.' }, now,
  });
  for (const token of ['second', '', null, undefined, 42]) {
    assert.deepEqual(stepFrom(token), { stale: true }, String(token));
    assert.deepEqual(goliveFinish(sql, 'site-a', token, { state: 'checking', platform: { to: 'astro' }, now: at(SEC) }), { stale: true });
  }
  assert.deepEqual(snapshot(sql), before);

  // A rollback takes the stale lock over. The first run, waking late, can
  // neither step nor finish, and the platform it would set stays as it was.
  assert.equal(begin(sql, 'site-a', 'rollback', { token: 'rescue', now: at(3 * MIN) }).ok, true);
  const taken = snapshot(sql);
  assert.deepEqual(stepFrom('first', at(3 * MIN + SEC)), { stale: true });
  assert.deepEqual(goliveFinish(sql, 'site-a', 'first', {
    state: 'checking', fields: { switched_at: at(3 * MIN) }, log: { action: 'switched', text: 'Switched.' },
    platform: { to: 'astro' }, now: at(3 * MIN + SEC),
  }), { stale: true });
  assert.deepEqual(snapshot(sql), taken);
  assert.equal(rawRow(sql, 'site-a').state, 'rolling-back');
  assert.equal(siteRow(sql, 'site-a').live_platform, 'wordpress');

  // The rescue run holds it, and once it finishes nobody does.
  assert.deepEqual(goliveStep(sql, 'site-a', 'rescue', { log: { action: 'domain-detached', text: 'Detached acme.com.' }, now: at(3 * MIN + SEC) }), { ok: true });
  assert.ok(goliveFinish(sql, 'site-a', 'rescue', { state: 'rolled-back', now: at(3 * MIN + 2 * SEC) }).golive);
  assert.equal(rawRow(sql, 'site-a').run_token, null);
  const done = snapshot(sql);
  assert.deepEqual(goliveFinish(sql, 'site-a', 'rescue', { state: 'rollback-failed', now: at(4 * MIN) }), { stale: true }, 'a run finishes once');
  assert.deepEqual(goliveFinish(sql, 'site-a', 'first', { state: 'checking', now: at(4 * MIN) }), { stale: true });
  assert.deepEqual(goliveStep(sql, 'site-a', 'rescue', { log: { action: 'x', text: 'Late.' }, now: at(4 * MIN) }), { stale: true });
  assert.deepEqual(goliveStep(sql, 'site-a', null, { now: at(4 * MIN) }), { stale: true }, 'a cleared token matches no run');
  assert.deepEqual(snapshot(sql), done);
});

// The object wrote the finish, but its answer was lost on the way back, and
// the route tries once more. That must not read as another run taking over.
test('a finish tried again by the same run answers what it saved, and writes nothing more', () => {
  const storage = desk();
  const { sql } = storage;
  begin(sql, 'site-a', 'switch', { token: 'run-1' });
  attach(sql, 'site-a', 'run-1', T0);
  const end = {
    state: 'checking', fields: { switched_at: at(SEC) }, log: { action: 'switched', text: 'Switched.' },
    platform: { to: 'astro' }, who: WHO, now: at(SEC),
  };
  const first = storage.transactionSync(() => goliveFinish(sql, 'site-a', 'run-1', end));
  assert.equal(first.golive.state, 'checking');
  const saved = snapshot(sql);
  const retry = storage.transactionSync(() => goliveFinish(sql, 'site-a', 'run-1', { ...end, now: at(2 * SEC) }));
  assert.deepEqual(retry, first);
  assert.deepEqual(snapshot(sql), saved, 'no second log entry, no new heartbeat');
  assert.ok(!('finished_token' in retry.golive), 'the token stays in the store');

  // Only the same run, finishing the same way, and only until the row moves on.
  assert.deepEqual(goliveFinish(sql, 'site-a', 'run-2', end), { stale: true });
  assert.deepEqual(goliveFinish(sql, 'site-a', 'run-1', { ...end, state: 'switch-failed' }), { stale: true });
  begin(sql, 'site-a', 'rollback', { token: 'rb', now: at(MIN) });
  assert.equal(rawRow(sql, 'site-a').finished_token, null);
  assert.deepEqual(goliveFinish(sql, 'site-a', 'run-1', end), { stale: true });
});

test('a step for a site with no go-live row is stale, not an error', () => {
  const { sql } = desk();
  assert.deepEqual(goliveStep(sql, 'site-a', 'any', { now: T0 }), { stale: true });
  assert.deepEqual(goliveFinish(sql, 'site-a', 'any', { state: 'checking', now: T0 }), { stale: true });
});

// ---- Finishing ----

test('a finished switch lets go of the row, sets Astro and answers the site with its summary', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  attach(sql, 'site-a', 'switch-token', at(SEC));
  const res = goliveFinish(sql, 'site-a', 'switch-token', {
    state: 'checking', fields: { switched_at: at(2 * SEC), error: 'The redirect rule was not added: limit reached.' },
    log: { action: 'switched', text: 'Switched acme.com and www.acme.com to staging-acme.' },
    platform: { to: 'astro' }, who: WHO, now: at(2 * SEC),
  });
  assert.equal(res.golive.state, 'checking');
  assert.equal(res.golive.switched_at, at(2 * SEC));
  assert.equal(res.golive.error, 'The redirect rule was not added: limit reached.');
  assert.equal(rawRow(sql, 'site-a').run_token, null);
  assert.equal(res.site.id, 'site-a');
  assert.equal(res.site.live_platform, 'astro');
  assert.equal(res.site.updated_at, at(2 * SEC));
  assert.equal(res.site.astro_staging, true, 'the site comes back as the page gets it');
  assert.deepEqual(res.site.golive, goliveSummary(rawRow(sql, 'site-a'), at(2 * SEC)));
  assert.equal(res.site.golive.all_attached, true);
  const last = logOf(sql, 'site-a').at(-1);
  assert.equal(last.action, 'switched');
  assert.equal(last.who, WHO);
});

test('a run finishes only as checking, switch-failed, rolled-back or rollback-failed', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  const before = snapshot(sql);
  for (const state of ['live', 'switching', 'rolling-back', undefined]) {
    assert.throws(() => goliveFinish(sql, 'site-a', 'switch-token', { state, now: T0 }), /cannot finish as/, String(state));
  }
  assert.throws(() => goliveFinish(sql, 'site-a', 'switch-token', { state: 'checking', fields: { state: 'live' }, now: T0 }), /cannot set state/);
  assert.throws(() => goliveFinish(sql, 'site-a', 'switch-token', { state: 'checking', platform: { to: 'wix' }, now: T0 }), /Not a platform/);
  assert.deepEqual(snapshot(sql), before);
});

test('a failed switch keeps its outcome: restored, error and notes', () => {
  const { sql } = desk();
  const res = failed(sql, 'site-a', 0);
  assert.equal(res.golive.state, 'switch-failed');
  assert.equal(res.golive.restored, 0);
  assert.deepEqual(res.golive.notes, ['A note.']);
  assert.equal(res.site.live_platform, 'wordpress', 'a failed switch never touched the platform');
  assert.equal(res.site.updated_at, CREATED);
  assert.equal(failed(desk().sql, 'site-a', true).golive.restored, 1, 'true is stored as 1');
});

test('a rollback puts the old platform back only over the Astro the switch set', () => {
  // The usual case: WordPress, then Astro, then WordPress again.
  {
    const { sql } = desk();
    switched(sql, 'site-a');
    assert.equal(siteRow(sql, 'site-a').live_platform, 'astro');
    assert.equal(siteRow(sql, 'site-a').updated_at, T0);
    const res = rolledBack(sql, 'site-a', { now: at(MIN) });
    assert.equal(res.site.live_platform, 'wordpress');
    assert.equal(res.site.updated_at, at(MIN));
    assert.equal(res.golive.rolled_back_by, WHO);
    assert.equal(res.golive.rolled_back_at, at(MIN));
  }
  // Someone set it by hand since the switch: the rollback leaves their answer.
  {
    const { sql } = desk();
    switched(sql, 'site-a');
    sql.exec("UPDATE sites SET live_platform = 'other', updated_at = ? WHERE id = 'site-a'", at(30 * SEC));
    const res = rolledBack(sql, 'site-a', { now: at(MIN) });
    assert.equal(res.site.live_platform, 'other');
    assert.equal(res.site.updated_at, at(30 * SEC));
  }
  // It was already Astro (a move from one Worker to another): nothing changes,
  // not even updated_at, so an editor open on the site sees no conflict.
  {
    const { sql } = desk();
    sql.exec("UPDATE sites SET live_platform = 'astro' WHERE id = 'site-a'");
    switched(sql, 'site-a');
    assert.equal(rawRow(sql, 'site-a').previous_platform, 'astro');
    assert.equal(siteRow(sql, 'site-a').updated_at, CREATED);
    rolledBack(sql, 'site-a');
    assert.deepEqual([siteRow(sql, 'site-a').live_platform, siteRow(sql, 'site-a').updated_at], ['astro', CREATED]);
  }
  // Not set before the switch: not set again after.
  {
    const { sql } = desk();
    sql.exec("UPDATE sites SET live_platform = NULL WHERE id = 'site-a'");
    switched(sql, 'site-a');
    assert.equal(rawRow(sql, 'site-a').previous_platform, null);
    assert.equal(rolledBack(sql, 'site-a').site.live_platform, null);
  }
  // A failed rollback leaves Astro in place, since the site is still on it.
  {
    const { sql } = desk();
    switched(sql, 'site-a');
    assert.equal(rolledBack(sql, 'site-a', { state: 'rollback-failed' }).site.live_platform, 'astro');
  }
});

// ---- Check now ----

test('a check that passes makes a checking row live, once', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  const waiting = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: false, who: WHO, now: at(10 * SEC) });
  assert.equal(waiting.golive.state, 'checking');
  assert.deepEqual(waiting.golive.checks, CHECKS);
  assert.equal(waiting.golive.verified_at, null);
  assert.equal(logOf(sql, 'site-a').at(-1).action, 'switched', 'a check still waiting is not logged');

  const passed = CHECKS.map((c) => ({ ...c, status: 'pass' }));
  const res = goliveSaveVerify(sql, 'site-a', { checks: passed, done: true, who: WHO, now: at(MIN) });
  assert.equal(res.golive.state, 'live');
  assert.equal(res.golive.verified_at, at(MIN));
  assert.deepEqual(res.golive.checks, passed);
  assert.equal(res.site.golive.state, 'live');
  const last = logOf(sql, 'site-a').at(-1);
  assert.deepEqual(last, {
    seq: last.seq, at: at(MIN), who: WHO, action: 'verified',
    text: 'Verified: acme.com serves the new site from staging-acme, and no check failed.',
    detail: { checks: passed },
  });

  // A later re-check that fails keeps the row live and shows what failed.
  const failing = [{ id: 'still-attached', label: 'Still attached', status: 'fail', detail: 'www.acme.com is no longer attached.' }];
  const again = goliveSaveVerify(sql, 'site-a', { checks: failing, done: false, now: at(10 * MIN) });
  assert.equal(again.golive.state, 'live');
  assert.equal(again.golive.verified_at, at(MIN));
  assert.deepEqual(again.golive.checks, failing);
  goliveSaveVerify(sql, 'site-a', { checks: passed, done: true, now: at(11 * MIN) });
  assert.equal(goliveDetail(sql, 'site-a', at(11 * MIN)).golive.verified_at, at(MIN));
  assert.equal(logOf(sql, 'site-a').filter((e) => e.action === 'verified').length, 1);
});

test('a stale switch that attached every host moves on to checking', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch', { token: 'lost' });
  attach(sql, 'site-a', 'lost', at(10 * SEC));
  const now = at(10 * SEC + 2 * MIN + 1);
  const res = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: false, who: WHO, now });
  assert.equal(res.golive.state, 'checking');
  assert.equal(res.golive.stale, false);
  assert.equal(res.golive.switched_at, at(10 * SEC), 'its last step is when it switched');
  assert.equal(rawRow(sql, 'site-a').run_token, null);
  assert.equal(res.site.live_platform, 'astro', 'as a finished switch would have set it');
  assert.deepEqual(res.site.golive, goliveSummary(rawRow(sql, 'site-a'), now));
  const last = logOf(sql, 'site-a').at(-1);
  assert.equal(last.action, 'resumed');
  assert.equal(last.who, WHO);
  assert.equal(last.text, 'The switch stopped part-way after every host was attached to staging-acme, so the desk moved on to checking it.');
  assert.deepEqual(last.detail, { last_step_at: at(10 * SEC) });

  // The lost run, if it ever wakes, writes nothing.
  assert.deepEqual(goliveStep(sql, 'site-a', 'lost', { log: { action: 'x', text: 'Late.' }, now }), { stale: true });

  // Rolling it back later restores WordPress over the Astro it set.
  assert.equal(rolledBack(sql, 'site-a', { now: at(5 * MIN) }).site.live_platform, 'wordpress');
});

test('a stale switch that passes every check goes straight on to live', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  attach(sql, 'site-a', 'switch-token', T0);
  const res = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, now: at(3 * MIN) });
  assert.equal(res.golive.state, 'live');
  assert.equal(res.golive.switched_at, T0);
  assert.equal(res.golive.verified_at, at(3 * MIN));
  assert.deepEqual(logOf(sql, 'site-a').slice(-2).map((e) => e.action), ['resumed', 'verified']);
});

// Check now reads the row, then spends tens of seconds on the network. If
// the go-live was rolled back and switched again meanwhile, what it found
// was about the old run, and must never mark the new one live.
test('a verification saved for an earlier run is refused, and writes nothing', () => {
  const { sql } = desk();
  switched(sql, 'site-a', { token: 'run-1' });
  const seen = goliveDetail(sql, 'site-a', at(10 * SEC)).golive;
  rolledBack(sql, 'site-a', { now: at(30 * SEC) });
  switched(sql, 'site-a', { token: 'run-2', now: at(50 * SEC) });
  const before = snapshot(sql);
  const res = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, for_started_at: seen.started_at, who: WHO, now: at(55 * SEC) });
  assert.equal(res.notSwitched, true);
  assert.equal(res.golive.state, 'checking');
  assert.equal(res.golive.started_at, at(50 * SEC));
  assert.deepEqual(snapshot(sql), before);

  const now = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, for_started_at: at(50 * SEC), now: at(56 * SEC) });
  assert.equal(now.golive.state, 'live', 'a check of this run still counts');
});

test('a redirect rule the switch could not confirm, found since, is noted and its error cleared', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  attach(sql, 'site-a', 'switch-token', T0);
  goliveFinish(sql, 'site-a', 'switch-token', {
    state: 'checking', fields: { switched_at: T0, error: 'Could not reach Cloudflare: timeout.' }, now: T0,
  });
  const rule = { ruleset_id: 'rs-1', rule_id: 'r-1', ref: 'desk-site-a' };
  const res = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: false, redirect_rule: rule, for_started_at: T0, who: WHO, now: at(MIN) });
  assert.deepEqual(res.golive.redirect_rule, rule);
  assert.equal(res.golive.error, null);
  assert.equal(res.site.golive.has_error, false);
  const last = logOf(sql, 'site-a').at(-1);
  assert.equal(last.action, 'redirect-found');
  assert.equal(last.text, 'Found the redirect rule from www.acme.com to acme.com that the switch could not confirm, and noted it.');
  assert.deepEqual(last.detail, { redirect_rule: rule });

  // Once noted it stays; a rule for another ref is not this row's.
  const other = { ruleset_id: 'rs-1', rule_id: 'r-9', ref: 'desk-site-b' };
  goliveSaveVerify(sql, 'site-a', { checks: CHECKS, redirect_rule: { ...rule, rule_id: 'r-2' }, now: at(2 * MIN) });
  assert.deepEqual(rawRow(sql, 'site-a').redirect_rule, JSON.stringify(rule));
  const b = desk().sql;
  switched(b, 'site-a');
  goliveSaveVerify(b, 'site-a', { checks: CHECKS, redirect_rule: other, now: at(MIN) });
  assert.equal(rawRow(b, 'site-a').redirect_rule, null);
  assert.equal(logOf(b, 'site-a').at(-1).action, 'switched');
});

test('a stale switch missing a host cannot be checked: only a Roll back helps it', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  attach(sql, 'site-a', 'switch-token', T0, [ATTACHED[0]]);
  const before = snapshot(sql);
  const res = goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, now: at(3 * MIN) });
  assert.equal(res.notSwitched, true);
  assert.equal(res.golive.state, 'switching');
  assert.equal(res.golive.stale, true);
  assert.deepEqual(snapshot(sql), before);
});

// ---- The hostname lock ----

test('the hostname lock finds another site\'s go-live on the same host, whatever its case', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  const expected = [{ site_id: 'site-a', name: 'Acme', state: 'checking', hosts: ['www.acme.com'] }];
  assert.deepEqual(goliveHostsInUse(sql, 'site-b', ['WWW.Acme.com', 'other.com']), expected);
  assert.deepEqual(goliveHostsInUse(sql, 'site-b', [{ hostname: 'www.acme.com', role: 'main' }]), expected);
  assert.deepEqual(goliveHostsInUse(sql, 'site-b', ['acme.com', 'www.acme.com'])[0].hosts, ['acme.com', 'www.acme.com']);
  assert.deepEqual(goliveHostsInUse(sql, 'site-b', ['shop.acme.com']), []);
  assert.deepEqual(goliveHostsInUse(sql, 'site-a', ['acme.com']), [], 'a site never locks itself out');
  assert.deepEqual(goliveHostsInUse(sql, 'site-b', []), []);
});

test('a switch is refused on a host another site holds, and writes nothing', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  const before = snapshot(sql);
  const res = begin(sql, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'www.acme.com', role: 'main' }] }) });
  assert.deepEqual(res, { busy: true, golive: null, reason: 'www.acme.com has an unfinished or live go-live on Acme.' });
  assert.deepEqual(snapshot(sql), before);

  // Once site-a is rolled back, its hosts are free.
  goliveFinish(sql, 'site-a', 'switch-token', { state: 'switch-failed', fields: { restored: 1 }, now: at(SEC) });
  assert.equal(begin(sql, 'site-b', 'switch', { token: 'b', now: at(MIN) }).ok, true);
  assert.equal(begin(sql, 'site-a', 'switch', { token: 'a2', now: at(MIN) }).busy, true, 'and now site-b holds them');
});

test('a deleted site\'s live go-live does not hold its hosts for ever', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, now: at(MIN) });
  assert.equal(goliveBlocksDelete(sql, 'site-a'), false);
  sql.exec("DELETE FROM sites WHERE id = 'site-a'");
  assert.deepEqual(goliveHostsInUse(sql, 'site-b', ['acme.com']), []);
  assert.equal(begin(sql, 'site-b', 'switch', { token: 'b', now: at(2 * MIN) }).ok, true);
  assert.equal(goliveDetail(sql, 'site-a', at(2 * MIN)).golive.state, 'live', 'the row and log stay');
  assert.equal(logOf(sql, 'site-a').length > 0, true);
});

// ---- The log ----

test('the log is append-only: a second go-live replaces the row, never the log', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, now: at(10 * SEC) });
  rolledBack(sql, 'site-a', { now: at(MIN) });

  const second = [{ ...RECORDS[0], id: 'rec-apex-2', content: '192.0.2.99' }];
  const res = begin(sql, 'site-a', 'switch', {
    token: 'second', now: at(2 * MIN), rec: record({ saved_records: second, redirect: null, hosts: [HOSTS[0]] }),
  });
  assert.equal(res.ok, true);
  // Everything the last run left is cleared for this one.
  const g = res.golive;
  assert.deepEqual(g.saved_records, second);
  assert.deepEqual(g.hosts, [HOSTS[0]]);
  assert.deepEqual([g.attached, g.steps_done], [[], []]);
  for (const k of ['redirect', 'redirect_rule', 'restored', 'checks', 'notes', 'error', 'switched_at', 'verified_at', 'rolled_back_by', 'rolled_back_at']) {
    assert.equal(g[k], null, k);
  }
  assert.equal(g.previous_platform, 'wordpress');
  assert.equal(g.started_at, at(2 * MIN));

  const log = logOf(sql, 'site-a');
  assert.deepEqual(log.map((e) => e.action), [
    'switch-started', 'domain-attached', 'domain-attached', 'switched', 'verified',
    'rollback-started', 'rolled-back', 'switch-started',
  ]);
  const starts = log.filter((e) => e.action === 'switch-started');
  assert.deepEqual(starts.map((e) => e.detail.saved_records), [RECORDS, second], 'both runs\' saved records stay on record');
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
});

test('the rollback-started entry names the hosts, the acks, and a lock it took over', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  const oldHost = [...ACKS, { id: 'old-host', label: 'The old host is still ours' }];
  begin(sql, 'site-a', 'rollback', { now: at(3 * MIN), acks: oldHost });
  const last = logOf(sql, 'site-a').at(-1);
  assert.equal(last.text, 'ana@example.com started rolling back acme.com and www.acme.com. It takes over a switch that stopped part-way.');
  assert.deepEqual(last.detail, { acks: oldHost, previous_state: 'switching', stale: true });

  const other = desk().sql;
  switched(other, 'site-a');
  begin(other, 'site-a', 'rollback', { now: at(MIN), acks: [] });
  const plain = logOf(other, 'site-a').at(-1);
  assert.equal(plain.text, 'ana@example.com started rolling back acme.com and www.acme.com.');
  assert.deepEqual(plain.detail, { acks: [], previous_state: 'checking', stale: false });
});

test('the detail answers the last hundred log entries, oldest first, for that site only', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  begin(sql, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'b.example', role: 'main' }] }) });
  for (let i = 1; i <= 120; i++) {
    goliveStep(sql, 'site-a', 'switch-token', { log: { action: 'step', text: `Step ${i}.`, detail: { i } }, now: at(i) });
  }
  const { log } = goliveDetail(sql, 'site-a', at(MIN));
  assert.equal(log.length, 100);
  assert.equal(log[0].text, 'Step 21.');
  assert.deepEqual(log[0].detail, { i: 21 });
  assert.equal(log[99].text, 'Step 120.');
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
  assert.deepEqual(Object.keys(log[0]).sort(), ['action', 'at', 'detail', 'seq', 'text', 'who']);
  assert.deepEqual(goliveDetail(sql, 'site-b', at(MIN)).log.map((e) => e.action), ['switch-started']);
  assert.deepEqual(goliveDetail(sql, 'nope', at(MIN)), { golive: null, log: [] });
});

test('every sentence the store writes itself is plain text', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  goliveSaveVerify(sql, 'site-a', { checks: CHECKS, done: true, now: at(MIN) });
  rolledBack(sql, 'site-a', { now: at(2 * MIN) });
  const b = desk().sql;
  begin(b, 'site-a', 'switch');
  attach(b, 'site-a', 'switch-token', T0);
  goliveSaveVerify(b, 'site-a', { checks: CHECKS, done: false, now: at(3 * MIN) });
  const own = ['switch-started', 'rollback-started', 'verified', 'resumed'];
  const entries = [...logOf(sql, 'site-a'), ...logOf(b, 'site-a')].filter((e) => own.includes(e.action));
  assert.deepEqual([...new Set(entries.map((e) => e.action))].sort(), [...own].sort());
  for (const e of entries) {
    assert.match(e.text, /^[A-Za-z0-9].*\.$/, e.action);
    assert.doesNotMatch(e.text, /[<>`*_]/, e.action);
  }
});

// ---- Summaries ----

test('a summary carries where the go-live stands and no records', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  attach(sql, 'site-a', 'switch-token', at(SEC), [ATTACHED[0]]);
  const row = rawRow(sql, 'site-a');
  const s = goliveSummary(row, at(2 * SEC));
  assert.deepEqual(s, {
    state: 'switching', stale: false, main_host: 'acme.com', hosts: HOSTS, worker: 'staging-acme',
    started_by: WHO, started_at: T0, switched_at: null, verified_at: null, rolled_back_by: null, rolled_back_at: null,
    updated_at: at(SEC), restored: null, all_attached: false, has_error: false, error_kind: null,
  });
  assert.doesNotMatch(JSON.stringify(s), /192\.0\.2\.10|rec-apex|mx1\.mail|gate12|zone-acme/);

  attach(sql, 'site-a', 'switch-token', at(2 * SEC), [ATTACHED[1]]);
  const later = goliveSummary(rawRow(sql, 'site-a'), at(3 * MIN));
  assert.equal(later.all_attached, true);
  assert.equal(later.stale, true);
  assert.equal(goliveSummary({ ...row, hosts: '[]', attached: '[]' }, T0).all_attached, false, 'no hosts is not all attached');
  assert.equal(goliveSummary(null, T0), null);
  assert.equal(goliveSummary(undefined, T0), null);
  assert.deepEqual(goliveSummary(goliveDetail(sql, 'site-a', T0).golive, at(3 * MIN)), later, 'a parsed row gives the same summary');
});

// The list goes to anyone with the desk key, without an Access login. An
// error can quote a saved record in full, including the origin address a
// proxied record hides, so the list says only that there was one, and what
// kind. The detail, behind Access, keeps the words.
test('the list says whether a go-live has an error and what kind, never the error itself', () => {
  const error = 'Could not delete A acme.com → 203.0.113.5 (proxied, TTL auto). Cloudflare said: x. '
    + 'Not everything was put back: A acme.com → 203.0.113.5 (proxied, TTL auto) is not back.';
  const ended = (state, fields) => (sql) => {
    begin(sql, 'site-a', 'switch');
    goliveFinish(sql, 'site-a', 'switch-token', { state, fields: { ...fields, error }, now: T0 });
  };
  const kinds = [
    ['switch-failed', ended('switch-failed', { restored: 0 }), 'The switch failed.'],
    ['checking', ended('checking', { switched_at: T0 }), 'The redirect rule was not added.'],
    ['rollback-failed', (sql) => {
      switched(sql, 'site-a');
      rolledBack(sql, 'site-a', { state: 'rollback-failed' });
      sql.exec('UPDATE golive SET error = ?', error);
    }, 'The roll back failed.'],
  ];
  for (const [state, make, kind] of kinds) {
    const { sql } = desk();
    make(sql);
    const listed = goliveSummaries(sql, at(MIN)).get('site-a');
    assert.equal(listed.state, state);
    assert.equal(listed.has_error, true, state);
    assert.equal(listed.error_kind, kind, state);
    assert.ok(!('error' in listed), state);
    assert.doesNotMatch(JSON.stringify([listed, siteWithGolive(sql, 'site-a', at(MIN))]), /203\.0\.113\.5|Cloudflare said/, state);
    assert.match(goliveDetail(sql, 'site-a', at(MIN)).golive.error, /203\.0\.113\.5/, 'the detail keeps it');
  }
  const { sql } = desk();
  switched(sql, 'site-a');
  assert.deepEqual([goliveSummaries(sql, T0).get('site-a').has_error, goliveSummaries(sql, T0).get('site-a').error_kind], [false, null]);
});

// Desk.list() reads every site's summary at once: one row it cannot read
// must not take the list down for every other site.
test('a go-live row the desk cannot read shows as unreadable, and every other site still lists', () => {
  const { sql } = desk();
  addSite(sql, 'site-c', 'Calm Co');
  switched(sql, 'site-a');
  begin(sql, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'b.example', role: 'main' }], main_host: 'b.example' }) });
  begin(sql, 'site-c', 'switch', { token: 'c', rec: record({ hosts: [{ hostname: 'c.example', role: 'main' }], main_host: 'c.example' }) });
  const good = goliveSummaries(sql, T0).get('site-b');
  sql.exec(`UPDATE golive SET hosts = '[{"hostname":' WHERE site_id = 'site-a'`);
  sql.exec(`UPDATE golive SET attached = '{"id":"cd-0"}' WHERE site_id = 'site-c'`);
  const map = goliveSummaries(sql, T0);
  assert.deepEqual(map.get('site-b'), good);
  for (const id of ['site-a', 'site-c']) {
    const s = map.get(id);
    assert.equal(s.state, 'unreadable', id);
    assert.deepEqual([s.hosts, s.stale, s.all_attached, s.has_error], [[], false, false, true], id);
    assert.equal(s.error_kind, 'The desk cannot read this go-live record.');
    assert.equal(siteWithGolive(sql, id, T0).golive.state, 'unreadable');
  }
  assert.equal(map.get('site-a').main_host, 'acme.com', 'plain columns still show');

  // The detail says so too, without a throw; so does a log entry's detail.
  sql.exec(`UPDATE golive_log SET detail = '{"oops' WHERE site_id = 'site-c'`);
  const detail = goliveDetail(sql, 'site-c', T0);
  assert.equal(detail.golive.state, 'unreadable');
  assert.equal(detail.golive.attached, null);
  assert.equal(detail.golive.hosts, null);
  assert.equal(detail.log[0].detail, null);
  assert.equal(detail.log[0].action, 'switch-started');
  assert.equal(goliveAllows(detail.golive, 'verify', T0), false);
  assert.equal(goliveAllows(detail.golive, 'rollback', T0), false);

  // Saved records written twice over as JSON are not a list either.
  const other = desk().sql;
  switched(other, 'site-a');
  other.exec(`UPDATE golive SET saved_records = '"[]"'`);
  assert.equal(goliveDetail(other, 'site-a', T0).golive.state, 'unreadable');
});

test('a step or finish that sets attached, steps_done or notes to anything but a list is refused whole', () => {
  const { sql } = desk();
  begin(sql, 'site-a', 'switch');
  const before = snapshot(sql);
  for (const [k, v] of [
    ['attached', { id: 'cd-0', hostname: 'acme.com', dns_id: 'd' }], ['attached', null], ['steps_done', 'deleted:x'],
    ['notes', 'A note.'], ['notes', { 0: 'A note.' }],
  ]) {
    assert.throws(() => goliveStep(sql, 'site-a', 'switch-token', { fields: { [k]: v }, now: at(SEC) }), /must set .* to a list/, k);
    assert.throws(() => goliveFinish(sql, 'site-a', 'switch-token', { state: 'switch-failed', fields: { [k]: v }, now: at(SEC) }), /to a list/, k);
  }
  assert.deepEqual(snapshot(sql), before);
  assert.doesNotThrow(() => goliveSummaries(sql, T0));
  assert.deepEqual(goliveStep(sql, 'site-a', 'switch-token', { fields: { attached: [], notes: [] }, now: at(SEC) }), { ok: true });
});

test('a begin whose hosts are not hostnames is refused before anything is written', () => {
  const { sql } = desk();
  const before = snapshot(sql);
  for (const hosts of [[null], ['acme.com'], [{ hostname: '' }], [{ role: 'main' }], { hostname: 'acme.com' }]) {
    assert.throws(() => begin(sql, 'site-a', 'switch', { rec: record({ hosts }) }), /needs its hosts/, JSON.stringify(hosts));
  }
  assert.deepEqual(snapshot(sql), before);
});

test('the list gets every summary from one query, keyed by site', () => {
  const { sql } = desk();
  addSite(sql, 'site-c', 'Calm Co');
  switched(sql, 'site-a');
  begin(sql, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'b.example', role: 'main' }], main_host: 'b.example' }) });
  const map = goliveSummaries(sql, at(3 * MIN));
  assert.ok(map instanceof Map);
  assert.deepEqual([...map.keys()].sort(), ['site-a', 'site-b']);
  assert.deepEqual(map.get('site-a'), goliveSummary(rawRow(sql, 'site-a'), at(3 * MIN)));
  assert.equal(map.get('site-a').all_attached, true);
  assert.equal(map.get('site-b').stale, true);
  assert.equal(map.get('site-b').all_attached, false);
  assert.equal(map.get('site-c'), undefined);
  assert.deepEqual(goliveSummaries(desk().sql, T0), new Map());
});

test('a site read for the page carries its summary, or null', () => {
  const { sql } = desk();
  switched(sql, 'site-a');
  const a = siteWithGolive(sql, 'site-a', at(MIN));
  assert.equal(a.name, 'Acme');
  assert.equal(a.astro_staging, true);
  assert.equal(a.domain_ours, null);
  assert.deepEqual(a.golive, goliveSummary(rawRow(sql, 'site-a'), at(MIN)));
  assert.equal(siteWithGolive(sql, 'site-b', at(MIN)).golive, null);
  assert.equal(siteWithGolive(sql, 'nope', at(MIN)), null);
});

// ---- The last check ----

test('the last check is kept per site, and a new one replaces it', () => {
  const { sql } = desk();
  assert.equal(goliveLastCheck(sql, 'site-a'), null);
  const friday = [...ACKS, { id: 'friday', label: 'It is Friday and this cannot wait' }];
  assert.deepEqual(
    goliveSaveCheck(sql, 'site-a', { plan_hash: 'a'.repeat(64), include_pair: true, ready: false, acks: friday, who: WHO, now: T0 }),
    { site_id: 'site-a', plan_hash: 'a'.repeat(64), checks_hash: '', include_pair: true, ready: false, acks: friday, checked_by: WHO, checked_at: T0 }
  );
  goliveSaveCheck(sql, 'site-a', {
    plan_hash: 'b'.repeat(64), checks_hash: 'c'.repeat(64), include_pair: false, ready: true, acks: ACKS, who: 'ben@example.org', now: at(MIN),
  });
  assert.deepEqual(goliveLastCheck(sql, 'site-a'), {
    site_id: 'site-a', plan_hash: 'b'.repeat(64), checks_hash: 'c'.repeat(64), include_pair: false, ready: true, acks: ACKS,
    checked_by: 'ben@example.org', checked_at: at(MIN),
  });
  assert.equal(goliveLastCheck(sql, 'site-b'), null);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM golive_checks').one().n, 1);
});
