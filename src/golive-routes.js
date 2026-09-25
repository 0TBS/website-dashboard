// The go-live endpoints, /api/golive/*. By the time a request gets here,
// worker.js has checked the desk key (and x-desk on a change). This file
// checks the rest, in this order: that going live is set up on this Worker,
// then the person's own Cloudflare Access login, then the endpoint itself.
//
// `store` is the Desk Durable Object, whose go-live methods are the
// functions in golive-store.js. Every call a request makes to the outside
// (the Access keys, the Cloudflare API, the sites, public DNS) goes through
// one counted fetch, so a switch always knows how many calls it has left.
//
// Kept apart from worker.js so it can be tested under plain Node.

import { json, redirect } from './answers.js';
import { verifyAccess, accessConfigMissing } from './access.js';
import { budget, countedFetch } from './budget.js';
import { cloudflare } from './cloudflare.js';
import { goliveAllows } from './golive-store.js';
import { InvalidField } from './sites.js';
import {
  buildPlan, preflight, planHash, checksDigest, requiredAcks, restoreCost, switchOn, restore, verify, isReady, SwitchError,
} from './golive.js';

// A site id as crypto.randomUUID() makes them. Nothing else reaches the
// Durable Object or an address the desk redirects to.
const SITE_ID = /^[0-9a-f-]{36}$/;

// The Cloudflare settings. access.js names the Access ones. Not CF_API_TOKEN
// and CF_ACCOUNT_ID: wrangler reads those from a developer's shell as its own
// deploy credentials, and the two must never be taken for each other.
const CF_CONFIG = ['GOLIVE_API_TOKEN', 'GOLIVE_ACCOUNT_ID'];

// A switch has 90 seconds. The restore after a failed one, like a Roll back,
// has 60 of its own, so a switch that ran out of time can still be undone.
const SWITCH_TIME = 90 * 1000;
const RESTORE_TIME = 60 * 1000;

// A start relies on a check this recent.
const CHECK_KEEPS = 10 * 60 * 1000;

// A week after a switch the old host may have been switched off (gate 20),
// and its records put back would point the site at nothing.
const OLD_SWITCH = 7 * 24 * 60 * 60 * 1000;
const OLD_HOST = { id: 'old-host', label: 'The old host is still ours: its address has not been switched off or given up (gate 20)' };

const PLAN_CHANGED = 'The plan changed since you checked. Read it again.';

const refuse = (status, code, error, extra = {}) => json({ error, code, ...extra }, status);
const notFound = () => json({ error: 'No site with that id.' }, 404);
const noRoute = () => json({ error: 'Not found.' }, 404);
const notAllowed = () => json({ error: 'Method not allowed.' }, 405);

// "a", "a and b", "a, b and c".
function listed(names) {
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0] || '';
}

const hostsOf = (row) => listed(row.hosts.map((h) => h.hostname));

// Names only, never values, in the order the README lists them.
export function goliveConfigMissing(env) {
  const cf = CF_CONFIG.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  return [...cf, ...accessConfigMissing(env)];
}

// → { email }, or { refused: { status, code, error, … } } when going live is
// not set up or the Access login does not let this person in.
async function signedIn(request, env, fetchImpl, now) {
  const missing = goliveConfigMissing(env);
  if (missing.length) {
    return { refused: { status: 503, code: 'golive-not-set-up', error: 'Going live is not set up on this Worker.', missing } };
  }
  const who = await verifyAccess(request, env, { fetchImpl, now: now() });
  if (!who.ok) {
    const { ok, ...refused } = who;
    return { refused };
  }
  return { email: who.email };
}

// GET /api/golive/signin?site=<id>: where Cloudflare Access sends a person
// back after its login page. That is a navigation from Access's own site, so
// the SameSite=Strict desk cookie does not come with it, and worker.js lets
// it through without one. It only checks the Access login, then sends the
// browser back to the page, which carries on with the cookie. The addresses
// are fixed here; the only thing copied in is a site id that looks like one.
export async function handleGoLiveSignin(request, env, { url, fetchImpl = fetch, now = Date.now } = {}) {
  if (request.method !== 'GET') return notAllowed();
  const who = await signedIn(request, env, countedFetch(fetchImpl, budget()), now);
  if (who.refused) return redirect('/#golive-error=' + who.refused.code);
  const site = url.searchParams.get('site') || '';
  return redirect(SITE_ID.test(site) ? '/#golive=' + site : '/');
}

// The endpoints under /api/golive/:id, by the part after the id.
const ENDPOINTS = {
  '': { method: 'GET', run: detail },
  check: { method: 'POST', run: check },
  start: { method: 'POST', run: start },
  verify: { method: 'POST', run: checkNow },
  rollback: { method: 'POST', run: rollBack },
};

// `now` is the request's clock: the deadlines, the times the desk records
// and the age of a check all read it. The Cloudflare client and the switch
// compare their deadlines with Date.now(), which is its default.
export async function handleGoLive(request, env, {
  parts, url, store, waitUntil = () => {}, fetchImpl = fetch, now = Date.now, sleep,
} = {}) {
  const allowance = budget();
  const counted = countedFetch(fetchImpl, allowance);
  const who = await signedIn(request, env, counted, now);
  if (who.refused) {
    const { status, ...body } = who.refused;
    return json(body, status);
  }

  const [id = '', action = '', ...rest] = (parts || url.pathname.replace(/\/+$/, '').split('/')).slice(3);
  if (id === 'me' && !action && !rest.length) return request.method === 'GET' ? json({ email: who.email }) : notAllowed();
  const endpoint = Object.hasOwn(ENDPOINTS, action) ? ENDPOINTS[action] : null;
  if (!id || !endpoint || rest.length) return noRoute();
  if (!SITE_ID.test(id)) return notFound();
  if (request.method !== endpoint.method) return notAllowed();

  const site = await store.read(id);
  if (!site) return notFound();
  const r = {
    request, id, site, store, email: who.email, now, sleep, waitUntil,
    allowance, fetch: counted,
    stamp: () => new Date(now()).toISOString(),
    // Every client shares the request's counted fetch. A run's client
    // also carries its deadline.
    cf: (deadline = null) => cloudflare({
      token: env.GOLIVE_API_TOKEN.trim(), accountId: env.GOLIVE_ACCOUNT_ID.trim(), fetchImpl: counted, deadline,
    }),
  };
  try {
    return await endpoint.run(r);
  } catch (e) {
    if (e instanceof InvalidField) return json({ error: e.message, field: e.field }, 400);
    throw e;
  }
}

// An empty body is {}; anything else must be a JSON object.
async function readBody(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  let body = null;
  try { body = JSON.parse(text); } catch { /* answered below */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidField(null, 'Body is not a JSON object.');
  return body;
}

// "Also move www": on unless the body says false.
function pairChoice(body) {
  const v = body.include_pair;
  if (v === undefined) return true;
  if (typeof v !== 'boolean') throw new InvalidField('include_pair', 'include_pair must be true or false.');
  return v;
}

// What the person typed, as it is compared with the hostname.
const typed = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// The acknowledgements the body ticks, of those required. The page sends
// ids; { id } objects are read too. → { given, missing }, both [{ id, label }].
function ticked(sent, required) {
  const ids = new Set((Array.isArray(sent) ? sent : []).map((a) => (typeof a === 'string' ? a : a?.id)));
  const wanted = [...new Map(required.map((a) => [a.id, a])).values()];
  return { given: wanted.filter((a) => ids.has(a.id)), missing: wanted.filter((a) => !ids.has(a.id)) };
}

const acksMissing = (missing) => refuse(400, 'acks-missing',
  'Tick every acknowledgement first: ' + missing.map((a) => a.label).join('; ') + '.', { acks: missing });

// Every host a plan for `live` could move: the domain and its www pair,
// either way round. buildPlan keeps only the ones it plans.
function candidateHosts(live) {
  if (!live || /[/:]/.test(live)) return [];
  return [live, 'www.' + live, ...(live.startsWith('www.') ? [live.slice(4)] : [])];
}

// Why the last check will not do for a start, or null.
function checkProblem(last, includePair, at) {
  if (!last) return 'Check the site before going live.';
  if (!(at - Date.parse(last.checked_at) <= CHECK_KEEPS)) {
    return 'The last check is more than ten minutes old. Check again before going live.';
  }
  if (!last.ready) return 'The last check found something to fix first. Fix it, then check again.';
  if (last.include_pair !== includePair) return 'The last check was for a different choice of hostnames. Check again.';
  return null;
}

const busy = (begun) => refuse(409, 'busy', begun.reason, { golive: begun.golive, reason: begun.reason });

// goliveStep for this run. Every step carries the run's token, so once
// another run holds the row, nothing this one does is written.
const stepFor = (r) => (entry) => r.store.goliveStep(r.id, r.token, { ...entry, who: r.email, now: r.stamp() });

// The end of a run, tried once more if it fails. A failed finish is never
// followed by a restore: whatever the run did has happened, and undoing a
// working switch because the desk could not write it down would take the
// site down for nothing.
async function finish(r, end) {
  const call = () => r.store.goliveFinish(r.id, r.token, { ...end, who: r.email, now: r.stamp() });
  try {
    return await call();
  } catch {
    return call();
  }
}

// The answer after a run: the site, its go-live and the log, and the error
// when the run failed.
async function outcome(r, ended, status = 200, code = null) {
  const { golive, log } = await r.store.goliveDetail(r.id, r.stamp());
  const body = { site: ended.site, golive, log };
  return code ? refuse(status, code, golive?.error || 'The run did not finish.', body) : json(body, status);
}

// Another run holds the row now: a Roll back took over a lock it found
// stale. This run stops without touching anything more, and says where the
// go-live stands.
async function tookOver(r) {
  const [site, { golive, log }] = await Promise.all([r.store.read(r.id), r.store.goliveDetail(r.id, r.stamp())]);
  const reason = 'Another run took over this go-live, so this one stopped.';
  return refuse(409, 'busy', reason, { site, golive, log, reason });
}

// --- The endpoints ---

async function detail(r) {
  const [{ golive, log }, last] = await Promise.all([r.store.goliveDetail(r.id, r.stamp()), r.store.goliveLastCheck(r.id)]);
  return json({ site: r.site, golive, log, last_check: last });
}

// The full check, saved: a start relies on it. A start fetches no page, so
// it compares the plan's own checks alone (planChecks).
async function check(r) {
  const includePair = pairChoice(await readBody(r.request));
  const busyHosts = await r.store.goliveHostsInUse(r.id, candidateHosts(r.site.live_domain));
  const { checks, planChecks, plan, ready, acks } = await preflight({
    site: r.site, includePair, cf: r.cf(), busyHosts, siteFetch: r.fetch, doh: r.fetch, now: r.now(),
  });
  const [plan_hash, checks_hash] = await Promise.all([planHash(plan), checksDigest(planChecks)]);
  await r.store.goliveSaveCheck(r.id, { plan_hash, checks_hash, include_pair: includePair, ready, acks, who: r.email, now: r.stamp() });
  return json({ checks, plan, plan_hash, ready, acks });
}

// Go live. The plan is built again from Cloudflare (no page is fetched) and
// must be the one the person read, with the same checks saying the same
// things (a new warning is always seen first), then the switch runs in this
// request.
async function start(r) {
  const body = await readBody(r.request);
  const includePair = pairChoice(body);
  const last = await r.store.goliveLastCheck(r.id);
  const problem = checkProblem(last, includePair, r.now());
  if (problem) return refuse(409, 'check-first', problem);

  const { checks, plan } = await buildPlan({ site: r.site, includePair, cf: r.cf() });
  const [plan_hash, checks_hash] = await Promise.all([planHash(plan), checksDigest(checks)]);
  const ready = isReady(checks);
  const acks = requiredAcks({ plan, site: r.site, now: r.now() });
  if (!plan || !ready || plan_hash !== last.plan_hash || plan_hash !== body.plan_hash || checks_hash !== last.checks_hash) {
    return refuse(409, 'plan-changed', PLAN_CHANGED, { checks, plan, plan_hash, ready, acks });
  }
  // The check counted on what a plan usually costs. What this request has
  // left must cover every call up to the last attach and a full put-back:
  // a zone that pages, say, can leave fewer.
  const needed = restoreCost(plan) + plan.delete_records.length + plan.saved_domains.length + plan.hosts.length * 3;
  if (r.allowance.remaining() - 1 < needed) {
    return refuse(409, 'too-many-calls', 'This switch needs more Cloudflare calls than one request allows. Ask a developer.');
  }
  if (typed(body.confirm) !== plan.main) {
    return refuse(400, 'confirm-mismatch', `Type ${plan.main} exactly to point it at ${plan.worker}.`);
  }
  // The check's acknowledgements, and any the clock has added since (it
  // may have turned Friday in Toronto).
  const given = ticked(body.acks, [...last.acks, ...acks]);
  if (given.missing.length) return acksMissing(given.missing);

  const token = crypto.randomUUID();
  const begun = await r.store.goliveBegin(r.id, {
    kind: 'switch', who: r.email, record: plan, acks: given.given, token, now: r.stamp(),
  });
  if (begun.missing) return notFound();
  if (begun.busy) return busy(begun);
  // One promise from here to the answer, handed to waitUntil as well, so the
  // run keeps going if the page goes away.
  const run = switchRun({ ...r, plan, token });
  r.waitUntil(run);
  return run;
}

async function switchRun(r) {
  const { plan } = r;
  const step = stepFor(r);
  const deadline = r.now() + SWITCH_TIME;
  let result;
  try {
    result = await switchOn({ record: plan, cf: r.cf(deadline), sleep: r.sleep, step, budget: r.allowance, deadline });
  } catch (e) {
    if (!(e instanceof SwitchError)) throw e;
    return switchFailed(r, step, e);
  }

  const redirectError = result.redirectError ? result.redirectError.message : null;
  const text = `Switched ${hostsOf(plan)} to ${plan.worker}. Waiting for HTTPS and public DNS.`
    + (redirectError ? ` The redirect from ${plan.redirect.from} was not added, so it shows the site without redirecting.` : '');
  let ended;
  try {
    ended = await finish(r, {
      state: 'checking',
      // The rule again, in case its own step could not be written.
      fields: { switched_at: r.stamp(), error: redirectError, ...(result.redirectRule && { redirect_rule: result.redirectRule }) },
      log: {
        action: 'switched', text,
        detail: { attached: result.attached, redirect_rule: result.redirectRule, redirect_error: redirectError },
      },
      platform: { to: 'astro' },
    });
  } catch (e) {
    return refuse(500, 'not-recorded', `Every host is on ${plan.worker}, but the desk could not record that the switch `
      + `finished (${e.message}). In two minutes, press Check now: it carries on from there.`);
  }
  if (ended.stale) return tookOver(r);
  return outcome(r, ended);
}

// The switch stopped before every host was attached, so everything goes
// back, with a fresh deadline of its own. Unless another run holds the row:
// then that run decides, and this one touches nothing more.
async function switchFailed(r, step, e) {
  if (e.stale) return tookOver(r);
  const put = await restore({
    record: { ...r.plan, attached: e.attached }, cf: r.cf(r.now() + RESTORE_TIME), sleep: r.sleep, step, budget: r.allowance,
  });
  if (put.stale) return tookOver(r);
  const error = put.ok ? e.message : `${e.message} Not everything was put back: ${put.errors.join(' ')}`;
  const ended = await finish(r, {
    state: 'switch-failed',
    fields: { restored: put.ok ? 1 : 0, error, notes: put.notes },
    log: {
      action: 'switch-failed',
      text: put.ok
        ? `The switch failed, and the desk put everything back. ${e.message}`
        : `The switch failed, and the desk could not put everything back. ${error} Roll back to try again.`,
      detail: { error: e.message, restore_errors: put.errors, notes: put.notes },
    },
  });
  if (ended.stale) return tookOver(r);
  return outcome(r, ended, 502, 'switch-failed');
}

// Check now: is the switched site working? Saved, so a check that passes
// makes the row live. It is saved only on the run it checked
// (for_started_at), and with the desk's redirect rule when verify found one
// the row did not know about.
async function checkNow(r) {
  const { golive } = await r.store.goliveDetail(r.id, r.stamp());
  if (!goliveAllows(golive, 'verify', r.now())) return notSwitched(golive);
  const { checks, done, redirectRule = null } = await verify({
    record: golive, cf: r.cf(), siteFetch: r.fetch, doh: r.fetch, now: r.now(),
  });
  const saved = await r.store.goliveSaveVerify(r.id, {
    checks, done, for_started_at: golive.started_at, redirect_rule: redirectRule, who: r.email, now: r.stamp(),
  });
  if (saved.missing) return notFound();
  if (saved.notSwitched) return notSwitched(saved.golive, golive.started_at);
  return json({ site: saved.site, golive: saved.golive, checks, done });
}

function notSwitched(row, checkedStart) {
  const why = checkedStart !== undefined && row && row.started_at !== checkedStart
    ? 'This go-live was rolled back or started again while the desk was checking it, so the check was not saved. Check again.'
    : row?.state === 'switching'
      ? 'The switch is still running, or stopped before every host was attached. Wait for it, or roll it back.'
      : 'This site is not switched to a staging Worker, so there is nothing to check.';
  return refuse(409, 'not-switched', why, { golive: row });
}

// Roll back: put the saved records (and any Custom Domains taken from
// another Worker) back, and take the redirect out.
async function rollBack(r) {
  const body = await readBody(r.request);
  const { golive } = await r.store.goliveDetail(r.id, r.stamp());
  if (!goliveAllows(golive, 'rollback', r.now())) return cannotRollBack(golive);
  if (typed(body.confirm) !== golive.main_host) {
    return refuse(400, 'confirm-mismatch', `Type ${golive.main_host} exactly to roll it back.`);
  }
  // A switch that failed or stopped part-way never switched, and can still
  // be rolled back long after it started.
  const since = golive.switched_at ?? golive.started_at;
  const old = !!since && r.now() - Date.parse(since) > OLD_SWITCH;
  const given = ticked(body.acks, old ? [OLD_HOST] : []);
  if (given.missing.length) return acksMissing(given.missing);

  const token = crypto.randomUUID();
  const begun = await r.store.goliveBegin(r.id, { kind: 'rollback', who: r.email, acks: given.given, token, now: r.stamp() });
  if (begun.missing) return notFound();
  if (begun.busy) return busy(begun);
  const run = rollbackRun({ ...r, row: begun.golive, token });
  r.waitUntil(run);
  return run;
}

function cannotRollBack(row) {
  if (row && (row.state === 'switching' || row.state === 'rolling-back')) {
    const reason = `A ${row.state === 'switching' ? 'switch' : 'rollback'} on this site is running now. Wait for it to finish.`;
    return refuse(409, 'busy', reason, { golive: row, reason });
  }
  if (row?.state === 'unreadable') {
    return refuse(409, 'unreadable', 'The desk cannot read this site\'s go-live record, so it cannot roll it back. '
      + 'Ask a developer: the log still holds every saved record.', { golive: row });
  }
  const why = !row ? 'This site has not gone live from the desk, so there is nothing to undo.'
    : row.state === 'rolled-back' ? 'This site was already rolled back, so there is nothing to undo.'
      : 'Nothing of this go-live is left on its hosts, so there is nothing to undo.';
  return refuse(409, 'nothing-to-undo', why, { golive: row });
}

async function rollbackRun(r) {
  const { row } = r;
  const put = await restore({ record: row, cf: r.cf(r.now() + RESTORE_TIME), sleep: r.sleep, step: stepFor(r), budget: r.allowance });
  if (put.stale) return tookOver(r);
  const error = put.ok ? null : put.errors.join(' ');
  const ended = await finish(r, {
    state: put.ok ? 'rolled-back' : 'rollback-failed',
    fields: { rolled_back_by: r.email, rolled_back_at: r.stamp(), error, notes: put.notes },
    log: put.ok
      ? { action: 'rolled-back', text: `Rolled back ${hostsOf(row)}: the old site is back.`, detail: { notes: put.notes } }
      : {
        action: 'rollback-failed',
        text: `The rollback of ${hostsOf(row)} did not finish. ${error} Roll back again to retry.`,
        detail: { errors: put.errors, notes: put.notes },
      },
    // "Live site runs on" goes back only while it still says what the
    // switch set.
    platform: put.ok ? { to: row.previous_platform, onlyIf: 'astro' } : null,
  });
  if (ended.stale) return tookOver(r);
  return put.ok ? outcome(r, ended) : outcome(r, ended, 502, 'rollback-failed');
}
