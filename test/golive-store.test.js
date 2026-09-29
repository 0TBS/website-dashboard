import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './pglite.js';
import { transaction, numbered } from '../src/db.js';
import { migrate, MIGRATIONS } from '../src/schema.js';
import * as store from '../src/golive-store.js';
import { goliveStale, goliveAllows, goliveSummary, STALE_AFTER } from '../src/golive-store.js';

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

// One database for the whole file, emptied for each desk: a fresh PGlite
// takes seconds to start, and this file makes over a hundred desks. Only the
// newest desk may be used; an older one throws rather than quietly read the
// newer one's rows.
const shared = await freshDatabase();
let newest = null;

// PGlite keeps the process alive until it is closed.
after(() => shared.db.close());

const TABLES = 'sites, golive, golive_log, golive_checks, site_services, site_contacts, site_domains, history, desk_meta';

// → a desk: the database, emptied, with two sites on the same domain. Pass
// it where the tests used to pass `sql`.
async function desk() {
  await transaction(shared.connect, (tx) => tx.run(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`), { write: true });
  const db = {
    connect: () => {
      if (newest !== db) throw new Error('This desk was emptied for a newer one.');
      return shared.connect();
    },
  };
  newest = db;
  await addSite(db, 'site-a', 'Acme');
  await addSite(db, 'site-b', 'Acme (new build)');
  return db;
}

// Raw SQL on the desk, for a test that looks underneath or changes a row
// behind the store's back. Each is a transaction of its own.
const rows = (db, text, ...params) => transaction(db.connect, (tx) => tx.rows(text, ...params));
const exec = (db, text, ...params) => transaction(db.connect, (tx) => tx.run(text, ...params), { write: true });

function addSite(db, id, name, live_platform = 'wordpress') {
  return exec(db,
    `INSERT INTO sites (id, name, live_domain, staging_domain, live_platform, astro_staging, created_at, updated_at)
     VALUES (?, ?, 'acme.com', 'staging-acme.10xid.com', ?, 1, ?, ?)`,
    id, name, live_platform, CREATED, CREATED
  );
}

// The store's functions as store.js calls them: each in a transaction of its
// own, a write one for those that write. A write that throws still commits
// whatever it wrote before the throw, as a bare sql.exec() in the Durable
// Object did, so a test that a refused call wrote nothing proves the store
// checks before it writes, not that a rollback hid what it wrote.
const reading = (fn) => (db, ...args) => transaction(db.connect, (tx) => fn(tx, ...args));
const writing = (fn) => async (db, ...args) => {
  let failure = null;
  const out = await transaction(db.connect, async (tx) => {
    try {
      return await fn(tx, ...args);
    } catch (e) {
      failure = { e };
      return null;
    }
  }, { write: true });
  if (failure) throw failure.e;
  return out;
};

const goliveSummaries = reading(store.goliveSummaries);
const siteWithGolive = reading(store.siteWithGolive);
const goliveDetail = reading(store.goliveDetail);
const goliveLastCheck = reading(store.goliveLastCheck);
const goliveHostsInUse = reading(store.goliveHostsInUse);
const goliveBlocksDelete = reading(store.goliveBlocksDelete);
const goliveSaveCheck = writing(store.goliveSaveCheck);
const goliveBegin = writing(store.goliveBegin);
const goliveStep = writing(store.goliveStep);
const goliveFinish = writing(store.goliveFinish);
const goliveSaveVerify = writing(store.goliveSaveVerify);

const rawRow = async (db, id) => (await rows(db, 'SELECT * FROM golive WHERE site_id = ?', id))[0];
const siteRow = async (db, id) => (await rows(db, 'SELECT * FROM sites WHERE id = ?', id))[0];
const logOf = async (db, id) => (await goliveDetail(db, id, T0)).log;

// Everything the store can write, to prove a refused call wrote none of it.
// One read transaction, so the four agree.
const snapshot = (db) => transaction(db.connect, async (tx) => ({
  golive: await tx.rows('SELECT * FROM golive ORDER BY site_id'),
  log: await tx.rows('SELECT * FROM golive_log ORDER BY seq'),
  sites: await tx.rows('SELECT * FROM sites ORDER BY id'),
  checks: await tx.rows('SELECT * FROM golive_checks ORDER BY site_id'),
}));

// The steps of a real run, as the routes take them.
const begin = (db, id, kind, { token = kind + '-token', now = T0, rec = record(), acks = ACKS } = {}) =>
  goliveBegin(db, id, { kind, who: WHO, record: rec, acks, token, now });

const attach = (db, id, token, now, list = ATTACHED) => goliveStep(db, id, token, {
  add: { attached: list, steps_done: list.map((a) => 'attached:' + a.hostname) },
  log: list.map((a) => ({ action: 'domain-attached', text: `Attached ${a.hostname} to staging-acme.`, detail: a })),
  now,
});

async function switched(db, id, { token = 'switch-token', now = T0 } = {}) {
  await begin(db, id, 'switch', { token, now });
  await attach(db, id, token, now);
  return goliveFinish(db, id, token, {
    state: 'checking', fields: { switched_at: now, error: null },
    log: { action: 'switched', text: 'Switched acme.com and www.acme.com to staging-acme.' },
    platform: { to: 'astro' }, who: WHO, now,
  });
}

async function rolledBack(db, id, { state = 'rolled-back', token = 'rollback-token', now = at(MIN) } = {}) {
  await begin(db, id, 'rollback', { token, now });
  const { golive } = await goliveDetail(db, id, now);
  return goliveFinish(db, id, token, {
    state, fields: { rolled_back_by: WHO, rolled_back_at: now, error: state === 'rolled-back' ? null : 'Cloudflare said: no.' },
    log: { action: state, text: 'Rolled back acme.com and www.acme.com.' },
    platform: state === 'rolled-back' ? { to: golive.previous_platform, onlyIf: 'astro' } : null, who: WHO, now,
  });
}

const failed = async (db, id, restored) => {
  await begin(db, id, 'switch');
  return goliveFinish(db, id, 'switch-token', {
    state: 'switch-failed', fields: { restored, error: 'Cloudflare said: Record does not exist. (code 81044)', notes: ['A note.'] },
    log: { action: 'switch-failed', text: 'The switch failed.' }, now: T0,
  });
};

// Puts site-a into each state of the state table the way a real run gets
// there, and answers the time to act at.
const STATES = {
  'no row': async () => at(MIN),
  switching: async (db) => { await begin(db, 'site-a', 'switch'); return at(MIN); },
  'switching, every host attached': async (db) => {
    await begin(db, 'site-a', 'switch');
    await attach(db, 'site-a', 'switch-token', T0);
    return at(MIN);
  },
  'switching, stale': async (db) => { await begin(db, 'site-a', 'switch'); return at(3 * MIN); },
  'switching, stale, every host attached': async (db) => {
    await begin(db, 'site-a', 'switch');
    await attach(db, 'site-a', 'switch-token', T0);
    return at(3 * MIN);
  },
  checking: async (db) => { await switched(db, 'site-a'); return at(MIN); },
  live: async (db) => {
    await switched(db, 'site-a');
    await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, now: at(MIN) });
    return at(2 * MIN);
  },
  'switch-failed, put back': async (db) => { await failed(db, 'site-a', 1); return at(MIN); },
  'switch-failed, not all put back': async (db) => { await failed(db, 'site-a', 0); return at(MIN); },
  'rolling-back': async (db) => {
    await switched(db, 'site-a');
    await begin(db, 'site-a', 'rollback', { now: at(MIN) });
    return at(2 * MIN);
  },
  'rolling-back, stale': async (db) => {
    await switched(db, 'site-a');
    await begin(db, 'site-a', 'rollback', { now: at(MIN) });
    return at(4 * MIN);
  },
  'rolled-back': async (db) => { await switched(db, 'site-a'); await rolledBack(db, 'site-a'); return at(2 * MIN); },
  'rollback-failed': async (db) => {
    await switched(db, 'site-a');
    await rolledBack(db, 'site-a', { state: 'rollback-failed' });
    return at(2 * MIN);
  },
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

async function inState(name) {
  const db = await desk();
  const now = await STATES[name](db);
  return { db, now };
}

// ---- The database: Postgres behind db.js, as the store uses it ----

test('a transaction reads like the object\'s sql.exec: ? placeholders, every row, the first row or null', async () => {
  const db = await desk();
  assert.equal(numbered('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  // A value is never SQL, whatever it holds: quotes, ';', '?' or '--'.
  const odd = "x;y 'z' ? -- not a comment";
  const answer = await transaction(db.connect, async (tx) => [
    await tx.run('INSERT INTO desk_meta (key, value) VALUES (?, ?), (?, ?)', 'a', odd, 'b', '2'),
    await tx.rows('SELECT key, value FROM desk_meta ORDER BY key'),
    await tx.row('SELECT value FROM desk_meta WHERE key = ?', 'b'),
    await tx.row('SELECT value FROM desk_meta WHERE key = ?', 'nope'),
  ], { write: true });
  assert.deepEqual(answer, [undefined, [{ key: 'a', value: odd }, { key: 'b', value: '2' }], { value: '2' }, null]);
  assert.deepEqual(await rows(db, 'SELECT COUNT(*)::int AS n, 1::smallint AS flag FROM desk_meta'), [{ n: 2, flag: 1 }],
    'numbers come back as numbers');
});

test('a read cannot write, a flag takes only a number, and every JSON column is stored as JSON text', async () => {
  const db = await desk();
  await assert.rejects(transaction(db.connect, (tx) => tx.run("UPDATE sites SET name = 'x'")), /read-only transaction/);
  await assert.rejects(exec(db, 'UPDATE sites SET astro_staging = ?', true), /smallint/, 'true must be stored as 1');
  // Postgres takes an object for a TEXT column and stores "[object Object]",
  // so a forgotten JSON.stringify shows only in what the row holds.
  await switched(db, 'site-a');
  const raw = await rawRow(db, 'site-a');
  for (const c of ['hosts', 'saved_records', 'saved_domains', 'redirect', 'attached', 'steps_done', 'mx_txt', 'acks']) {
    assert.equal(typeof raw[c], 'string', c);
    assert.doesNotThrow(() => JSON.parse(raw[c]), c);
  }
  assert.deepEqual(JSON.parse(raw.saved_records), RECORDS);
});

test('a transaction commits and returns what it returns, and undoes everything when it throws, even after an await', async () => {
  const db = await desk();
  const put = (tx, key) => tx.run('INSERT INTO desk_meta (key, value) VALUES (?, ?)', key, 'x');
  assert.equal(await transaction(db.connect, async (tx) => { await put(tx, '1'); return 'done'; }, { write: true }), 'done');
  await assert.rejects(transaction(db.connect, async (tx) => {
    await put(tx, '2');
    await new Promise((resolve) => setTimeout(resolve, 1));
    await put(tx, '3');
    throw new Error('boom');
  }, { write: true }), /boom/);
  // A statement Postgres refuses undoes the whole transaction too, and the
  // connection is let go for the next one.
  await assert.rejects(transaction(db.connect, async (tx) => {
    await put(tx, '4');
    await put(tx, '4');
  }, { write: true }), /duplicate key/);
  await transaction(db.connect, (tx) => put(tx, '5'), { write: true });
  assert.deepEqual((await rows(db, 'SELECT key FROM desk_meta ORDER BY key')).map((r) => r.key), ['1', '5']);
});

// ---- Schema ----

test('the migrations can run again and again without touching what is there', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  await goliveSaveCheck(db, 'site-a', { plan_hash: 'h', include_pair: true, ready: true, acks: ACKS, who: WHO, now: T0 });
  const before = await snapshot(db);
  assert.equal(await migrate(db.connect), MIGRATIONS.length);
  assert.equal(await migrate(db.connect), MIGRATIONS.length);
  assert.deepEqual(await snapshot(db), before);
  const names = (await rows(db,
    `SELECT relname AS name FROM pg_class
     WHERE relnamespace = current_schema()::regnamespace AND relname LIKE 'golive%' AND relkind IN ('r', 'i')
       AND relname NOT LIKE '%_pkey'`
  )).map((r) => r.name).sort();
  assert.deepEqual(names, ['golive', 'golive_checks', 'golive_log', 'golive_log_site']);
  const columns = (await rows(db,
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sites'"
  )).map((r) => r.column_name);
  assert.ok(columns.includes('live_platform'), 'the sites table has what the go-live writes');
});

// ---- The state table ----

for (const [name, canSwitch, canRollBack, canVerify, blocksDelete, holdsHosts] of TABLE) {
  test(`state table: ${name}`, async () => {
    // Go live.
    {
      const { db, now } = await inState(name);
      const row = await rawRow(db, 'site-a');
      assert.equal(goliveAllows(row, 'switch', now), canSwitch);
      const before = await snapshot(db);
      const res = await goliveBegin(db, 'site-a', { kind: 'switch', who: WHO, record: record(), acks: ACKS, token: 'new-token', now });
      if (canSwitch) {
        assert.equal(res.ok, true);
        assert.equal(res.golive.state, 'switching');
        assert.equal((await rawRow(db, 'site-a')).run_token, 'new-token');
        assert.equal((await logOf(db, 'site-a')).at(-1).action, 'switch-started');
      } else {
        assert.equal(res.busy, true);
        assert.equal(res.golive.state, row.state);
        assert.match(res.reason, /^[A-Z].*\.$/);
        assert.deepEqual(await snapshot(db), before, 'a refused switch writes nothing');
      }
    }
    // Roll back.
    {
      const { db, now } = await inState(name);
      const row = await rawRow(db, 'site-a');
      assert.equal(goliveAllows(row, 'rollback', now), canRollBack);
      const before = await snapshot(db);
      const res = await goliveBegin(db, 'site-a', { kind: 'rollback', who: WHO, acks: [], token: 'new-token', now });
      if (canRollBack) {
        assert.equal(res.ok, true);
        assert.equal(res.golive.state, 'rolling-back');
        assert.equal(res.golive.stale, false);
        assert.equal((await rawRow(db, 'site-a')).run_token, 'new-token');
        assert.equal((await logOf(db, 'site-a')).at(-1).action, 'rollback-started');
      } else {
        assert.equal(res.busy, true);
        assert.equal(res.golive?.state, row?.state);
        assert.match(res.reason, /^[A-Z].*\.$/);
        assert.deepEqual(await snapshot(db), before, 'a refused rollback writes nothing');
      }
    }
    // Check now.
    {
      const { db, now } = await inState(name);
      const row = await rawRow(db, 'site-a');
      assert.equal(goliveAllows(row, 'verify', now), canVerify);
      const before = await snapshot(db);
      const res = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: false, now });
      if (canVerify) {
        assert.equal(res.site.id, 'site-a');
        assert.equal(res.golive.state, row.state === 'live' ? 'live' : 'checking');
        assert.deepEqual(res.golive.checks, CHECKS);
      } else {
        assert.deepEqual(res, row ? { notSwitched: true, golive: (await goliveDetail(db, 'site-a', now)).golive } : { missing: true });
        assert.deepEqual(await snapshot(db), before, 'a refused check writes nothing');
      }
    }
    // Delete, and the hostname lock on another site.
    {
      const { db, now } = await inState(name);
      assert.equal(await goliveBlocksDelete(db, 'site-a'), blocksDelete);
      assert.equal((await goliveHostsInUse(db, 'site-b', ['acme.com', 'www.acme.com'])).length > 0, holdsHosts);
      const res = await begin(db, 'site-b', 'switch', { now, token: 'b-token' });
      assert.equal(res.ok === true, !holdsHosts);
      assert.equal(res.busy === true, holdsHosts);
    }
  });
}

test('an unknown state blocks the delete and holds its hosts: the desk fails closed', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  await exec(db, "UPDATE golive SET state = 'mystery' WHERE site_id = 'site-a'");
  assert.equal(await goliveBlocksDelete(db, 'site-a'), true);
  assert.equal((await goliveHostsInUse(db, 'site-b', ['acme.com'])).length, 1);
  const row = await rawRow(db, 'site-a');
  assert.equal(goliveAllows(row, 'switch', T0), false);
  assert.throws(() => goliveAllows(row, 'dance', T0), /Unknown go-live action/);
  assert.match((await begin(db, 'site-a', 'switch')).reason, /state the desk does not know: mystery\./);
});

test('a failed switch whose restored was never written counts as not put back', async () => {
  const db = await desk();
  await failed(db, 'site-a', null);
  const row = await rawRow(db, 'site-a');
  assert.equal(row.restored, null);
  assert.equal(goliveAllows(row, 'switch', T0), false);
  assert.equal(goliveAllows(row, 'rollback', T0), true);
  assert.equal(await goliveBlocksDelete(db, 'site-a'), true);
});

test('refusals say why in a plain sentence', async () => {
  const reason = async (name, kind) => {
    const { db, now } = await inState(name);
    return (await goliveBegin(db, 'site-a', { kind, who: WHO, record: record(), token: 't', now })).reason;
  };
  assert.equal(await reason('no row', 'rollback'), 'This site has not gone live from the desk, so there is nothing to undo.');
  assert.equal(await reason('switching', 'switch'), 'A switch on this site is running now. Wait for it to finish.');
  assert.equal(await reason('switching', 'rollback'), 'A switch on this site is running now. Wait for it to finish.');
  assert.equal(await reason('switching, stale', 'switch'), 'A switch on this site stopped part-way. Roll it back before going live again.');
  assert.equal(await reason('rolling-back', 'rollback'), 'A rollback on this site is running now. Wait for it to finish.');
  assert.equal(await reason('rolling-back, stale', 'switch'), 'A rollback on this site stopped part-way. Roll back again to finish it.');
  assert.equal(await reason('live', 'switch'), 'This site is already switched to staging-acme. Roll it back first.');
  assert.equal(await reason('checking', 'switch'), 'This site is already switched to staging-acme. Roll it back first.');
  assert.equal(await reason('switch-failed, put back', 'rollback'), 'The failed switch was already put back, so there is nothing to undo.');
  assert.equal(await reason('switch-failed, not all put back', 'switch'), 'The last switch failed and was not all put back. Roll it back first.');
  assert.equal(await reason('rolled-back', 'rollback'), 'This site was already rolled back, so there is nothing to undo.');
  assert.equal(await reason('rollback-failed', 'switch'), 'The last rollback did not finish. Roll back again first.');
});

// ---- Stale ----

test('a lock goes stale after exactly two minutes without a step', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  assert.equal(STALE_AFTER, 2 * MIN);
  const row = () => rawRow(db, 'site-a');
  assert.equal(goliveStale(await row(), at(2 * MIN)), false, 'two minutes is not yet stale');
  assert.equal(goliveStale(await row(), at(2 * MIN + 1)), true);

  // Every step is a heartbeat.
  await goliveStep(db, 'site-a', 'switch-token', { log: { action: 'record-deleted', text: 'Deleted A acme.com.' }, now: at(90 * SEC) });
  assert.equal((await row()).updated_at, at(90 * SEC));
  assert.equal(goliveStale(await row(), at(3 * MIN)), false);
  assert.equal(goliveStale(await row(), at(90 * SEC + 2 * MIN + 1)), true);
  assert.equal(goliveSummary(await row(), at(3 * MIN)).stale, false);
  assert.equal(goliveSummary(await row(), at(4 * MIN)).stale, true);
  assert.equal((await goliveDetail(db, 'site-a', at(4 * MIN))).golive.stale, true);
});

test('only a switch or a rollback can go stale', async () => {
  for (const name of ['checking', 'live', 'switch-failed, not all put back', 'rolled-back', 'rollback-failed']) {
    const { db } = await inState(name);
    assert.equal(goliveStale(await rawRow(db, 'site-a'), at(365 * 24 * 60 * MIN)), false, name);
  }
  assert.equal(goliveStale(null, T0), false);
});

test('times may be ISO strings or milliseconds; with none the clock is used', async () => {
  const db = await desk();
  assert.equal((await goliveSaveCheck(db, 'site-a', { plan_hash: 'h', include_pair: false, ready: true, who: WHO, now: Date.parse(T0) })).checked_at, T0);
  const before = Date.now();
  const { checked_at } = await goliveSaveCheck(db, 'site-a', { plan_hash: 'h', include_pair: false, ready: true, who: WHO });
  assert.ok(Date.parse(checked_at) >= before && Date.parse(checked_at) <= Date.now());
  await assert.rejects(goliveSaveCheck(db, 'site-a', { plan_hash: 'h', who: WHO, now: 'not a time' }), RangeError);
});

// ---- Starting a switch ----

test('a switch writes the whole record before anything else happens', async () => {
  const db = await desk();
  const res = await begin(db, 'site-a', 'switch');
  assert.equal(res.ok, true);
  const g = res.golive;
  assert.deepEqual(g, (await goliveDetail(db, 'site-a', T0)).golive);
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
  assert.equal((await rawRow(db, 'site-a')).run_token, 'switch-token');

  const log = await logOf(db, 'site-a');
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], {
    seq: log[0].seq, at: T0, who: WHO, action: 'switch-started',
    text: 'ana@example.com started switching acme.com and www.acme.com to staging-acme. Saved first, so Roll back can put them back: 2 DNS records.',
    detail: { worker: 'staging-acme', hosts: HOSTS, saved_records: RECORDS, saved_domains: [], redirect: record().redirect, acks: ACKS },
  });
});

test('the switch-started sentence counts what was saved, including Custom Domains taken from another Worker', async () => {
  const text = async (rec) => {
    const db = await desk();
    await begin(db, 'site-a', 'switch', { rec });
    return (await logOf(db, 'site-a'))[0].text;
  };
  const moved = { id: 'cd-old', hostname: 'www.acme.com', service: 'acme' };
  assert.equal(
    await text(record({ saved_records: [RECORDS[0]], saved_domains: [moved] })),
    'ana@example.com started switching acme.com and www.acme.com to staging-acme. Saved first, so Roll back can put them back: 1 DNS record and 1 Custom Domain on another Worker.'
  );
  assert.equal(
    await text(record({ hosts: [HOSTS[0]], saved_records: [], saved_domains: [], redirect: null })),
    'ana@example.com started switching acme.com to staging-acme. There was no DNS record or Custom Domain on them to save first.'
  );
});

test('a record shaped like the plan is taken as well', async () => {
  const db = await desk();
  const plan = {
    site_id: 'site-a', zone: { id: 'zone-acme', name: 'acme.com', plan: 'free' }, worker: 'staging-acme',
    staging_host: 'staging-acme.10xid.com', main: 'acme.com', hosts: HOSTS, delete_records: RECORDS,
    saved_domains: [], redirect: null, mx_txt: [], ssl_mode: 'strict',
  };
  const { golive } = await begin(db, 'site-a', 'switch', { rec: plan });
  assert.equal(golive.zone_id, 'zone-acme');
  assert.equal(golive.zone_name, 'acme.com');
  assert.equal(golive.main_host, 'acme.com');
  assert.deepEqual(golive.saved_records, RECORDS);
  assert.equal(golive.redirect, null);
  assert.equal(golive.ssl_mode, 'strict', 'for the gate 13 record');
  assert.ok(!('ssl_mode' in goliveSummary(await rawRow(db, 'site-a'), T0)), 'the list does not carry it');
});

test('a switch or rollback for a site that is not there is missing, and writes nothing', async () => {
  const db = await desk();
  const before = await snapshot(db);
  assert.deepEqual(await begin(db, 'nope', 'switch'), { missing: true });
  assert.deepEqual(await begin(db, 'nope', 'rollback'), { missing: true });
  assert.deepEqual(await goliveSaveVerify(db, 'nope', { checks: [], done: true, now: T0 }), { missing: true });
  assert.deepEqual(await snapshot(db), before);
});

test('a begin without a token, a kind or a whole record is refused before anything is written', async () => {
  const db = await desk();
  const before = await snapshot(db);
  await assert.rejects(goliveBegin(db, 'site-a', { kind: 'switch', who: WHO, record: record(), now: T0 }), /needs a token/);
  await assert.rejects(goliveBegin(db, 'site-a', { kind: 'switch', who: WHO, record: record(), token: '', now: T0 }), /needs a token/);
  await assert.rejects(goliveBegin(db, 'site-a', { kind: 'verify', who: WHO, record: record(), token: 't', now: T0 }), /switch or a rollback/);
  await assert.rejects(begin(db, 'site-a', 'switch', { rec: record({ worker: '' }) }), /needs worker/);
  await assert.rejects(begin(db, 'site-a', 'switch', { rec: record({ hosts: [] }) }), /needs its hosts/);
  await assert.rejects(begin(db, 'site-a', 'switch', { rec: null }), /needs zone_id/);
  assert.deepEqual(await snapshot(db), before);
});

test('the database undoes a whole store call when its transaction throws', async () => {
  const db = await desk();
  const before = await snapshot(db);
  await assert.rejects(transaction(db.connect, async (tx) => {
    const res = await store.goliveBegin(tx, 'site-a', { kind: 'switch', who: WHO, record: record(), acks: ACKS, token: 'switch-token', now: T0 });
    assert.equal(res.ok, true);
    throw new Error('the connection was cut off');
  }, { write: true }), /cut off/);
  assert.deepEqual(await snapshot(db), before);
});

// ---- Steps and tokens ----

test('a step adds to the lists, sets fields, logs, and refreshes the heartbeat', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  assert.deepEqual(await goliveStep(db, 'site-a', 'switch-token', {
    log: [{ action: 'record-deleted', text: 'Deleted A acme.com → 192.0.2.10.', detail: RECORDS[0] }],
    add: { steps_done: ['deleted:rec-apex'] },
    who: WHO,
    now: at(5 * SEC),
  }), { ok: true });
  await attach(db, 'site-a', 'switch-token', at(10 * SEC));
  // The record Cloudflare made for each host: the whole list is replaced.
  await goliveStep(db, 'site-a', 'switch-token', {
    fields: { attached: ATTACHED.map((a, i) => ({ ...a, dns_id: 'dns-' + i })) },
    log: { action: 'dns-ids', text: 'Noted the DNS record Cloudflare made for each host.' },
    now: at(12 * SEC),
  });
  const rule = { ruleset_id: 'rs-1', rule_id: 'r-1', ref: 'desk-site-a' };
  await goliveStep(db, 'site-a', 'switch-token', {
    fields: { redirect_rule: rule }, add: { steps_done: ['redirect'] },
    log: { action: 'redirect-added', text: 'Added a 301 from www.acme.com to acme.com.' },
    now: at(15 * SEC),
  });

  const { golive, log } = await goliveDetail(db, 'site-a', at(15 * SEC));
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

test('a step that would overwrite the rollback data, the state or the lock is refused whole', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  const before = await snapshot(db);
  const step = (opts) => goliveStep(db, 'site-a', 'switch-token', { now: at(SEC), ...opts });
  for (const k of ['saved_records', 'saved_domains', 'hosts', 'state', 'run_token', 'mx_txt', 'previous_platform', 'verified_at', 'checks']) {
    await assert.rejects(step({ fields: { [k]: [] } }), /cannot set/, k);
  }
  await assert.rejects(step({ add: { saved_records: [{}] } }), /cannot add to saved_records/);
  await assert.rejects(step({ add: { attached: { id: 'x' } } }), /cannot add to attached/);
  await assert.rejects(step({ add: { steps_done: ['x'] }, log: [{ action: 'x' }] }), /needs an action and a text/);
  await assert.rejects(step({ log: [{ text: 'No action.' }] }), /needs an action and a text/);
  assert.deepEqual(await snapshot(db), before);
});

test('a run whose token no longer holds the row writes nothing at all', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch', { token: 'first' });
  await attach(db, 'site-a', 'first', T0, [ATTACHED[0]]);
  const before = await snapshot(db);
  const stepFrom = (token, now = at(SEC)) => goliveStep(db, 'site-a', token, {
    add: { steps_done: ['attached:www.acme.com'] }, fields: { error: 'x' },
    log: { action: 'domain-attached', text: 'Attached www.acme.com.' }, now,
  });
  for (const token of ['second', '', null, undefined, 42]) {
    assert.deepEqual(await stepFrom(token), { stale: true }, String(token));
    assert.deepEqual(await goliveFinish(db, 'site-a', token, { state: 'checking', platform: { to: 'astro' }, now: at(SEC) }), { stale: true });
  }
  assert.deepEqual(await snapshot(db), before);

  // A rollback takes the stale lock over. The first run, waking late, can
  // neither step nor finish, and the platform it would set stays as it was.
  assert.equal((await begin(db, 'site-a', 'rollback', { token: 'rescue', now: at(3 * MIN) })).ok, true);
  const taken = await snapshot(db);
  assert.deepEqual(await stepFrom('first', at(3 * MIN + SEC)), { stale: true });
  assert.deepEqual(await goliveFinish(db, 'site-a', 'first', {
    state: 'checking', fields: { switched_at: at(3 * MIN) }, log: { action: 'switched', text: 'Switched.' },
    platform: { to: 'astro' }, now: at(3 * MIN + SEC),
  }), { stale: true });
  assert.deepEqual(await snapshot(db), taken);
  assert.equal((await rawRow(db, 'site-a')).state, 'rolling-back');
  assert.equal((await siteRow(db, 'site-a')).live_platform, 'wordpress');

  // The rescue run holds it, and once it finishes nobody does.
  assert.deepEqual(await goliveStep(db, 'site-a', 'rescue', { log: { action: 'domain-detached', text: 'Detached acme.com.' }, now: at(3 * MIN + SEC) }), { ok: true });
  assert.ok((await goliveFinish(db, 'site-a', 'rescue', { state: 'rolled-back', now: at(3 * MIN + 2 * SEC) })).golive);
  assert.equal((await rawRow(db, 'site-a')).run_token, null);
  const done = await snapshot(db);
  assert.deepEqual(await goliveFinish(db, 'site-a', 'rescue', { state: 'rollback-failed', now: at(4 * MIN) }), { stale: true }, 'a run finishes once');
  assert.deepEqual(await goliveFinish(db, 'site-a', 'first', { state: 'checking', now: at(4 * MIN) }), { stale: true });
  assert.deepEqual(await goliveStep(db, 'site-a', 'rescue', { log: { action: 'x', text: 'Late.' }, now: at(4 * MIN) }), { stale: true });
  assert.deepEqual(await goliveStep(db, 'site-a', null, { now: at(4 * MIN) }), { stale: true }, 'a cleared token matches no run');
  assert.deepEqual(await snapshot(db), done);
});

// The database wrote the finish, but its answer was lost on the way back,
// and the route tries once more. That must not read as another run taking over.
test('a finish tried again by the same run answers what it saved, and writes nothing more', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch', { token: 'run-1' });
  await attach(db, 'site-a', 'run-1', T0);
  const end = {
    state: 'checking', fields: { switched_at: at(SEC) }, log: { action: 'switched', text: 'Switched.' },
    platform: { to: 'astro' }, who: WHO, now: at(SEC),
  };
  const first = await goliveFinish(db, 'site-a', 'run-1', end);
  assert.equal(first.golive.state, 'checking');
  const saved = await snapshot(db);
  const retry = await goliveFinish(db, 'site-a', 'run-1', { ...end, now: at(2 * SEC) });
  assert.deepEqual(retry, first);
  assert.deepEqual(await snapshot(db), saved, 'no second log entry, no new heartbeat');
  assert.ok(!('finished_token' in retry.golive), 'the token stays in the store');

  // Only the same run, finishing the same way, and only until the row moves on.
  assert.deepEqual(await goliveFinish(db, 'site-a', 'run-2', end), { stale: true });
  assert.deepEqual(await goliveFinish(db, 'site-a', 'run-1', { ...end, state: 'switch-failed' }), { stale: true });
  await begin(db, 'site-a', 'rollback', { token: 'rb', now: at(MIN) });
  assert.equal((await rawRow(db, 'site-a')).finished_token, null);
  assert.deepEqual(await goliveFinish(db, 'site-a', 'run-1', end), { stale: true });
});

test('a step for a site with no go-live row is stale, not an error', async () => {
  const db = await desk();
  assert.deepEqual(await goliveStep(db, 'site-a', 'any', { now: T0 }), { stale: true });
  assert.deepEqual(await goliveFinish(db, 'site-a', 'any', { state: 'checking', now: T0 }), { stale: true });
});

// ---- Finishing ----

test('a finished switch lets go of the row, sets Astro and answers the site with its summary', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  await attach(db, 'site-a', 'switch-token', at(SEC));
  const res = await goliveFinish(db, 'site-a', 'switch-token', {
    state: 'checking', fields: { switched_at: at(2 * SEC), error: 'The redirect rule was not added: limit reached.' },
    log: { action: 'switched', text: 'Switched acme.com and www.acme.com to staging-acme.' },
    platform: { to: 'astro' }, who: WHO, now: at(2 * SEC),
  });
  assert.equal(res.golive.state, 'checking');
  assert.equal(res.golive.switched_at, at(2 * SEC));
  assert.equal(res.golive.error, 'The redirect rule was not added: limit reached.');
  assert.equal((await rawRow(db, 'site-a')).run_token, null);
  assert.equal(res.site.id, 'site-a');
  assert.equal(res.site.live_platform, 'astro');
  assert.equal(res.site.updated_at, at(2 * SEC));
  assert.equal(res.site.astro_staging, true, 'the site comes back as the page gets it');
  assert.deepEqual(res.site.golive, goliveSummary(await rawRow(db, 'site-a'), at(2 * SEC)));
  assert.equal(res.site.golive.all_attached, true);
  const last = (await logOf(db, 'site-a')).at(-1);
  assert.equal(last.action, 'switched');
  assert.equal(last.who, WHO);
});

test('a run finishes only as checking, switch-failed, rolled-back or rollback-failed', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  const before = await snapshot(db);
  for (const state of ['live', 'switching', 'rolling-back', undefined]) {
    await assert.rejects(goliveFinish(db, 'site-a', 'switch-token', { state, now: T0 }), /cannot finish as/, String(state));
  }
  await assert.rejects(goliveFinish(db, 'site-a', 'switch-token', { state: 'checking', fields: { state: 'live' }, now: T0 }), /cannot set state/);
  await assert.rejects(goliveFinish(db, 'site-a', 'switch-token', { state: 'checking', platform: { to: 'wix' }, now: T0 }), /Not a platform/);
  assert.deepEqual(await snapshot(db), before);
});

test('a failed switch keeps its outcome: restored, error and notes', async () => {
  const db = await desk();
  const res = await failed(db, 'site-a', 0);
  assert.equal(res.golive.state, 'switch-failed');
  assert.equal(res.golive.restored, 0);
  assert.deepEqual(res.golive.notes, ['A note.']);
  assert.equal(res.site.live_platform, 'wordpress', 'a failed switch never touched the platform');
  assert.equal(res.site.updated_at, CREATED);
  assert.equal((await failed(await desk(), 'site-a', true)).golive.restored, 1, 'true is stored as 1');
});

test('a rollback puts the old platform back only over the Astro the switch set', async () => {
  // The usual case: WordPress, then Astro, then WordPress again.
  {
    const db = await desk();
    await switched(db, 'site-a');
    assert.equal((await siteRow(db, 'site-a')).live_platform, 'astro');
    assert.equal((await siteRow(db, 'site-a')).updated_at, T0);
    const res = await rolledBack(db, 'site-a', { now: at(MIN) });
    assert.equal(res.site.live_platform, 'wordpress');
    assert.equal(res.site.updated_at, at(MIN));
    assert.equal(res.golive.rolled_back_by, WHO);
    assert.equal(res.golive.rolled_back_at, at(MIN));
  }
  // Someone set it by hand since the switch: the rollback leaves their answer.
  {
    const db = await desk();
    await switched(db, 'site-a');
    await exec(db, "UPDATE sites SET live_platform = 'other', updated_at = ? WHERE id = 'site-a'", at(30 * SEC));
    const res = await rolledBack(db, 'site-a', { now: at(MIN) });
    assert.equal(res.site.live_platform, 'other');
    assert.equal(res.site.updated_at, at(30 * SEC));
  }
  // It was already Astro (a move from one Worker to another): nothing changes,
  // not even updated_at, so an editor open on the site sees no conflict.
  {
    const db = await desk();
    await exec(db, "UPDATE sites SET live_platform = 'astro' WHERE id = 'site-a'");
    await switched(db, 'site-a');
    assert.equal((await rawRow(db, 'site-a')).previous_platform, 'astro');
    assert.equal((await siteRow(db, 'site-a')).updated_at, CREATED);
    await rolledBack(db, 'site-a');
    assert.deepEqual([(await siteRow(db, 'site-a')).live_platform, (await siteRow(db, 'site-a')).updated_at], ['astro', CREATED]);
  }
  // Not set before the switch: not set again after.
  {
    const db = await desk();
    await exec(db, "UPDATE sites SET live_platform = NULL WHERE id = 'site-a'");
    await switched(db, 'site-a');
    assert.equal((await rawRow(db, 'site-a')).previous_platform, null);
    assert.equal((await rolledBack(db, 'site-a')).site.live_platform, null);
  }
  // A failed rollback leaves Astro in place, since the site is still on it.
  {
    const db = await desk();
    await switched(db, 'site-a');
    assert.equal((await rolledBack(db, 'site-a', { state: 'rollback-failed' })).site.live_platform, 'astro');
  }
});

// ---- Check now ----

test('a check that passes makes a checking row live, once', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  const waiting = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: false, who: WHO, now: at(10 * SEC) });
  assert.equal(waiting.golive.state, 'checking');
  assert.deepEqual(waiting.golive.checks, CHECKS);
  assert.equal(waiting.golive.verified_at, null);
  assert.equal((await logOf(db, 'site-a')).at(-1).action, 'switched', 'a check still waiting is not logged');

  const passed = CHECKS.map((c) => ({ ...c, status: 'pass' }));
  const res = await goliveSaveVerify(db, 'site-a', { checks: passed, done: true, who: WHO, now: at(MIN) });
  assert.equal(res.golive.state, 'live');
  assert.equal(res.golive.verified_at, at(MIN));
  assert.deepEqual(res.golive.checks, passed);
  assert.equal(res.site.golive.state, 'live');
  const last = (await logOf(db, 'site-a')).at(-1);
  assert.deepEqual(last, {
    seq: last.seq, at: at(MIN), who: WHO, action: 'verified',
    text: 'Verified: acme.com serves the new site from staging-acme, and no check failed.',
    detail: { checks: passed },
  });

  // A later re-check that fails keeps the row live and shows what failed.
  const failing = [{ id: 'still-attached', label: 'Still attached', status: 'fail', detail: 'www.acme.com is no longer attached.' }];
  const again = await goliveSaveVerify(db, 'site-a', { checks: failing, done: false, now: at(10 * MIN) });
  assert.equal(again.golive.state, 'live');
  assert.equal(again.golive.verified_at, at(MIN));
  assert.deepEqual(again.golive.checks, failing);
  await goliveSaveVerify(db, 'site-a', { checks: passed, done: true, now: at(11 * MIN) });
  assert.equal((await goliveDetail(db, 'site-a', at(11 * MIN))).golive.verified_at, at(MIN));
  assert.equal((await logOf(db, 'site-a')).filter((e) => e.action === 'verified').length, 1);
});

test('a stale switch that attached every host moves on to checking', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch', { token: 'lost' });
  await attach(db, 'site-a', 'lost', at(10 * SEC));
  const now = at(10 * SEC + 2 * MIN + 1);
  const res = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: false, who: WHO, now });
  assert.equal(res.golive.state, 'checking');
  assert.equal(res.golive.stale, false);
  assert.equal(res.golive.switched_at, at(10 * SEC), 'its last step is when it switched');
  assert.equal((await rawRow(db, 'site-a')).run_token, null);
  assert.equal(res.site.live_platform, 'astro', 'as a finished switch would have set it');
  assert.deepEqual(res.site.golive, goliveSummary(await rawRow(db, 'site-a'), now));
  const last = (await logOf(db, 'site-a')).at(-1);
  assert.equal(last.action, 'resumed');
  assert.equal(last.who, WHO);
  assert.equal(last.text, 'The switch stopped part-way after every host was attached to staging-acme, so the desk moved on to checking it.');
  assert.deepEqual(last.detail, { last_step_at: at(10 * SEC) });

  // The lost run, if it ever wakes, writes nothing.
  assert.deepEqual(await goliveStep(db, 'site-a', 'lost', { log: { action: 'x', text: 'Late.' }, now }), { stale: true });

  // Rolling it back later restores WordPress over the Astro it set.
  assert.equal((await rolledBack(db, 'site-a', { now: at(5 * MIN) })).site.live_platform, 'wordpress');
});

test('a stale switch that passes every check goes straight on to live', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  await attach(db, 'site-a', 'switch-token', T0);
  const res = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, now: at(3 * MIN) });
  assert.equal(res.golive.state, 'live');
  assert.equal(res.golive.switched_at, T0);
  assert.equal(res.golive.verified_at, at(3 * MIN));
  assert.deepEqual((await logOf(db, 'site-a')).slice(-2).map((e) => e.action), ['resumed', 'verified']);
});

// Check now reads the row, then spends tens of seconds on the network. If
// the go-live was rolled back and switched again meanwhile, what it found
// was about the old run, and must never mark the new one live.
test('a verification saved for an earlier run is refused, and writes nothing', async () => {
  const db = await desk();
  await switched(db, 'site-a', { token: 'run-1' });
  const seen = (await goliveDetail(db, 'site-a', at(10 * SEC))).golive;
  await rolledBack(db, 'site-a', { now: at(30 * SEC) });
  await switched(db, 'site-a', { token: 'run-2', now: at(50 * SEC) });
  const before = await snapshot(db);
  const res = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, for_started_at: seen.started_at, who: WHO, now: at(55 * SEC) });
  assert.equal(res.notSwitched, true);
  assert.equal(res.golive.state, 'checking');
  assert.equal(res.golive.started_at, at(50 * SEC));
  assert.deepEqual(await snapshot(db), before);

  const now = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, for_started_at: at(50 * SEC), now: at(56 * SEC) });
  assert.equal(now.golive.state, 'live', 'a check of this run still counts');
});

test('a redirect rule the switch could not confirm, found since, is noted and its error cleared', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  await attach(db, 'site-a', 'switch-token', T0);
  await goliveFinish(db, 'site-a', 'switch-token', {
    state: 'checking', fields: { switched_at: T0, error: 'Could not reach Cloudflare: timeout.' }, now: T0,
  });
  const rule = { ruleset_id: 'rs-1', rule_id: 'r-1', ref: 'desk-site-a' };
  const res = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: false, redirect_rule: rule, for_started_at: T0, who: WHO, now: at(MIN) });
  assert.deepEqual(res.golive.redirect_rule, rule);
  assert.equal(res.golive.error, null);
  assert.equal(res.site.golive.has_error, false);
  const last = (await logOf(db, 'site-a')).at(-1);
  assert.equal(last.action, 'redirect-found');
  assert.equal(last.text, 'Found the redirect rule from www.acme.com to acme.com that the switch could not confirm, and noted it.');
  assert.deepEqual(last.detail, { redirect_rule: rule });

  // Once noted it stays; a rule for another ref is not this row's.
  const other = { ruleset_id: 'rs-1', rule_id: 'r-9', ref: 'desk-site-b' };
  await goliveSaveVerify(db, 'site-a', { checks: CHECKS, redirect_rule: { ...rule, rule_id: 'r-2' }, now: at(2 * MIN) });
  assert.deepEqual((await rawRow(db, 'site-a')).redirect_rule, JSON.stringify(rule));
  const b = await desk();
  await switched(b, 'site-a');
  await goliveSaveVerify(b, 'site-a', { checks: CHECKS, redirect_rule: other, now: at(MIN) });
  assert.equal((await rawRow(b, 'site-a')).redirect_rule, null);
  assert.equal((await logOf(b, 'site-a')).at(-1).action, 'switched');
});

test('a stale switch missing a host cannot be checked: only a Roll back helps it', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  await attach(db, 'site-a', 'switch-token', T0, [ATTACHED[0]]);
  const before = await snapshot(db);
  const res = await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, now: at(3 * MIN) });
  assert.equal(res.notSwitched, true);
  assert.equal(res.golive.state, 'switching');
  assert.equal(res.golive.stale, true);
  assert.deepEqual(await snapshot(db), before);
});

// ---- The hostname lock ----

test('the hostname lock finds another site\'s go-live on the same host, whatever its case', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  const expected = [{ site_id: 'site-a', name: 'Acme', state: 'checking', hosts: ['www.acme.com'] }];
  assert.deepEqual(await goliveHostsInUse(db, 'site-b', ['WWW.Acme.com', 'other.com']), expected);
  assert.deepEqual(await goliveHostsInUse(db, 'site-b', [{ hostname: 'www.acme.com', role: 'main' }]), expected);
  assert.deepEqual((await goliveHostsInUse(db, 'site-b', ['acme.com', 'www.acme.com']))[0].hosts, ['acme.com', 'www.acme.com']);
  assert.deepEqual(await goliveHostsInUse(db, 'site-b', ['shop.acme.com']), []);
  assert.deepEqual(await goliveHostsInUse(db, 'site-a', ['acme.com']), [], 'a site never locks itself out');
  assert.deepEqual(await goliveHostsInUse(db, 'site-b', []), []);
});

test('a switch is refused on a host another site holds, and writes nothing', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  const before = await snapshot(db);
  const res = await begin(db, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'www.acme.com', role: 'main' }] }) });
  assert.deepEqual(res, { busy: true, golive: null, reason: 'www.acme.com has an unfinished or live go-live on Acme.' });
  assert.deepEqual(await snapshot(db), before);

  // Once site-a is rolled back, its hosts are free.
  await goliveFinish(db, 'site-a', 'switch-token', { state: 'switch-failed', fields: { restored: 1 }, now: at(SEC) });
  assert.equal((await begin(db, 'site-b', 'switch', { token: 'b', now: at(MIN) })).ok, true);
  assert.equal((await begin(db, 'site-a', 'switch', { token: 'a2', now: at(MIN) })).busy, true, 'and now site-b holds them');
});

test('a deleted site\'s live go-live does not hold its hosts for ever', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, now: at(MIN) });
  assert.equal(await goliveBlocksDelete(db, 'site-a'), false);
  await exec(db, "DELETE FROM sites WHERE id = 'site-a'");
  assert.deepEqual(await goliveHostsInUse(db, 'site-b', ['acme.com']), []);
  assert.equal((await begin(db, 'site-b', 'switch', { token: 'b', now: at(2 * MIN) })).ok, true);
  assert.equal((await goliveDetail(db, 'site-a', at(2 * MIN))).golive.state, 'live', 'the row and log stay');
  assert.equal((await logOf(db, 'site-a')).length > 0, true);
});

// ---- The log ----

test('the log is append-only: a second go-live replaces the row, never the log', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, now: at(10 * SEC) });
  await rolledBack(db, 'site-a', { now: at(MIN) });

  const second = [{ ...RECORDS[0], id: 'rec-apex-2', content: '192.0.2.99' }];
  const res = await begin(db, 'site-a', 'switch', {
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

  const log = await logOf(db, 'site-a');
  assert.deepEqual(log.map((e) => e.action), [
    'switch-started', 'domain-attached', 'domain-attached', 'switched', 'verified',
    'rollback-started', 'rolled-back', 'switch-started',
  ]);
  const starts = log.filter((e) => e.action === 'switch-started');
  assert.deepEqual(starts.map((e) => e.detail.saved_records), [RECORDS, second], 'both runs\' saved records stay on record');
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
});

test('the rollback-started entry names the hosts, the acks, and a lock it took over', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  const oldHost = [...ACKS, { id: 'old-host', label: 'The old host is still ours' }];
  await begin(db, 'site-a', 'rollback', { now: at(3 * MIN), acks: oldHost });
  const last = (await logOf(db, 'site-a')).at(-1);
  assert.equal(last.text, 'ana@example.com started rolling back acme.com and www.acme.com. It takes over a switch that stopped part-way.');
  assert.deepEqual(last.detail, { acks: oldHost, previous_state: 'switching', stale: true });

  const other = await desk();
  await switched(other, 'site-a');
  await begin(other, 'site-a', 'rollback', { now: at(MIN), acks: [] });
  const plain = (await logOf(other, 'site-a')).at(-1);
  assert.equal(plain.text, 'ana@example.com started rolling back acme.com and www.acme.com.');
  assert.deepEqual(plain.detail, { acks: [], previous_state: 'checking', stale: false });
});

test('the detail answers the last hundred log entries, oldest first, for that site only', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  await begin(db, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'b.example', role: 'main' }] }) });
  for (let i = 1; i <= 120; i++) {
    await goliveStep(db, 'site-a', 'switch-token', { log: { action: 'step', text: `Step ${i}.`, detail: { i } }, now: at(i) });
  }
  const { log } = await goliveDetail(db, 'site-a', at(MIN));
  assert.equal(log.length, 100);
  assert.equal(log[0].text, 'Step 21.');
  assert.deepEqual(log[0].detail, { i: 21 });
  assert.equal(log[99].text, 'Step 120.');
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
  assert.deepEqual(Object.keys(log[0]).sort(), ['action', 'at', 'detail', 'seq', 'text', 'who']);
  assert.deepEqual((await goliveDetail(db, 'site-b', at(MIN))).log.map((e) => e.action), ['switch-started']);
  assert.deepEqual(await goliveDetail(db, 'nope', at(MIN)), { golive: null, log: [] });
});

test('every sentence the store writes itself is plain text', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  await goliveSaveVerify(db, 'site-a', { checks: CHECKS, done: true, now: at(MIN) });
  await rolledBack(db, 'site-a', { now: at(2 * MIN) });
  // Read before the second desk empties the database.
  const first = await logOf(db, 'site-a');
  const b = await desk();
  await begin(b, 'site-a', 'switch');
  await attach(b, 'site-a', 'switch-token', T0);
  await goliveSaveVerify(b, 'site-a', { checks: CHECKS, done: false, now: at(3 * MIN) });
  const own = ['switch-started', 'rollback-started', 'verified', 'resumed'];
  const entries = [...first, ...await logOf(b, 'site-a')].filter((e) => own.includes(e.action));
  assert.deepEqual([...new Set(entries.map((e) => e.action))].sort(), [...own].sort());
  for (const e of entries) {
    assert.match(e.text, /^[A-Za-z0-9].*\.$/, e.action);
    assert.doesNotMatch(e.text, /[<>`*_]/, e.action);
  }
});

// ---- Summaries ----

test('a summary carries where the go-live stands and no records', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  await attach(db, 'site-a', 'switch-token', at(SEC), [ATTACHED[0]]);
  const row = await rawRow(db, 'site-a');
  const s = goliveSummary(row, at(2 * SEC));
  assert.deepEqual(s, {
    state: 'switching', stale: false, main_host: 'acme.com', hosts: HOSTS, worker: 'staging-acme',
    started_by: WHO, started_at: T0, switched_at: null, verified_at: null, rolled_back_by: null, rolled_back_at: null,
    updated_at: at(SEC), restored: null, all_attached: false, has_error: false, error_kind: null,
  });
  assert.doesNotMatch(JSON.stringify(s), /192\.0\.2\.10|rec-apex|mx1\.mail|gate12|zone-acme/);

  await attach(db, 'site-a', 'switch-token', at(2 * SEC), [ATTACHED[1]]);
  const later = goliveSummary(await rawRow(db, 'site-a'), at(3 * MIN));
  assert.equal(later.all_attached, true);
  assert.equal(later.stale, true);
  assert.equal(goliveSummary({ ...row, hosts: '[]', attached: '[]' }, T0).all_attached, false, 'no hosts is not all attached');
  assert.equal(goliveSummary(null, T0), null);
  assert.equal(goliveSummary(undefined, T0), null);
  assert.deepEqual(goliveSummary((await goliveDetail(db, 'site-a', T0)).golive, at(3 * MIN)), later, 'a parsed row gives the same summary');
});

// The list goes to anyone with the desk key, without an Access login. An
// error can quote a saved record in full, including the origin address a
// proxied record hides, so the list says only that there was one, and what
// kind. The detail, behind Access, keeps the words.
test('the list says whether a go-live has an error and what kind, never the error itself', async () => {
  const error = 'Could not delete A acme.com → 203.0.113.5 (proxied, TTL auto). Cloudflare said: x. '
    + 'Not everything was put back: A acme.com → 203.0.113.5 (proxied, TTL auto) is not back.';
  const ended = (state, fields) => async (db) => {
    await begin(db, 'site-a', 'switch');
    await goliveFinish(db, 'site-a', 'switch-token', { state, fields: { ...fields, error }, now: T0 });
  };
  const kinds = [
    ['switch-failed', ended('switch-failed', { restored: 0 }), 'The switch failed.'],
    ['checking', ended('checking', { switched_at: T0 }), 'The redirect rule was not added.'],
    ['rollback-failed', async (db) => {
      await switched(db, 'site-a');
      await rolledBack(db, 'site-a', { state: 'rollback-failed' });
      await exec(db, 'UPDATE golive SET error = ?', error);
    }, 'The roll back failed.'],
  ];
  for (const [state, make, kind] of kinds) {
    const db = await desk();
    await make(db);
    const listed = (await goliveSummaries(db, at(MIN))).get('site-a');
    assert.equal(listed.state, state);
    assert.equal(listed.has_error, true, state);
    assert.equal(listed.error_kind, kind, state);
    assert.ok(!('error' in listed), state);
    assert.doesNotMatch(JSON.stringify([listed, await siteWithGolive(db, 'site-a', at(MIN))]), /203\.0\.113\.5|Cloudflare said/, state);
    assert.match((await goliveDetail(db, 'site-a', at(MIN))).golive.error, /203\.0\.113\.5/, 'the detail keeps it');
  }
  const db = await desk();
  await switched(db, 'site-a');
  assert.deepEqual([(await goliveSummaries(db, T0)).get('site-a').has_error, (await goliveSummaries(db, T0)).get('site-a').error_kind], [false, null]);
});

// Desk.list() reads every site's summary at once: one row it cannot read
// must not take the list down for every other site.
test('a go-live row the desk cannot read shows as unreadable, and every other site still lists', async () => {
  const db = await desk();
  await addSite(db, 'site-c', 'Calm Co');
  await switched(db, 'site-a');
  await begin(db, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'b.example', role: 'main' }], main_host: 'b.example' }) });
  await begin(db, 'site-c', 'switch', { token: 'c', rec: record({ hosts: [{ hostname: 'c.example', role: 'main' }], main_host: 'c.example' }) });
  const good = (await goliveSummaries(db, T0)).get('site-b');
  await exec(db, `UPDATE golive SET hosts = '[{"hostname":' WHERE site_id = 'site-a'`);
  await exec(db, `UPDATE golive SET attached = '{"id":"cd-0"}' WHERE site_id = 'site-c'`);
  const map = await goliveSummaries(db, T0);
  assert.deepEqual(map.get('site-b'), good);
  for (const id of ['site-a', 'site-c']) {
    const s = map.get(id);
    assert.equal(s.state, 'unreadable', id);
    assert.deepEqual([s.hosts, s.stale, s.all_attached, s.has_error], [[], false, false, true], id);
    assert.equal(s.error_kind, 'The desk cannot read this go-live record.');
    assert.equal((await siteWithGolive(db, id, T0)).golive.state, 'unreadable');
  }
  assert.equal(map.get('site-a').main_host, 'acme.com', 'plain columns still show');

  // The detail says so too, without a throw; so does a log entry's detail.
  await exec(db, `UPDATE golive_log SET detail = '{"oops' WHERE site_id = 'site-c'`);
  const detail = await goliveDetail(db, 'site-c', T0);
  assert.equal(detail.golive.state, 'unreadable');
  assert.equal(detail.golive.attached, null);
  assert.equal(detail.golive.hosts, null);
  assert.equal(detail.log[0].detail, null);
  assert.equal(detail.log[0].action, 'switch-started');
  assert.equal(goliveAllows(detail.golive, 'verify', T0), false);
  assert.equal(goliveAllows(detail.golive, 'rollback', T0), false);

  // Saved records written twice over as JSON are not a list either.
  const other = await desk();
  await switched(other, 'site-a');
  await exec(other, `UPDATE golive SET saved_records = '"[]"'`);
  assert.equal((await goliveDetail(other, 'site-a', T0)).golive.state, 'unreadable');
});

test('a step or finish that sets attached, steps_done or notes to anything but a list is refused whole', async () => {
  const db = await desk();
  await begin(db, 'site-a', 'switch');
  const before = await snapshot(db);
  for (const [k, v] of [
    ['attached', { id: 'cd-0', hostname: 'acme.com', dns_id: 'd' }], ['attached', null], ['steps_done', 'deleted:x'],
    ['notes', 'A note.'], ['notes', { 0: 'A note.' }],
  ]) {
    await assert.rejects(goliveStep(db, 'site-a', 'switch-token', { fields: { [k]: v }, now: at(SEC) }), /must set .* to a list/, k);
    await assert.rejects(goliveFinish(db, 'site-a', 'switch-token', { state: 'switch-failed', fields: { [k]: v }, now: at(SEC) }), /to a list/, k);
  }
  assert.deepEqual(await snapshot(db), before);
  await assert.doesNotReject(goliveSummaries(db, T0));
  assert.deepEqual(await goliveStep(db, 'site-a', 'switch-token', { fields: { attached: [], notes: [] }, now: at(SEC) }), { ok: true });
});

test('a begin whose hosts are not hostnames is refused before anything is written', async () => {
  const db = await desk();
  const before = await snapshot(db);
  for (const hosts of [[null], ['acme.com'], [{ hostname: '' }], [{ role: 'main' }], { hostname: 'acme.com' }]) {
    await assert.rejects(begin(db, 'site-a', 'switch', { rec: record({ hosts }) }), /needs its hosts/, JSON.stringify(hosts));
  }
  assert.deepEqual(await snapshot(db), before);
});

test('the list gets every summary from one query, keyed by site', async () => {
  const db = await desk();
  await addSite(db, 'site-c', 'Calm Co');
  await switched(db, 'site-a');
  await begin(db, 'site-b', 'switch', { token: 'b', rec: record({ hosts: [{ hostname: 'b.example', role: 'main' }], main_host: 'b.example' }) });
  const map = await goliveSummaries(db, at(3 * MIN));
  assert.ok(map instanceof Map);
  assert.deepEqual([...map.keys()].sort(), ['site-a', 'site-b']);
  assert.deepEqual(map.get('site-a'), goliveSummary(await rawRow(db, 'site-a'), at(3 * MIN)));
  assert.equal(map.get('site-a').all_attached, true);
  assert.equal(map.get('site-b').stale, true);
  assert.equal(map.get('site-b').all_attached, false);
  assert.equal(map.get('site-c'), undefined);
  assert.deepEqual(await goliveSummaries(await desk(), T0), new Map());
});

test('a site read for the page carries its summary, or null', async () => {
  const db = await desk();
  await switched(db, 'site-a');
  const a = await siteWithGolive(db, 'site-a', at(MIN));
  assert.equal(a.name, 'Acme');
  assert.equal(a.astro_staging, true);
  assert.equal(a.domain_ours, null);
  assert.deepEqual(a.golive, goliveSummary(await rawRow(db, 'site-a'), at(MIN)));
  assert.equal((await siteWithGolive(db, 'site-b', at(MIN))).golive, null);
  assert.equal(await siteWithGolive(db, 'nope', at(MIN)), null);
});

// ---- The last check ----

test('the last check is kept per site, and a new one replaces it', async () => {
  const db = await desk();
  assert.equal(await goliveLastCheck(db, 'site-a'), null);
  const friday = [...ACKS, { id: 'friday', label: 'It is Friday and this cannot wait' }];
  assert.deepEqual(
    await goliveSaveCheck(db, 'site-a', { plan_hash: 'a'.repeat(64), include_pair: true, ready: false, acks: friday, who: WHO, now: T0 }),
    { site_id: 'site-a', plan_hash: 'a'.repeat(64), checks_hash: '', include_pair: true, ready: false, acks: friday, checked_by: WHO, checked_at: T0 }
  );
  await goliveSaveCheck(db, 'site-a', {
    plan_hash: 'b'.repeat(64), checks_hash: 'c'.repeat(64), include_pair: false, ready: true, acks: ACKS, who: 'ben@example.org', now: at(MIN),
  });
  assert.deepEqual(await goliveLastCheck(db, 'site-a'), {
    site_id: 'site-a', plan_hash: 'b'.repeat(64), checks_hash: 'c'.repeat(64), include_pair: false, ready: true, acks: ACKS,
    checked_by: 'ben@example.org', checked_at: at(MIN),
  });
  assert.equal(await goliveLastCheck(db, 'site-b'), null);
  assert.equal((await rows(db, 'SELECT COUNT(*)::int AS n FROM golive_checks'))[0].n, 1);
});
