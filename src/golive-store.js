// Going live, as the Durable Object remembers it. `golive` holds one row per
// site: where its go-live stands, and everything a Roll back needs to put the
// old site back. `golive_log` is the permanent record of every step, and
// `golive_checks` keeps the last full check, which a start relies on.
//
// Plain synchronous functions over a `sql` shaped like the object's
// ctx.storage.sql, kept apart from worker.js so they run under plain Node.
// None of them awaits, and the object wraps each one that writes in
// transactionSync(), so nothing can land between a check and the write that
// depends on it. JSON columns are parsed on the way out.

import { PLATFORMS, toJson } from './sites.js';

// A run refreshes updated_at at every step and gives up after 90 seconds, and
// no two of its steps are 40 seconds apart. A lock two minutes quiet has no
// run behind it any more.
export const STALE_AFTER = 2 * 60 * 1000;

const LOG_LIMIT = 100;

// Made when the object starts, like `sites`, so there is no migration step.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS golive (
  site_id           TEXT PRIMARY KEY,
  state             TEXT NOT NULL,
  run_token         TEXT,            -- the run that holds the row; writes from any other run are ignored
  finished_token    TEXT,            -- the run that finished the row, so a finish tried again gets its answer
  zone_id           TEXT NOT NULL,
  zone_name         TEXT NOT NULL,
  worker            TEXT NOT NULL,   -- the staging Worker the hosts are attached to
  staging_host      TEXT NOT NULL,
  main_host         TEXT NOT NULL,
  hosts             TEXT NOT NULL,   -- JSON [{hostname, role}], main first
  saved_records     TEXT NOT NULL,   -- JSON: full DNS records to delete (the rollback), written before any delete
  saved_domains     TEXT NOT NULL,   -- JSON [{id, hostname, service}]: Custom Domains on other Workers, written before any detach
  redirect          TEXT,            -- JSON {from, to, ref} or null
  redirect_rule     TEXT,            -- JSON {ruleset_id, rule_id, ref} once created
  attached          TEXT NOT NULL,   -- JSON [{id, hostname, dns_id}] as each attach happens
  steps_done        TEXT NOT NULL,   -- JSON ['deleted:<record id>', 'detached:<domain id>', 'attached:<host>', 'redirect']
  mx_txt            TEXT NOT NULL,   -- JSON snapshot [{type, name, content, priority}] from the plan
  ssl_mode          TEXT,            -- the zone's SSL/TLS mode in the plan, for the gate 13 record
  previous_platform TEXT,
  restored          INTEGER,         -- after a failed switch: 1 = everything was put back, 0 = not all of it
  checks            TEXT,            -- JSON: the last verification checks
  notes             TEXT,            -- JSON [string]: outcomes worth showing
  error             TEXT,
  acks              TEXT,            -- JSON: the acknowledgements given at start
  started_by        TEXT, started_at TEXT,
  switched_at       TEXT, verified_at TEXT,
  rolled_back_by    TEXT, rolled_back_at TEXT,
  updated_at        TEXT NOT NULL    -- refreshed by every step: the heartbeat
)`,
  `CREATE TABLE IF NOT EXISTS golive_log (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  at      TEXT NOT NULL,
  who     TEXT,
  action  TEXT NOT NULL,   -- machine name, e.g. 'switch-started', 'record-deleted'
  text    TEXT NOT NULL,   -- one plain sentence the page shows
  detail  TEXT             -- JSON
)`,
  'CREATE INDEX IF NOT EXISTS golive_log_site ON golive_log (site_id, seq)',
  `CREATE TABLE IF NOT EXISTS golive_checks (
  site_id      TEXT PRIMARY KEY,
  plan_hash    TEXT NOT NULL,
  checks_hash  TEXT NOT NULL DEFAULT '',  -- the Cloudflare checks the person read (checksDigest)
  include_pair INTEGER NOT NULL,
  ready        INTEGER NOT NULL,
  acks         TEXT NOT NULL,     -- JSON [{id, label}] the check requires
  checked_by   TEXT NOT NULL,
  checked_at   TEXT NOT NULL
)`,
];

const JSON_COLUMNS = ['hosts', 'saved_records', 'saved_domains', 'redirect', 'redirect_rule', 'attached',
  'steps_done', 'mx_txt', 'checks', 'notes', 'acks'];

// What a run may set as it goes. The saved records and domains are written
// once, before anything is deleted, and nothing may overwrite them after.
const RUN_FIELDS = ['redirect_rule', 'attached', 'steps_done', 'restored', 'notes', 'error',
  'switched_at', 'rolled_back_by', 'rolled_back_at'];

// The lists a step may add to.
const LISTS = ['attached', 'steps_done', 'notes'];

// How a run can end. Not 'live': only a verification makes a row live.
const FINISHED = ['checking', 'switch-failed', 'rolled-back', 'rollback-failed'];

// What each site carries in the list. No records: the list goes to every
// page load, and the records are only needed by a Roll back.
const SUMMARY_FIELDS = ['state', 'main_host', 'worker', 'started_by', 'started_at', 'switched_at',
  'verified_at', 'rolled_back_by', 'rolled_back_at', 'updated_at', 'restored'];
const SUMMARY_COLUMNS = ['site_id', 'hosts', 'attached', 'error', ...SUMMARY_FIELDS].join(', ');

// Nor the words of an error: they can quote a saved record in full (a
// proxied record's origin address, say), and the list needs only the desk
// key. It says there is one, and what kind; the detail, behind Access, has
// the words. A switch that finished leaves an error only when its redirect
// rule was not added.
const ERROR_KINDS = {
  checking: 'The redirect rule was not added.',
  live: 'The redirect rule was not added.',
  'switch-failed': 'The switch failed.',
  'rollback-failed': 'The roll back failed.',
};
const errorKind = (row) => (row.error ? ERROR_KINDS[row.state] || 'The last run failed.' : null);

const UNREADABLE = 'The desk cannot read this go-live record.';

// ISO time. The tests pass their own; the object passes nothing.
const stamp = (now) => (now == null ? new Date() : new Date(now)).toISOString();

// A JSON column as stored, or already parsed.
const value = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// A parsed list column that must hold objects, or a throw.
function objects(list) {
  if (!Array.isArray(list) || !list.every((x) => x && typeof x === 'object')) throw new TypeError('Not a list of objects.');
  return list;
}

// Every host a hostname: the hostname lock reads them for every other site.
function hostList(list) {
  if (!objects(list).every((h) => typeof h.hostname === 'string' && h.hostname)) throw new TypeError('A host without a hostname.');
  return list;
}

// JSON columns are stored as text, and true/false as 1/0: a Durable Object
// binds only strings, numbers and null.
function stored(column, v) {
  if (JSON_COLUMNS.includes(column)) return v == null ? null : JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? null;
}

const readRow = (sql, siteId) => sql.exec('SELECT * FROM golive WHERE site_id = ?', siteId).toArray()[0] || null;
const readSite = (sql, siteId) => sql.exec('SELECT * FROM sites WHERE id = ?', siteId).toArray()[0] || null;

const hostnames = (hosts) => (value(hosts) || []).map((h) => h.hostname);

// "a", "a and b", "a, b and c".
function listed(names) {
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0] || '';
}

const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);

export function ensureGoliveSchema(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
}

// A switch or rollback whose run has stopped: its lock is two minutes quiet.
export function goliveStale(row, now) {
  if (row?.state !== 'switching' && row?.state !== 'rolling-back') return false;
  return Date.parse(stamp(now)) - Date.parse(row.updated_at) > STALE_AFTER;
}

// Every planned host made it onto the staging Worker, so the site is served
// from there whatever happened after.
function allAttached(row) {
  const attached = new Set((value(row.attached) || []).map((a) => a.hostname));
  const hosts = hostnames(row.hosts);
  return hosts.length > 0 && hosts.every((h) => attached.has(h));
}

// Nothing of this go-live is left on its hosts: undone, or failed and put back.
const letGo = (row) => row.state === 'rolled-back' || (row.state === 'switch-failed' && row.restored === 1);

// The state table, in one place. 'switch' is Go live, 'rollback' is Roll
// back, 'verify' is Check now. A failed switch with `restored` anything but 1
// counts as not put back, so it can always be rolled back.
export function goliveAllows(row, action, now) {
  const state = row?.state;
  const stale = goliveStale(row, now);
  if (action === 'switch') return !row || letGo(row);
  if (action === 'rollback') {
    return ['checking', 'live', 'rollback-failed'].includes(state)
      || (state === 'switch-failed' && row.restored !== 1) || stale;
  }
  if (action === 'verify') {
    return state === 'checking' || state === 'live' || (state === 'switching' && stale && allAttached(row));
  }
  throw new Error('Unknown go-live action: ' + action);
}

// Why a switch or rollback cannot start now, as the page shows it.
function refusal(row, now) {
  if (!row) return 'This site has not gone live from the desk, so there is nothing to undo.';
  const stale = goliveStale(row, now);
  switch (row.state) {
    case 'switching': return stale
      ? 'A switch on this site stopped part-way. Roll it back before going live again.'
      : 'A switch on this site is running now. Wait for it to finish.';
    case 'rolling-back': return stale
      ? 'A rollback on this site stopped part-way. Roll back again to finish it.'
      : 'A rollback on this site is running now. Wait for it to finish.';
    case 'checking':
    case 'live': return 'This site is already switched to ' + row.worker + '. Roll it back first.';
    case 'switch-failed': return row.restored === 1
      ? 'The failed switch was already put back, so there is nothing to undo.'
      : 'The last switch failed and was not all put back. Roll it back first.';
    case 'rolled-back': return 'This site was already rolled back, so there is nothing to undo.';
    case 'rollback-failed': return 'The last rollback did not finish. Roll back again first.';
    default: return 'This site\'s go-live is in a state the desk does not know: ' + row.state + '.';
  }
}

// The row as the page gets it: JSON parsed and stale worked out. The run
// tokens stay in here; nothing outside the store has a use for them. A row
// the desk cannot read (bad JSON, or a list that is not one) comes out as
// 'unreadable', which no action is allowed on, rather than as a throw.
function present(row, now) {
  if (!row) return null;
  const out = { ...row, stale: goliveStale(row, now) };
  delete out.run_token;
  delete out.finished_token;
  try {
    for (const c of JSON_COLUMNS) out[c] = value(out[c]);
    hostList(out.hosts);
    for (const c of ['saved_records', 'saved_domains', 'attached', 'mx_txt']) objects(out[c]);
    if (!Array.isArray(out.steps_done) || !(out.notes == null || Array.isArray(out.notes))) throw new TypeError('Not a list.');
  } catch {
    for (const c of JSON_COLUMNS) out[c] = null;
    return { ...out, state: 'unreadable', stale: false };
  }
  return out;
}

// One row the desk cannot read shows as such, and the list carries on.
export function goliveSummary(row, now) {
  if (!row) return null;
  const plain = Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, row[k] ?? null]));
  try {
    const hosts = hostList(value(row.hosts));
    objects(value(row.attached));
    return {
      ...plain, hosts, stale: goliveStale(row, now), all_attached: allAttached(row),
      has_error: !!row.error, error_kind: errorKind(row),
    };
  } catch {
    return { ...plain, state: 'unreadable', hosts: [], stale: false, all_attached: false, has_error: true, error_kind: UNREADABLE };
  }
}

// For Desk.list(): every site's summary from one query, by site id.
export function goliveSummaries(sql, now) {
  const at = stamp(now);
  const rows = sql.exec(`SELECT ${SUMMARY_COLUMNS} FROM golive`).toArray();
  return new Map(rows.map((r) => [r.site_id, goliveSummary(r, at)]));
}

// For Desk.read(), and every answer here that returns a site: the site as
// the page gets it, carrying its go-live summary. null when there is no site.
export function siteWithGolive(sql, siteId, now) {
  const site = readSite(sql, siteId);
  if (!site) return null;
  const row = sql.exec(`SELECT ${SUMMARY_COLUMNS} FROM golive WHERE site_id = ?`, siteId).toArray()[0];
  return { ...toJson(site), golive: goliveSummary(row, now) };
}

const outcome = (sql, siteId, at) => ({ site: siteWithGolive(sql, siteId, at), golive: present(readRow(sql, siteId), at) });

// A log entry's detail, or null when it does not parse: one bad entry must
// not hide the rest of the story.
function logDetail(v) {
  try {
    return value(v) ?? null;
  } catch {
    return null;
  }
}

// The row and the last hundred log entries, oldest first. The log outlives
// the row's changes, so it is read whether or not a row is there.
export function goliveDetail(sql, siteId, now) {
  const at = stamp(now);
  const log = sql.exec(
    `SELECT seq, at, who, action, text, detail FROM
       (SELECT * FROM golive_log WHERE site_id = ? ORDER BY seq DESC LIMIT ?)
     ORDER BY seq`,
    siteId, LOG_LIMIT
  ).toArray().map((e) => ({ ...e, detail: logDetail(e.detail) }));
  return { golive: present(readRow(sql, siteId), at), log };
}

// The last full check, which a start must match. One per site; a new check
// replaces it. `checks_hash` is checksDigest() of the Cloudflare checks the
// person read, so a start sees a new warning even when the plan is the same.
export function goliveSaveCheck(sql, siteId, { plan_hash, checks_hash = '', include_pair, ready, acks = [], who, now } = {}) {
  sql.exec(
    `INSERT OR REPLACE INTO golive_checks (site_id, plan_hash, checks_hash, include_pair, ready, acks, checked_by, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    siteId, plan_hash, checks_hash, include_pair ? 1 : 0, ready ? 1 : 0, JSON.stringify(acks), who, stamp(now)
  );
  return goliveLastCheck(sql, siteId);
}

export function goliveLastCheck(sql, siteId) {
  const row = sql.exec('SELECT * FROM golive_checks WHERE site_id = ?', siteId).toArray()[0];
  if (!row) return null;
  return { ...row, include_pair: row.include_pair === 1, ready: row.ready === 1, acks: JSON.parse(row.acks) };
}

// The hostname lock: other sites whose go-live still holds one of `hosts`
// (hostnames, or {hostname} objects), in any state but undone or failed and
// put back. A deleted site's row is left out: the desk lets a site go only
// when its go-live is live or finished, and nobody could roll it back from
// here, so it must not hold its hosts for ever.
export function goliveHostsInUse(sql, siteId, hosts) {
  const wanted = new Set(hosts.map((h) => (typeof h === 'string' ? h : h.hostname).toLowerCase()));
  const rows = sql.exec(
    `SELECT g.site_id, s.name, g.state, g.restored, g.hosts
     FROM golive g JOIN sites s ON s.id = g.site_id WHERE g.site_id != ?`,
    siteId
  ).toArray();
  return rows.filter((r) => !letGo(r)).flatMap((r) => {
    const found = hostnames(r.hosts).map((h) => h.toLowerCase()).filter((h) => wanted.has(h));
    return found.length ? [{ site_id: r.site_id, name: r.name, state: r.state, hosts: found }] : [];
  });
}

// Desk.remove asks this first. A site may go only once its go-live is live,
// undone, or failed and put back. Any other state, known or not, still has
// something a person must finish.
export function goliveBlocksDelete(sql, siteId) {
  const row = sql.exec('SELECT state, restored FROM golive WHERE site_id = ?', siteId).toArray()[0];
  return !!row && row.state !== 'live' && !letGo(row);
}

// The row's fields from `record`, which is shaped like the row itself
// (main_host, saved_records) or like the plan it was built from (main,
// delete_records, zone: { id, name }).
function recordFields(r) {
  const f = {
    zone_id: r?.zone_id ?? r?.zone?.id,
    zone_name: r?.zone_name ?? r?.zone?.name,
    worker: r?.worker,
    staging_host: r?.staging_host,
    main_host: r?.main_host ?? r?.main,
    hosts: r?.hosts,
    saved_records: r?.saved_records ?? r?.delete_records ?? [],
    saved_domains: r?.saved_domains ?? [],
    redirect: r?.redirect ?? null,
    mx_txt: r?.mx_txt ?? [],
    ssl_mode: typeof r?.ssl_mode === 'string' ? r.ssl_mode : null,
  };
  for (const k of ['zone_id', 'zone_name', 'worker', 'staging_host', 'main_host']) {
    if (typeof f[k] !== 'string' || !f[k]) throw new Error('A go-live record needs ' + k + '.');
  }
  if (!Array.isArray(f.hosts) || !f.hosts.length || !f.hosts.every((h) => typeof h?.hostname === 'string' && h.hostname)) {
    throw new Error('A go-live record needs its hosts.');
  }
  return f;
}

// A list is only ever replaced by a list: anything else would break the
// row for every later read.
function runFields(fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (!RUN_FIELDS.includes(k)) throw new Error('A go-live run cannot set ' + k + '.');
    if (LISTS.includes(k) && !Array.isArray(v)) throw new Error('A go-live run must set ' + k + ' to a list.');
  }
  return { ...fields };
}

// Checked before anything is written, so a bad entry leaves no half-step.
function logEntries(log, who) {
  return [].concat(log ?? []).map((e) => {
    if (typeof e?.action !== 'string' || !e.action || typeof e.text !== 'string' || !e.text) {
      throw new Error('A go-live log entry needs an action and a text.');
    }
    return { who: e.who ?? who ?? null, action: e.action, text: e.text, detail: e.detail ?? null };
  });
}

function appendLog(sql, siteId, at, entries) {
  for (const e of entries) {
    sql.exec(
      'INSERT INTO golive_log (site_id, at, who, action, text, detail) VALUES (?, ?, ?, ?, ?, ?)',
      siteId, at, e.who, e.action, e.text, e.detail === null ? null : JSON.stringify(e.detail)
    );
  }
}

// Every write refreshes updated_at: it is the heartbeat that says a run is
// still going.
function writeRow(sql, siteId, values, at) {
  const keys = Object.keys(values);
  sql.exec(
    `UPDATE golive SET ${keys.map((k) => k + ' = ?, ').join('')}updated_at = ? WHERE site_id = ?`,
    ...keys.map((k) => stored(k, values[k])), at, siteId
  );
}

// The row, if the run holding `token` still holds it. A run whose token was
// replaced (a rollback took over its stale lock) or cleared (it finished, or
// a check moved it on) must write nothing.
function heldRow(sql, siteId, token) {
  const row = readRow(sql, siteId);
  return row && typeof token === 'string' && token && row.run_token === token ? row : null;
}

// "Live site runs on". With onlyIf, the field changes only while it still
// holds that value: a rollback puts WordPress back over the Astro the switch
// set, never over something a person chose since. Nothing is written when it
// already holds the new value, so an editor open on the site does not see a
// change that is not one.
function setPlatform(sql, siteId, { to = null, onlyIf } = {}, at) {
  if (to !== null && !PLATFORMS.includes(to)) throw new Error('Not a platform: ' + to + '.');
  const guard = onlyIf === undefined ? [] : [onlyIf];
  sql.exec(
    `UPDATE sites SET live_platform = ?, updated_at = ?
     WHERE id = ? AND live_platform IS NOT ?${guard.length ? ' AND live_platform IS ?' : ''}`,
    to, at, siteId, to, ...guard
  );
}

function switchStartedText(who, f) {
  const saved = [
    f.saved_records.length && count(f.saved_records.length, 'DNS record', 'DNS records'),
    f.saved_domains.length && count(f.saved_domains.length, 'Custom Domain on another Worker', 'Custom Domains on other Workers'),
  ].filter(Boolean);
  return `${who || 'Someone'} started switching ${listed(hostnames(f.hosts))} to ${f.worker}. `
    + (saved.length
      ? `Saved first, so Roll back can put them back: ${saved.join(' and ')}.`
      : 'There was no DNS record or Custom Domain on them to save first.');
}

function rollbackStartedText(who, row, stale) {
  const took = stale ? ` It takes over a ${row.state === 'switching' ? 'switch' : 'rollback'} that stopped part-way.` : '';
  return `${who || 'Someone'} started rolling back ${listed(hostnames(row.hosts))}.${took}`;
}

// → { missing: true } · { busy: true, golive, reason } · { ok: true, golive }.
// `token` is the run's own: every later step and the finish must carry it.
export function goliveBegin(sql, siteId, { kind, who = null, record, acks = null, token, now } = {}) {
  if (kind !== 'switch' && kind !== 'rollback') throw new Error('A go-live run is a switch or a rollback, not ' + kind + '.');
  if (typeof token !== 'string' || !token) throw new Error('A go-live run needs a token.');
  const at = stamp(now);
  const site = readSite(sql, siteId);
  if (!site) return { missing: true };
  const row = readRow(sql, siteId);
  if (!goliveAllows(row, kind, at)) return { busy: true, golive: present(row, at), reason: refusal(row, at) };
  return kind === 'switch'
    ? beginSwitch(sql, site, row, { who, record, acks, token, at })
    : beginRollback(sql, row, { who, acks, token, at });
}

function beginSwitch(sql, site, row, { who, record, acks, token, at }) {
  const f = recordFields(record);
  const inUse = goliveHostsInUse(sql, site.id, f.hosts);
  if (inUse.length) {
    const other = inUse[0];
    return { busy: true, golive: present(row, at), reason: `${other.hosts[0]} has an unfinished or live go-live on ${other.name}.` };
  }
  const entries = logEntries({
    action: 'switch-started',
    text: switchStartedText(who, f),
    detail: { worker: f.worker, hosts: f.hosts, saved_records: f.saved_records, saved_domains: f.saved_domains, redirect: f.redirect, acks },
  }, who);
  const values = {
    ...f, state: 'switching', run_token: token, attached: [], steps_done: [],
    previous_platform: site.live_platform, acks, started_by: who, started_at: at,
  };
  const columns = ['site_id', ...Object.keys(values), 'updated_at'];
  // REPLACE rather than UPDATE: every column not named here (the last run's
  // redirect rule, checks, notes, error and times) starts again empty. The
  // log is a separate table, so the last run's saved records stay on record.
  sql.exec(
    `INSERT OR REPLACE INTO golive (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    site.id, ...Object.entries(values).map(([k, v]) => stored(k, v)), at
  );
  appendLog(sql, site.id, at, entries);
  return { ok: true, golive: present(readRow(sql, site.id), at) };
}

function beginRollback(sql, row, { who, acks, token, at }) {
  const stale = goliveStale(row, at);
  const entries = logEntries({
    action: 'rollback-started',
    text: rollbackStartedText(who, row, stale),
    detail: { acks, previous_state: row.state, stale },
  }, who);
  writeRow(sql, row.site_id, { state: 'rolling-back', run_token: token, finished_token: null }, at);
  appendLog(sql, row.site_id, at, entries);
  return { ok: true, golive: present(readRow(sql, row.site_id), at) };
}

// One step of a run: log entries, items added to the JSON lists, fields set.
// → { ok: true }, or { stale: true } with nothing written when another run
// holds the row.
export function goliveStep(sql, siteId, token, { log = [], add = {}, fields = {}, who = null, now } = {}) {
  const at = stamp(now);
  const row = heldRow(sql, siteId, token);
  if (!row) return { stale: true };
  const values = runFields(fields);
  const entries = logEntries(log, who);
  for (const [key, items] of Object.entries(add)) {
    if (!LISTS.includes(key) || !Array.isArray(items)) throw new Error('A go-live step cannot add to ' + key + '.');
    const base = key in values ? values[key] : value(row[key]);
    values[key] = [...(base || []), ...items];
  }
  writeRow(sql, siteId, values, at);
  appendLog(sql, siteId, at, entries);
  return { ok: true };
}

// The end of a run: its last fields, log and state, and the run lets go of
// the row. `platform` ({ to, onlyIf? }) changes the site's "Live site runs
// on" in the same transaction. → { site, golive } or { stale: true }.
//
// Safe to repeat. When the object wrote the finish but its answer was lost
// on the way back, the route tries once more: the same run finishing the
// same way gets what was saved, and nothing is written twice.
export function goliveFinish(sql, siteId, token, { state, fields = {}, log = [], platform = null, who = null, now } = {}) {
  if (!FINISHED.includes(state)) throw new Error('A go-live run cannot finish as ' + state + '.');
  const at = stamp(now);
  if (!heldRow(sql, siteId, token)) {
    const row = readRow(sql, siteId);
    const again = typeof token === 'string' && token !== '' && row?.finished_token === token && row.state === state;
    return again ? outcome(sql, siteId, at) : { stale: true };
  }
  const values = { ...runFields(fields), state, run_token: null, finished_token: token };
  const entries = logEntries(log, who);
  if (platform) setPlatform(sql, siteId, platform, at);
  writeRow(sql, siteId, values, at);
  appendLog(sql, siteId, at, entries);
  return outcome(sql, siteId, at);
}

// Saves a verification. On `checking`, done makes the row live. On `live`
// only the checks are kept: a failed re-check does not demote the row, the
// page shows what failed. A stale switch that had already attached every
// host has done the part that matters, so it moves on to checking, as a
// finished switch would have.
//
// `for_started_at` is the started_at the caller read before it went out to
// check. If the row was rolled back and switched again meanwhile, what it
// found was about the earlier run, and must never make this one live.
// `redirect_rule` is the desk's rule, found by its ref, when the switch
// could not confirm it (its answer was lost).
// → { site, golive } · { missing: true } · { notSwitched: true, golive }.
export function goliveSaveVerify(sql, siteId, { checks = null, done = false, for_started_at, redirect_rule = null, who = null, now } = {}) {
  const at = stamp(now);
  const row = readRow(sql, siteId);
  if (!row || !readSite(sql, siteId)) return { missing: true };
  if (!goliveAllows(row, 'verify', at) || (for_started_at !== undefined && row.started_at !== for_started_at)) {
    return { notSwitched: true, golive: present(row, at) };
  }

  const values = { checks };
  const log = [];
  const redirect = value(row.redirect);
  if (redirect && !row.redirect_rule && redirect_rule?.ref === redirect.ref) {
    // The only error a switched row carries is that this rule was not added.
    Object.assign(values, { redirect_rule, error: null });
    log.push({
      action: 'redirect-found',
      text: `Found the redirect rule from ${redirect.from} to ${redirect.to} that the switch could not confirm, and noted it.`,
      detail: { redirect_rule },
    });
  }
  let state = row.state;
  if (state === 'switching') {
    state = 'checking';
    // Its last step is as close as the desk can say to when it switched.
    Object.assign(values, { state, run_token: null, switched_at: row.switched_at || row.updated_at });
    log.push({
      action: 'resumed',
      text: `The switch stopped part-way after every host was attached to ${row.worker}, so the desk moved on to checking it.`,
      detail: { last_step_at: row.updated_at },
    });
    setPlatform(sql, siteId, { to: 'astro' }, at);
  }
  if (done && state === 'checking') {
    Object.assign(values, { state: 'live', verified_at: at });
    log.push({
      action: 'verified',
      text: `Verified: ${row.main_host} serves the new site from ${row.worker}, and no check failed.`,
      detail: { checks },
    });
  }
  writeRow(sql, siteId, values, at);
  appendLog(sql, siteId, at, logEntries(log, who));
  return outcome(sql, siteId, at);
}
