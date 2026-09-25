// A small Cloudflare API client: only the calls going live needs, nothing
// more. Every call sends the token in the Authorization header and nowhere
// else, and never follows a redirect, because a followed redirect would carry
// that header to wherever it points. Errors carry Cloudflare's own codes and
// messages, never the token or the request headers.
//
// Kept apart from worker.js so it can be tested under plain Node.

const API = 'https://api.cloudflare.com/client/v4';

// Cloudflare usually answers in well under a second. Ten seconds is long
// enough for a slow moment and short enough to leave room for the rest of a
// switch.
const TIMEOUT = 10000;

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

// Only the fields a record is made from. The read-only ones (id, meta,
// created_on and the rest) are Cloudflare's to set; the new record gets a new
// id anyway.
function recordBody(rec) {
  const body = { type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl, proxied: !!rec.proxied };
  if (rec.comment) body.comment = rec.comment;
  if (Array.isArray(rec.tags) && rec.tags.length) body.tags = rec.tags;
  if (rec.settings && typeof rec.settings === 'object' && Object.keys(rec.settings).length) body.settings = rec.settings;
  if (rec.private_routing === true) body.private_routing = true;
  return body;
}

const domainOf = (d) => ({ id: d.id, hostname: d.hostname, service: d.service, zone_id: d.zone_id, zone_name: d.zone_name });

export function cloudflare({ token, accountId, fetchImpl = fetch }) {
  const account = `/accounts/${accountId}`;

  // Answers the whole envelope, so a list can read result_info.
  async function call(method, path, { query, body } = {}) {
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
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (e) {
      throw new CfError(0, [], 'Could not reach Cloudflare: ' + e.message);
    }
    const data = await res.json().catch(() => null);
    if (!data) throw new CfError(res.status, [], `Cloudflare answered HTTP ${res.status} without JSON.`);
    // DELETE dns_records answers { result: { id } } with no success field, so
    // only an explicit false counts as a failure.
    if (!res.ok || data.success === false) throw errorOf(res.status, data);
    return data;
  }

  const get = (path, query) => call('GET', path, { query }).then((d) => d.result);
  const send = (method, path, body) => call(method, path, { body }).then((d) => d.result);

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
        if (z) return { id: z.id, name: z.name, status: z.status, paused: !!z.paused };
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
      await send('DELETE', `${account}/workers/domains/${id}`);
    },

    // Names only. What else the answer holds is dropped here, so no secret
    // value can travel further even if Cloudflare ever sent one.
    async listSecretNames(script) {
      const secrets = await get(`${account}/workers/scripts/${encodeURIComponent(script)}/secrets`);
      return secrets.map((s) => s.name);
    },

    // Plain `name` is Cloudflare's exact, case-insensitive match on the full
    // name. Records are filtered here again, so a looser match on their side
    // can never put another host's record on the list to delete.
    async listDnsRecords(zoneId, name) {
      const host = name.toLowerCase();
      const out = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const data = await call('GET', `/zones/${zoneId}/dns_records`, {
          query: { name: host, per_page: 100, page: page > 1 ? page : null },
        });
        out.push(...data.result);
        pages = data.result_info?.total_pages || 1;
      }
      return out.filter((r) => String(r.name).toLowerCase() === host);
    },

    async deleteDnsRecord(zoneId, id) {
      await send('DELETE', `/zones/${zoneId}/dns_records/${id}`);
    },

    async createDnsRecord(zoneId, rec) {
      return send('POST', `/zones/${zoneId}/dns_records`, recordBody(rec));
    },

    // off, flexible, full, strict (Full (strict)) or origin_pull.
    async getSslMode(zoneId) {
      return (await get(`/zones/${zoneId}/settings/ssl`)).value;
    },

    // null when the zone has never had a redirect rule: Cloudflare answers
    // 404 until the first one creates the entry point.
    async getRedirectEntrypoint(zoneId) {
      try {
        const ruleset = await get(`/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`);
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
    async addRedirectRule(zoneId, rule) {
      const entry = await client.getRedirectEntrypoint(zoneId);
      let ruleset;
      if (entry) {
        ruleset = await send('POST', `/zones/${zoneId}/rulesets/${entry.id}/rules`, rule);
      } else {
        try {
          ruleset = await send('POST', `/zones/${zoneId}/rulesets`, {
            name: 'Redirect rules ruleset', kind: 'zone', phase: REDIRECT_PHASE, rules: [rule],
          });
        } catch (e) {
          // Someone made the entry point between our look and our create.
          // If it is there now, add to it; if not, the create failed for its
          // own reason.
          const now = await client.getRedirectEntrypoint(zoneId).catch(() => null);
          if (!now) throw e;
          ruleset = await send('POST', `/zones/${zoneId}/rulesets/${now.id}/rules`, rule);
        }
      }
      const added = (ruleset.rules || []).find((r) => r.ref === rule.ref);
      if (!added) throw new Error(`The redirect rule ${rule.ref} was not in Cloudflare's answer.`);
      return { ruleset_id: ruleset.id, rule_id: added.id, ref: rule.ref };
    },

    async deleteRedirectRule(zoneId, rulesetId, ruleId) {
      await send('DELETE', `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`);
    },
  };
  return client;
}
