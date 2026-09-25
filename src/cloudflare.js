// A small Cloudflare API client: only the calls going live needs, nothing
// more. Every call sends the token in the Authorization header and nowhere
// else, and never follows a redirect, because a followed redirect would carry
// that header to wherever it points. Errors carry Cloudflare's own codes and
// messages, never the token or the request headers.
//
// Kept apart from worker.js so it can be tested under plain Node.

import { BudgetError } from './budget.js';

const API = 'https://api.cloudflare.com/client/v4';

// Cloudflare usually answers in well under a second. Ten seconds is long
// enough for a slow moment and short enough to leave room for the rest of a
// switch.
const TIMEOUT = 10000;

// One listing of 5,000 records covers any client zone in a single call.
const ZONE_PAGE = 5000;

// A listing that claims more pages than this is not a client zone, and
// following it would spend every call the request has.
const MAX_PAGES = 20;

// Ids and Worker names go into URL paths. new URL() takes '..' (and %2e%2e)
// as a step up, and encodeURIComponent leaves dots alone, so an odd id in
// an answer could turn "delete this rule" into a call on another path.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

const REDIRECT_PHASE = 'http_request_dynamic_redirect';

// 100117: a Custom Domain on a hostname that still has an A, AAAA or CNAME
// record (reported, not documented). 81053/81057/81058: a DNS record that
// clashes with one already there (community reports; the docs quote no code).
const CONFLICT_CODES = [100117, 81053, 81057, 81058];

export class CfError extends Error {
  constructor(status, codes, message) {
    super(message);
    this.name = 'CfError';
    this.status = status;
    this.codes = codes;
  }
}

// Duck-typed rather than instanceof, so an error that crossed a boundary and
// lost its class is still recognised.
export function isConflict(err) {
  if (!err) return false;
  return err.status === 409
    || (err.codes || []).some((c) => CONFLICT_CODES.includes(c))
    || /records? .*already exists|already has .*records?|existing (dns )?records?/i.test(err.message || '');
}

export const isNotFound = (err) => err?.status === 404;

// "Record does not exist. (code 81044)". Cloudflare nests the detail of some
// errors (a malformed token, say) in error_chain, so those are included too.
function errorOf(status, data) {
  const list = (data?.errors || []).flatMap((e) => [e, ...(e.error_chain || [])]);
  const codes = list.map((e) => e.code).filter(Number.isInteger);
  const text = list.map((e) => (e.code ? `${e.message} (code ${e.code})` : e.message)).filter(Boolean).join('; ');
  return new CfError(status, codes, text || `Cloudflare answered HTTP ${status}.`);
}

// Only the settings that are on, and only where Cloudflare's docs say they
// apply: flatten_cname is unavailable on a proxied record (a proxied CNAME is
// always flattened), and ipv4_only / ipv6_only apply only to proxied records.
// A setting that is off is the default, so it stays out, and so does
// `settings` when nothing is left.
function settingsBody(rec) {
  const s = rec.settings;
  if (!s || typeof s !== 'object') return null;
  const on = Object.keys(s).filter((k) => s[k] === true
    && !(k === 'flatten_cname' && rec.proxied)
    && !((k === 'ipv4_only' || k === 'ipv6_only') && !rec.proxied));
  return on.length ? Object.fromEntries(on.map((k) => [k, true])) : null;
}

// Only the fields a record is made from. The read-only ones (id, meta,
// created_on and the rest) are Cloudflare's to set; the new record gets a new
// id anyway.
function recordBody(rec) {
  const body = { type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl, proxied: !!rec.proxied };
  if (rec.comment) body.comment = rec.comment;
  if (Array.isArray(rec.tags) && rec.tags.length) body.tags = rec.tags;
  const settings = settingsBody(rec);
  if (settings) body.settings = settings;
  if (rec.private_routing === true) body.private_routing = true;
  return body;
}

const domainOf = (d) => ({ id: d.id, hostname: d.hostname, service: d.service, zone_id: d.zone_id, zone_name: d.zone_name });

// "Bob.NS.Cloudflare.com." -> "bob.ns.cloudflare.com", the form public DNS
// answers are compared in.
const nameServer = (ns) => String(ns).toLowerCase().replace(/\.$/, '');

// free, pro, business or enterprise, which sets how many redirect rules the
// zone may have. A plan without that legacy id keeps its own name.
const planOf = (plan) => (plan?.legacy_id ? String(plan.legacy_id).toLowerCase() : plan?.name ?? null);

const zoneOf = (z) => ({
  id: z.id,
  name: z.name,
  status: z.status,
  paused: !!z.paused,
  type: z.type ?? null,
  plan: planOf(z.plan),
  name_servers: (Array.isArray(z.name_servers) ? z.name_servers : []).map(nameServer),
});

const outOfTime = () => new CfError(0, [], 'Ran out of time for this run, so the desk stopped calling Cloudflare.');

// The id as it goes into a path, or a refusal before anything is sent.
function safe(id, pattern = ID) {
  if (typeof id !== 'string' || !pattern.test(id)) throw new CfError(0, [], `Refused an odd id from Cloudflare: ${id}.`);
  return id;
}

// `deadline` (ms since the epoch, optional) is when the whole run must be
// done, so it ends while the page is still waiting for the answer. Each call
// then waits ten seconds at most and never past the deadline, and once the
// deadline has passed nothing more is sent.
export function cloudflare({ token, accountId, fetchImpl = fetch, deadline = null }) {
  const account = `/accounts/${accountId}`;

  function timeLeft() {
    if (deadline == null) return TIMEOUT;
    const left = Math.ceil(deadline - Date.now());
    if (left <= 0) throw outOfTime();
    return Math.min(TIMEOUT, left);
  }

  // Why a call got no answer. Running out of calls (the request's budget) is
  // the desk's own limit, not Cloudflare being unreachable, so it goes up
  // unchanged. A timeout shorter than ten seconds was the deadline's.
  function noAnswer(e, wait) {
    if (e instanceof BudgetError) return e;
    if (e?.name === 'TimeoutError' && wait < TIMEOUT) return outOfTime();
    return new CfError(0, [], 'Could not reach Cloudflare: ' + e.message);
  }

  // Answers the whole envelope, so a list can read result_info.
  async function call(method, path, { query, body } = {}) {
    const wait = timeLeft();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, v);
    const headers = { authorization: 'Bearer ' + token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(wait),
      });
    } catch (e) {
      throw noAnswer(e, wait);
    }
    // The timeout also covers reading the body.
    const data = await res.json().catch((e) => {
      if (e?.name === 'TimeoutError') throw noAnswer(e, wait);
      return null;
    });
    if (!data) throw new CfError(res.status, [], `Cloudflare answered HTTP ${res.status} without JSON.`);
    // DELETE dns_records answers { result: { id } } with no success field, so
    // only an explicit false counts as a failure.
    if (!res.ok || data.success === false) throw errorOf(res.status, data);
    return data;
  }

  const get = (path, query) => call('GET', path, { query }).then((d) => d.result);
  const send = (method, path, body) => call(method, path, { body }).then((d) => d.result);

  // Every page of a list, following result_info.total_pages. An empty page
  // ends it whatever the count says.
  async function all(path, query) {
    const out = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const data = await call('GET', path, { query: { ...query, page: page > 1 ? page : null } });
      const got = data.result || [];
      out.push(...got);
      if (!got.length) break;
      pages = data.result_info?.total_pages || 1;
      if (pages > MAX_PAGES) {
        throw new CfError(0, [], `The zone is too large to read in one go (Cloudflare lists more than ${MAX_PAGES} pages).`);
      }
    }
    return out;
  }

  const client = {
    // www.example.co.uk -> example.co.uk -> co.uk: the zone is whichever
    // suffix our account holds. The name filter is already exact; comparing
    // again costs nothing.
    async findZone(hostname) {
      const labels = hostname.toLowerCase().split('.');
      for (let i = 0; i <= labels.length - 2; i++) {
        const name = labels.slice(i).join('.');
        const zones = await get('/zones', { name, 'account.id': accountId });
        const z = zones.find((zone) => String(zone.name).toLowerCase() === name);
        if (z) return zoneOf(z);
      }
      return null;
    },

    async listCustomDomains({ hostname, zone_id, service } = {}) {
      const domains = await get(`${account}/workers/domains`, { hostname, zone_id, service });
      return domains.map(domainOf).filter((d) =>
        (!hostname || String(d.hostname).toLowerCase() === hostname.toLowerCase())
        && (!zone_id || d.zone_id === zone_id)
        && (!service || d.service === service));
    },

    // No `environment`: Cloudflare has deprecated it.
    async attachCustomDomain({ hostname, service, zone_id }) {
      return domainOf(await send('PUT', `${account}/workers/domains`, { hostname, service, zone_id }));
    },

    async detachCustomDomain(id) {
      await send('DELETE', `${account}/workers/domains/${safe(id)}`);
    },

    // Names only. What else the answer holds is dropped here, so no secret
    // value can travel further even if Cloudflare ever sent one.
    async listSecretNames(script) {
      const secrets = await get(`${account}/workers/scripts/${safe(script, SCRIPT)}/secrets`);
      return secrets.map((s) => s.name);
    },

    // Plain `name` is Cloudflare's exact, case-insensitive match on the full
    // name. Records are filtered here again, so a looser match on their side
    // can never put another host's record on the list to delete.
    async listDnsRecords(zoneId, name) {
      const host = name.toLowerCase();
      const records = await all(`/zones/${safe(zoneId)}/dns_records`, { name: host, per_page: 100 });
      return records.filter((r) => String(r.name).toLowerCase() === host);
    },

    // Every record in the zone, as Cloudflare lists them. One call answers
    // every question about the zone's hosts, where a listing per host would
    // cost one call each.
    async listZoneRecords(zoneId) {
      return all(`/zones/${safe(zoneId)}/dns_records`, { per_page: ZONE_PAGE });
    },

    // The zone's Worker routes. A Worker on a route runs before a Custom
    // Domain on the same hostname, which Cloudflare treats as the origin.
    async listWorkerRoutes(zoneId) {
      const routes = await get(`/zones/${safe(zoneId)}/workers/routes`);
      return routes.map((r) => ({ id: r.id, pattern: r.pattern, script: r.script ?? null }));
    },

    async deleteDnsRecord(zoneId, id) {
      await send('DELETE', `/zones/${safe(zoneId)}/dns_records/${safe(id)}`);
    },

    async createDnsRecord(zoneId, rec) {
      return send('POST', `/zones/${safe(zoneId)}/dns_records`, recordBody(rec));
    },

    // off, flexible, full, strict (Full (strict)) or origin_pull.
    async getSslMode(zoneId) {
      return (await get(`/zones/${safe(zoneId)}/settings/ssl`)).value;
    },

    // null when the zone has never had a redirect rule: Cloudflare answers
    // 404 until the first one creates the entry point.
    async getRedirectEntrypoint(zoneId) {
      const path = `/zones/${safe(zoneId)}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`;
      try {
        const ruleset = await get(path);
        return { ...ruleset, rules: ruleset.rules || [] };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    // Every rule in the redirect entry point carrying `ref`, which is how the
    // desk finds its own rule without trusting a stored id.
    async findRedirectRules(zoneId, ref) {
      const entry = await client.getRedirectEntrypoint(zoneId);
      if (!entry) return [];
      return entry.rules.filter((r) => r.ref === ref).map((r) => ({ ruleset_id: entry.id, rule_id: r.id, ref }));
    },

    // Adds one rule and leaves the zone's other redirect rules alone. Never a
    // PUT: a PUT on a ruleset replaces every rule in it. Both answers are the
    // whole ruleset, so the new rule is found by its ref.
    //
    // Safe to repeat. A POST that failed, or whose answer never came, may
    // have made the rule all the same, so after any failed POST the desk
    // looks for its ref before trying again or giving up. There is never a
    // second rule with the same ref.
    async addRedirectRule(zoneId, rule) {
      const mine = (ruleset) => {
        const r = (ruleset?.rules || []).find((x) => x.ref === rule.ref);
        return r ? { ruleset_id: ruleset.id, rule_id: r.id, ref: rule.ref } : null;
      };
      // One POST → { added }, or { error, entry, added? } from a fresh look
      // at the entry point. If even the look fails, the POST's own error
      // says more.
      const attempt = async (path, body) => {
        try {
          const added = mine(await send('POST', path, body));
          if (added) return { added };
          throw new Error(`The redirect rule ${rule.ref} was not in Cloudflare's answer.`);
        } catch (error) {
          const entry = await client.getRedirectEntrypoint(zoneId).catch(() => { throw error; });
          return { error, entry, added: mine(entry) };
        }
      };

      let entry = await client.getRedirectEntrypoint(zoneId);
      if (mine(entry)) return mine(entry);
      if (!entry) {
        const made = await attempt(`/zones/${safe(zoneId)}/rulesets`, {
          name: 'Redirect rules ruleset', kind: 'zone', phase: REDIRECT_PHASE, rules: [rule],
        });
        if (made.added) return made.added;
        // Someone made the entry point between our look and our create, so
        // the rule goes into theirs. With no entry point even now, the
        // create failed for its own reason.
        if (!made.entry) throw made.error;
        entry = made.entry;
      }
      const added = await attempt(`/zones/${safe(zoneId)}/rulesets/${safe(entry.id)}/rules`, rule);
      if (added.added) return added.added;
      throw added.error;
    },

    async deleteRedirectRule(zoneId, rulesetId, ruleId) {
      await send('DELETE', `/zones/${safe(zoneId)}/rulesets/${safe(rulesetId)}/rules/${safe(ruleId)}`);
    },
  };
  return client;
}
