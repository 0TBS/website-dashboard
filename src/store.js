// The desk's store: every read and write the Worker makes, each one a
// transaction of its own (db.js). It has the methods the Durable Object had,
// with the same answers, so golive-routes.js needs no change: it still calls
// store.goliveBegin() and the rest.
//
// Fields reaching these methods have already been through cleanSite() or
// cleanItem() in the Worker, so the store only stores and reads. Not found is
// null or { missing: true }, never a throw.

import { transaction } from './db.js';
import { toJson, COLUMNS } from './sites.js';
import { ITEMS, itemJson } from './details.js';
import { OPTIONS } from './client-form.js';
import * as golive from './golive-store.js';

const HISTORY_LIMIT = 200;

// The Durable Object's tables, in the order a copy must insert them.
const IMPORTED = ['sites', 'golive', 'golive_log', 'golive_checks'];

export class Store {
  constructor(connect) {
    this.connect = connect;
  }

  #read(fn) {
    return transaction(this.connect, fn);
  }

  // `who` is the person the history records, when a go-live run knows it.
  #write(fn, who = null) {
    return transaction(this.connect, fn, { write: true, who });
  }

  // Each site carries where its go-live stands (null when it never went
  // live from the desk), so the list can show it without asking again.
  list() {
    return this.#read(async (tx) => {
      const summaries = await golive.goliveSummaries(tx);
      const rows = await tx.rows('SELECT * FROM sites ORDER BY lower(name), name, id');
      return rows.map((row) => ({ ...toJson(row), golive: summaries.get(row.id) ?? null }));
    });
  }

  read(id) {
    return this.#read((tx) => golive.siteWithGolive(tx, id));
  }

  create(fields) {
    return this.#write(async (tx) => {
      const now = new Date().toISOString();
      const id = await nextId(tx, 'sites');
      const values = COLUMNS.map((c) => (c in fields ? fields[c] : null));
      await tx.run(
        `INSERT INTO sites (id, ${COLUMNS.join(', ')}, created_at, updated_at)
         VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
        id, ...values, now, now
      );
      return golive.siteWithGolive(tx, id);
    });
  }

  // Returns { site }, { missing: true }, or { conflict: true, site } when
  // `expected` (the updated_at the editor started from) is no longer current.
  // The check and the update run under the desk's lock, so nothing can land
  // between them.
  update(id, fields, expected) {
    return this.#write(async (tx) => {
      const current = await golive.siteWithGolive(tx, id);
      if (!current) return { missing: true };
      if (expected && current.updated_at !== expected) return { conflict: true, site: current };
      const keys = Object.keys(fields).filter((k) => COLUMNS.includes(k));
      if (!keys.length) return { site: current };
      await tx.run(
        `UPDATE sites SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`,
        ...keys.map((k) => fields[k]), new Date().toISOString(), id
      );
      return { site: await golive.siteWithGolive(tx, id) };
    });
  }

  // Returns true, false (no such site) or { blocked: 'golive-active' }: a site
  // whose go-live still needs a person (running, being checked, or failed and
  // not put back) stays, or nobody could finish it from the desk. Its go-live
  // row and log stay in the database either way; its services, contacts and
  // domains go with it, and the history keeps what they were.
  remove(id) {
    return this.#write(async (tx) => {
      if (!(await tx.row('SELECT id FROM sites WHERE id = ?', id))) return false;
      if (await golive.goliveBlocksDelete(tx, id)) return { blocked: 'golive-active' };
      await tx.run('DELETE FROM sites WHERE id = ?', id);
      return true;
    });
  }

  // Going live: the functions in golive-store.js, called from
  // golive-routes.js, which passes its own clock (`now`) in the options.
  // Each write is one transaction, so a step that fails part-way leaves
  // nothing of itself.
  goliveDetail(siteId, now) {
    return this.#read((tx) => golive.goliveDetail(tx, siteId, now));
  }

  goliveLastCheck(siteId) {
    return this.#read((tx) => golive.goliveLastCheck(tx, siteId));
  }

  goliveHostsInUse(siteId, hosts) {
    return this.#read((tx) => golive.goliveHostsInUse(tx, siteId, hosts));
  }

  goliveSaveCheck(siteId, check) {
    return this.#write((tx) => golive.goliveSaveCheck(tx, siteId, check), check?.who);
  }

  goliveBegin(siteId, run) {
    return this.#write((tx) => golive.goliveBegin(tx, siteId, run), run?.who);
  }

  goliveStep(siteId, token, step) {
    return this.#write((tx) => golive.goliveStep(tx, siteId, token, step), step?.who);
  }

  goliveFinish(siteId, token, end) {
    return this.#write((tx) => golive.goliveFinish(tx, siteId, token, end), end?.who);
  }

  goliveSaveVerify(siteId, result) {
    return this.#write((tx) => golive.goliveSaveVerify(tx, siteId, result), result?.who);
  }

  // A site's services, contacts and domains, and the latest of its history.
  // null when there is no site.
  details(siteId) {
    return this.#read(async (tx) => {
      if (!(await tx.row('SELECT id FROM sites WHERE id = ?', siteId))) return null;
      const out = {};
      for (const [kind, spec] of Object.entries(ITEMS)) {
        const rows = await tx.rows(`SELECT * FROM ${spec.table} WHERE site_id = ? ORDER BY ${spec.order}`, siteId);
        out[kind] = rows.map((r) => itemJson(kind, r));
      }
      const saved = new Set((await tx.rows('SELECT service_id FROM service_passwords WHERE site_id = ?', siteId)).map((r) => r.service_id));
      for (const s of out.services) s.has_password = saved.has(s.id);
      out.client_form = clientFormJson(await tx.row('SELECT * FROM client_forms WHERE site_id = ?', siteId));
      out.history = await tx.rows(
        `SELECT id, at, who, item, item_id, action, field, old_value, new_value
         FROM history WHERE site_id = ? ORDER BY id DESC LIMIT ?`,
        siteId, HISTORY_LIMIT
      );
      return out;
    });
  }

  // → { item } · { missing: true } (no such site) · { duplicate: field }.
  // `password`, for a service, is the ciphertext from secrets.js, saved with
  // it in the same transaction.
  createItem(kind, siteId, fields, { password = null } = {}) {
    const spec = ITEMS[kind];
    return this.#write(async (tx) => {
      if (!(await tx.row('SELECT id FROM sites WHERE id = ?', siteId))) return { missing: true };
      if (spec.unique && await taken(tx, spec, siteId, fields[spec.unique])) return { duplicate: spec.unique };
      const item = await insertItem(tx, kind, siteId, fields);
      if (kind === 'services' && password) await savePassword(tx, siteId, item.id, password);
      return { item: await readItem(tx, kind, siteId, item.id) };
    });
  }

  // → { item } · { missing: true } · { conflict: true, item } · { duplicate: field },
  // with the same stale-edit check as update(). `password`, for a service:
  // undefined leaves it as it is, null removes it, a ciphertext replaces it.
  // A password change counts as a change to the service, so it moves its
  // updated_at like any other.
  updateItem(kind, siteId, itemId, fields, expected, { password } = {}) {
    const spec = ITEMS[kind];
    return this.#write(async (tx) => {
      const current = await readItem(tx, kind, siteId, itemId);
      if (!current) return { missing: true };
      if (expected && current.updated_at !== expected) return { conflict: true, item: current };
      const keys = Object.keys(fields).filter((k) => k in spec.fields);
      const pw = kind === 'services' && password !== undefined && (password !== null || current.has_password);
      if (!keys.length && !pw) return { item: current };
      const u = spec.unique;
      if (u && u in fields && fields[u] !== current[u] && await taken(tx, spec, siteId, fields[u])) return { duplicate: u };
      await tx.run(
        `UPDATE ${spec.table} SET ${keys.map((k) => k + ' = ?, ').join('')}updated_at = ? WHERE id = ? AND site_id = ?`,
        ...keys.map((k) => fields[k]), new Date().toISOString(), itemId, siteId
      );
      if (pw) await (password ? savePassword(tx, siteId, itemId, password) : dropPassword(tx, siteId, itemId));
      return { item: await readItem(tx, kind, siteId, itemId) };
    });
  }

  // A service's password as stored (ciphertext), for the Worker to decrypt
  // when someone asks to see it. → { ciphertext } · { missing: true } (no
  // such service) · { none: true } (no password saved).
  readPassword(siteId, serviceId) {
    return this.#read(async (tx) => {
      if (!(await tx.row('SELECT id FROM site_services WHERE id = ? AND site_id = ?', serviceId, siteId))) return { missing: true };
      const row = await tx.row('SELECT ciphertext FROM service_passwords WHERE service_id = ?', serviceId);
      return row ? { ciphertext: row.ciphertext } : { none: true };
    });
  }

  removeItem(kind, siteId, itemId) {
    return this.#write(async (tx) => {
      if (!(await readItem(tx, kind, siteId, itemId))) return false;
      await tx.run(`DELETE FROM ${ITEMS[kind].table} WHERE id = ? AND site_id = ?`, itemId, siteId);
      return true;
    });
  }

  // The client form (client-form.js has cleaned it): a new site and
  // everything under it, in one transaction. Every form makes a site of its
  // own, even for a client already on the desk: a client can come back for
  // something new. → { site }.
  createClient(form) {
    return this.#write(async (tx) => {
      const now = new Date().toISOString();
      const id = await nextId(tx, 'sites');
      const values = COLUMNS.map((c) => (c in form.site ? form.site[c] : null));
      await tx.run(
        `INSERT INTO sites (id, ${COLUMNS.join(', ')}, created_at, updated_at)
         VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
        id, ...values, now, now
      );
      for (const c of form.contacts) await insertItem(tx, 'contacts', id, c);
      for (const { password, ...s } of form.services) {
        const item = await insertItem(tx, 'services', id, s);
        if (password) await savePassword(tx, id, item.id, password);
      }
      for (const j of form.jobs) await insertItem(tx, 'jobs', id, j);
      const keys = OPTIONS.map(([k]) => k);
      await tx.run(
        `INSERT INTO client_forms (id, site_id, ${keys.join(', ')}, created_at, updated_at)
         VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?)`,
        await nextId(tx, 'client_forms'), id, ...keys.map((k) => form.options[k] ? 1 : 0), now, now
      );
      return { site: await golive.siteWithGolive(tx, id) };
    });
  }

  // The copy from the Durable Object, once. → the counts copied, or null when
  // it was done before. Rows keep their times and log numbers, and make no
  // history: they are not changes. Each site gets the next number, in the
  // order the sites were made, and its go-live record follows it.
  hasImported() {
    return this.#read(async (tx) => !!(await tx.row("SELECT value FROM desk_meta WHERE key = 'imported_from_do'")));
  }

  importRows(dump) {
    return this.#write(async (tx) => {
      if (await tx.row("SELECT value FROM desk_meta WHERE key = 'imported_from_do'")) return null;
      await tx.run("SELECT set_config('desk.importing', 'on', true)");
      const counts = {};
      const renumbered = new Map();
      const sites = [...(dump?.sites ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      for (const site of sites) renumbered.set(site.id, await nextId(tx, 'sites'));
      const numbered = (table, row) => (table === 'sites'
        ? { ...row, id: renumbered.get(row.id) }
        : { ...row, site_id: renumbered.get(row.site_id) ?? row.site_id });
      for (const table of IMPORTED) {
        const known = new Set((await tx.rows(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', table
        )).map((c) => c.column_name));
        const rows = (table === 'sites' ? sites : dump?.[table] ?? []).map((row) => numbered(table, row));
        counts[table] = 0;
        for (const row of rows) {
          const columns = Object.keys(row).filter((c) => known.has(c));
          const landed = await tx.rows(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
             ON CONFLICT DO NOTHING RETURNING 1 AS landed`,
            ...columns.map((c) => row[c])
          );
          counts[table] += landed.length;
        }
        // Every row the object handed over must be here, or none of them is.
        if (counts[table] !== rows.length) {
          throw new Error(`Copied ${counts[table]} of the Durable Object's ${rows.length} ${table} rows; copied nothing.`);
        }
      }
      // The next log entry is numbered after the last one copied.
      await tx.run(`SELECT setval(pg_get_serial_sequence('golive_log', 'seq'), COALESCE(MAX(seq), 0) + 1, false) FROM golive_log`);
      await tx.run(
        "INSERT INTO desk_meta (key, value) VALUES ('imported_from_do', ?)",
        JSON.stringify({ at: new Date().toISOString(), counts })
      );
      return counts;
    });
  }
}

// The next id for a row of `table`: 0001, 0002 … 9999, 10000, from the
// table's own counter (schema.js, step 4). A number is never handed out
// twice, even when a row is removed or its insert is undone.
async function nextId(tx, table) {
  const { n } = await tx.row(`SELECT nextval('${table}_number')::int AS n`);
  return String(n).padStart(4, '0');
}

// One detail row, with the next id of its table. The caller has checked the
// site is there and the row is not a duplicate.
async function insertItem(tx, kind, siteId, fields) {
  const spec = ITEMS[kind];
  const now = new Date().toISOString();
  const id = await nextId(tx, spec.table);
  const columns = Object.keys(spec.fields);
  await tx.run(
    `INSERT INTO ${spec.table} (id, site_id, ${columns.join(', ')}, created_at, updated_at)
     VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)`,
    id, siteId, ...columns.map((c) => fields[c] ?? null), now, now
  );
  return readItem(tx, kind, siteId, id);
}

// The form's ticks as true/false, with when it was sent; null for a site
// that was added on the desk rather than from the form.
function clientFormJson(row) {
  if (!row) return null;
  const out = { id: row.id, created_at: row.created_at, updated_at: row.updated_at };
  for (const [k] of OPTIONS) out[k] = row[k] === 1;
  return out;
}

// A service says whether it has a password (has_password), never what it is.
async function readItem(tx, kind, siteId, id) {
  const row = await tx.row(`SELECT * FROM ${ITEMS[kind].table} WHERE id = ? AND site_id = ?`, id, siteId);
  if (!row) return null;
  const item = itemJson(kind, row);
  if (kind === 'services') item.has_password = !!(await tx.row('SELECT 1 AS y FROM service_passwords WHERE service_id = ?', id));
  return item;
}

// A password's history line, written here because the table has no trigger
// (schema.js, step 6): who, which service, and that it was set, changed or
// removed. Never the password, and never the ciphertext.
const HIDDEN = '(hidden)';
async function passwordHistory(tx, siteId, serviceId, before, after) {
  await tx.run(
    `INSERT INTO history (who, site_id, item, item_id, action, field, old_value, new_value)
     VALUES (NULLIF(current_setting('desk.who', true), ''), ?, 'service', ?, 'changed', 'password', ?, ?)`,
    siteId, serviceId, before ? HIDDEN : null, after ? HIDDEN : null
  );
}

async function savePassword(tx, siteId, serviceId, ciphertext) {
  const had = await tx.row('SELECT 1 AS y FROM service_passwords WHERE service_id = ?', serviceId);
  await tx.run(
    `INSERT INTO service_passwords (service_id, site_id, ciphertext, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (service_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = EXCLUDED.updated_at`,
    serviceId, siteId, ciphertext, new Date().toISOString()
  );
  await passwordHistory(tx, siteId, serviceId, !!had, true);
}

async function dropPassword(tx, siteId, serviceId) {
  const gone = await tx.rows('DELETE FROM service_passwords WHERE service_id = ? RETURNING 1 AS y', serviceId);
  if (gone.length) await passwordHistory(tx, siteId, serviceId, true, false);
}

// A domain, a job's URL, or a social media link, is listed once per site.
const taken = (tx, spec, siteId, value) =>
  tx.row(`SELECT id FROM ${spec.table} WHERE site_id = ? AND ${spec.unique} = ?`, siteId, value);
