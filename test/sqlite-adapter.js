// ctx.storage for tests: node:sqlite behind the small surface a SQLite
// Durable Object offers (sql.exec returning a cursor, and transactionSync),
// so store code runs here exactly as it runs in the object. Where the two
// could differ, this one is the stricter: it refuses what the object refuses
// (BEGIN and the like inside exec, values it cannot bind), so a test cannot
// pass on something that would fail in production.
//
// Node 22 prints an ExperimentalWarning for node:sqlite once per test file.
// That is expected.

import { DatabaseSync } from 'node:sqlite';

// The object runs transactions only through transactionSync().
const TRANSACTION = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

// Splits a query into statements the way SQLite reads them: a ';' inside
// quotes or a comment does not end one. The object runs every statement and
// binds only the last; node:sqlite's prepare() would quietly drop the rest.
function statements(query) {
  const out = [];
  let start = 0;
  let code = false;
  let i = 0;
  const past = (end, from) => {
    const j = query.indexOf(end, from);
    return j === -1 ? query.length : j + end.length;
  };
  while (i < query.length) {
    const c = query[i];
    const pair = query.slice(i, i + 2);
    if (pair === '--') i = past('\n', i + 2);
    else if (pair === '/*') i = past('*/', i + 2);
    else if (c === ';') {
      if (code) out.push(query.slice(start, i));
      start = ++i;
      code = false;
    } else {
      if (!/\s/.test(c)) code = true;
      i = c === "'" || c === '"' || c === '`' ? past(c, i + 1) : c === '[' ? past(']', i + 1) : i + 1;
    }
  }
  if (code) out.push(query.slice(start));
  return out;
}

// A Durable Object binds strings, numbers, null and ArrayBuffers. node:sqlite
// would take more (an object becomes named parameters), which would hide a
// forgotten JSON.stringify.
function bindable(v) {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError('A Durable Object cannot bind ' + (Array.isArray(v) ? 'an array' : typeof v) + ' to SQL.');
}

// The object's cursor over rows already read. Rows are plain objects, as the
// object returns them; node:sqlite's have no prototype, which strict
// deepEqual would count as a difference.
class Cursor {
  #rows;
  #next = 0;

  constructor(rows, columnNames) {
    this.#rows = rows;
    this.columnNames = columnNames;
  }

  next() {
    return this.#next < this.#rows.length ? { done: false, value: this.#rows[this.#next++] } : { done: true, value: undefined };
  }

  [Symbol.iterator]() {
    return this;
  }

  toArray() {
    const rest = this.#rows.slice(this.#next);
    this.#next = this.#rows.length;
    return rest;
  }

  // Throws on no row as well as on several, like the object's.
  one() {
    const rest = this.toArray();
    if (rest.length !== 1) throw new Error(`Expected exactly one result from SQL query, but got ${rest.length ? 'multiple' : 'no'} results.`);
    return rest[0];
  }
}

function exec(db, query, bindings) {
  const list = statements(query);
  if (list.some((s) => TRANSACTION.test(s))) {
    throw new Error('sql.exec() cannot run transaction statements; use transactionSync().');
  }
  const last = list.pop();
  for (const s of list) db.exec(s);
  if (!last) return new Cursor([], []);
  const stmt = db.prepare(last);
  const values = bindings.map(bindable);
  const columnNames = stmt.columns().map((c) => c.name);
  if (!columnNames.length) {
    stmt.run(...values);
    return new Cursor([], []);
  }
  return new Cursor(stmt.all(...values).map((r) => ({ ...r })), columnNames);
}

// → { sql, transactionSync, db }, shaped like ctx.storage. `db` is the raw
// database, for a test that needs to look underneath.
export function sqliteStorage(path = ':memory:') {
  const db = new DatabaseSync(path);
  let depth = 0;

  // Like the object's: the callback runs inside a transaction and its result
  // is returned; if it throws, everything it wrote is undone. It must not be
  // async. A nested call becomes a savepoint, so an inner failure undoes only
  // the inner writes.
  function transactionSync(fn) {
    const savepoint = depth ? 'nested_' + depth : null;
    db.exec(savepoint ? 'SAVEPOINT ' + savepoint : 'BEGIN');
    depth++;
    let result;
    try {
      result = fn();
      if (typeof result?.then === 'function') throw new TypeError('The transactionSync() callback must not be async.');
    } catch (e) {
      depth--;
      db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw e;
    }
    depth--;
    db.exec(savepoint ? 'RELEASE ' + savepoint : 'COMMIT');
    return result;
  }

  return { sql: { exec: (query, ...bindings) => exec(db, query, bindings) }, transactionSync, db };
}
