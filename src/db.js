// The desk's database: Postgres on Neon (project website-desk). Every call
// the desk makes runs in one transaction, on the one connection its request
// holds (pgSession, below).
//
// The list used to live in one Durable Object, which ran every read and write
// one at a time. The store's code relies on that: a go-live step reads the
// row, decides, and writes, and nothing may land in between. So every write
// here takes the same transaction-level advisory lock first, and writes still
// run one at a time. Reads take no lock; each runs in one read-only snapshot,
// so a list and the go-live summaries beside it always agree.
//
// Kept apart from worker.js so the store and its tests run under plain Node,
// where the tests connect to PGlite (Postgres in the test process) instead.

import pg from 'pg';

// Any fixed number: what matters is that every write asks for the same one.
const DESK_LOCK = 7316001;

// The store's SQL is written with '?' placeholders, as it was for the Durable
// Object; Postgres numbers them. No query here has a '?' of its own.
export function numbered(text) {
  let n = 0;
  return text.replace(/\?/g, () => '$' + ++n);
}

async function openClient(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  // A connection that drops while nobody is using it must not throw
  // somewhere nobody is listening; the next call opens a new one.
  client.on('error', () => { client.dead = true; });
  client.on('end', () => { client.dead = true; });
  await client.connect();
  return client;
}

// → connect(): a new connection to `url` for each call, as
// { query(text, params), end() }. For scripts and tests; the Worker uses
// pgSession(), below.
export function pgConnector(url) {
  return async () => {
    const client = await openClient(url);
    return { query: (text, params) => client.query(text, params), end: () => client.end() };
  };
}

// One connection for a whole request, shared by every call it makes, one
// call at a time. Workers Free allows 50 outbound connections per request,
// and a TCP socket to Postgres is one of them; a go-live run makes dozens of
// store calls, and golive.js counts on 46 of the 50 for Cloudflare. So a
// request opens one connection (a second only if the first drops), and
// close() ends it once everything the request started has finished.
// → { connect, close }; connect() is shaped like pgConnector()'s.
export function pgSession(url) {
  let client = null;
  let queue = Promise.resolve();
  const connect = () => new Promise((resolve, reject) => {
    queue = queue.then(() => new Promise((release) => {
      (async () => {
        if (!client || client.dead) client = await openClient(url);
        const held = client;
        return {
          query: (text, params) => held.query(text, params).catch((e) => {
            // A connection that failed part-way is not trusted again.
            if (!e?.code || e.code.startsWith('08') || e.code === '57P01') held.dead = true;
            throw e;
          }),
          end: async () => release(),
        };
      })().then(resolve, (e) => { release(); reject(e); });
    }));
  });
  const close = async () => {
    await queue;
    if (client && !client.dead) await client.end().catch(() => {});
    client = null;
  };
  return { connect, close };
}

// What the store's functions get: rows(), row() and run(), each taking the
// SQL and then its values, as sql.exec() did.
function handle(conn) {
  const rows = async (text, ...params) => (await conn.query(numbered(text), params)).rows;
  return {
    rows,
    row: async (text, ...params) => (await rows(text, ...params))[0] ?? null,
    run: async (text, ...params) => { await conn.query(numbered(text), params); },
  };
}

// Runs fn(tx) in one transaction and returns what it returns. If it throws,
// everything it wrote is undone. With `write`, the desk's lock is taken
// first; without it, the transaction is read-only and a stray write fails.
// `who`, when given, is who the history records for the changes made here.
export async function transaction(connect, fn, { write = false, who = null } = {}) {
  const conn = await connect();
  try {
    await conn.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (write) {
      await conn.query('SELECT pg_advisory_xact_lock($1)', [DESK_LOCK]);
      if (who) await conn.query("SELECT set_config('desk.who', $1, true)", [who]);
    }
    const out = await fn(handle(conn));
    await conn.query('COMMIT');
    return out;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await conn.end().catch(() => {});
  }
}
