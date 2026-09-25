// In-memory stand-ins for the Cloudflare API, the sites the desk fetches and
// public DNS, so whole go-live and roll-back runs can be tested without
// touching a real zone. Not a test file itself (no .test.js): the tests
// import it.
//
// The Cloudflare fake answers every endpoint src/cloudflare.js calls, with the
// same envelopes and the rules that matter for going live:
//   - a CNAME cannot share a name with an A, AAAA or CNAME, an A/AAAA cannot
//     share one with a CNAME, and nothing website-like can be created over a
//     Worker's own read-only record (code 81053; an identical record is 81057);
//   - attaching a Custom Domain fails with HTTP 409, code 100117, while the
//     hostname still has an A, AAAA or CNAME record, and on success adds the
//     Worker's read-only proxied AAAA 100:: record;
//   - detaching removes the domain and that record, but with `detachLag` the
//     record stays for that many more requests that look at its name (a DNS
//     listing, a record create or an attach), the way Cloudflare sometimes
//     takes a moment;
//   - the redirect entry point answers 404 until the first rule creates it;
//   - a record is refused (400) when it carries flatten_cname and is proxied,
//     or ipv4_only / ipv6_only and is DNS only, whatever the value: the docs
//     say those settings do not apply there, so the client must never send
//     them, not even as false;
//   - a DNS listing gives at most 5,000 records a page.
// Codes 100117, 81053, 81057, 81044, 7000, 7003, 10000 and 10007 are the ones
// Cloudflare is reported to send; the others are stand-ins, since the docs
// quote none for those cases.
//
// A PUT on a ruleset is refused with 405 on purpose. The real API accepts it
// and replaces every rule in the zone, which the desk must never do, so here
// it fails loudly; tests also check `calls` for it.
//
// Below it: a fake for the sites the desk fetches, one for the two public DNS
// resolvers, and combineFetches() to put them all behind one fetch, the way
// the Worker has one fetch for everything.

const BASE = 'https://api.cloudflare.com/client/v4';
const WEBSITE = ['A', 'AAAA', 'CNAME'];
const REDIRECT_PHASE = 'http_request_dynamic_redirect';
const NAME_SERVERS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
const PLAN_NAMES = { free: 'Free Website', pro: 'Pro Website', business: 'Business Website', enterprise: 'Enterprise Website' };

// 'pro' -> the plan object a zone carries; an object is taken as it is, so a
// test can give a plan without a legacy_id.
const planFor = (plan) => (typeof plan === 'string'
  ? { id: 'plan-' + plan, name: PLAN_NAMES[plan] ?? plan, legacy_id: plan }
  : { ...plan });

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const ok = (result, extra = {}) => json(200, { success: true, errors: [], messages: [], result, ...extra });
const fail = (status, code, message, chain) => json(status, {
  success: false,
  errors: [{ code, message, ...(chain && { error_chain: chain }) }],
  messages: [],
  result: null,
});

function paged(list, query, perPageDefault, perPageMax = Infinity) {
  const perPage = Math.min(Math.max(Number(query.per_page) || perPageDefault, 1), perPageMax);
  const page = Math.max(Number(query.page) || 1, 1);
  const result = list.slice((page - 1) * perPage, page * perPage);
  return {
    result,
    result_info: {
      page, per_page: perPage, count: result.length, total_count: list.length,
      total_pages: Math.max(1, Math.ceil(list.length / perPage)),
    },
  };
}

const inZone = (host, zone) => host === zone.name || host.endsWith('.' + zone.name);

export function createFakeCloudflare({
  accountId = 'account-1',
  // [{ id?, name, status = 'active', paused = false, account_id?, type = 'full',
  //    plan = 'free' (or a plan object, or null for none), name_servers? }]
  zones = [],
  records = [],      // [{ zone_id?, type, name, content, ttl?, proxied?, comment?, tags?, settings?, meta?, priority? }]
  domains = [],      // [{ id?, hostname, service, zone_id? }]: each also gets its Worker record
  workers = [],      // Worker names; services in `domains`, keys of `secrets` and route scripts are added
  secrets = {},      // { workerName: ['SECRET_NAME', ...] }
  sslMode = 'full',  // one mode for every zone, or { zoneId: mode }
  rulesets = [],     // [{ zone_id, id?, name?, phase = redirect phase, rules: [...] }]
  routes = [],       // Worker routes: [{ id?, zone_id?, pattern, script? }]
  detachLag = 0,
} = {}) {
  let counter = 0;
  // 32 hex characters, like Cloudflare's ids, and in creation order so a
  // failing test is easy to read. The first character says what it is.
  const newId = (kind) => kind + String(++counter).padStart(31, '0');
  const stamp = () => new Date().toISOString();
  const workerIds = new Map();
  const workerId = (name) => {
    if (!workerIds.has(name)) workerIds.set(name, newId('9'));
    return workerIds.get(name);
  };

  const state = {
    accountId,
    zones: zones.map((z) => ({
      id: z.id || newId('e'),
      name: z.name.toLowerCase(),
      status: z.status || 'active',
      paused: !!z.paused,
      type: z.type || 'full',
      account: { id: z.account_id || accountId },
      ...(z.plan !== null && { plan: planFor(z.plan ?? 'free') }),
      name_servers: [...(z.name_servers || NAME_SERVERS)],
    })),
    records: [],
    domains: [],
    workers: new Set([...workers, ...domains.map((d) => d.service), ...Object.keys(secrets)]),
    secrets: { ...secrets },
    sslMode,
    rulesets: [],
    routes: [],
    detachLag,
  };
  const lingering = new Map(); // record id -> listings left before it goes
  const domainRecord = new Map(); // domain id -> its Worker record id
  const calls = [];
  const failures = [];

  const zoneById = (id) => state.zones.find((z) => z.id === id);
  const zoneFor = (host) => state.zones
    .filter((z) => inZone(host, z))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const recordsAt = (zoneId, name) => state.records.filter((r) => r.zone_id === zoneId && r.name === name);

  // "www", "@" or "WWW.example.com." -> "www.example.com".
  function fqdn(name, zone) {
    const n = String(name).toLowerCase().replace(/\.$/, '');
    if (n === '@') return zone.name;
    return inZone(n, zone) ? n : n + '.' + zone.name;
  }

  function makeRecord(zone, f) {
    const type = String(f.type).toUpperCase();
    const proxiable = WEBSITE.includes(type);
    const proxied = proxiable && !!f.proxied;
    const at = stamp();
    const rec = {
      id: f.id || newId('d'),
      zone_id: zone.id,
      zone_name: zone.name,
      name: fqdn(f.name, zone),
      type,
      content: f.content,
      proxiable,
      proxied,
      // Proxied records are always Auto.
      ttl: proxied ? 1 : f.ttl ?? 1,
      settings: f.settings || {},
      meta: f.meta || {},
      comment: f.comment || null,
      tags: f.tags || [],
      created_on: at,
      modified_on: at,
    };
    if (f.priority != null) rec.priority = f.priority;
    if (f.private_routing === true) rec.private_routing = true;
    if (rec.comment) rec.comment_modified_on = at;
    if (rec.tags.length) rec.tags_modified_on = at;
    return rec;
  }

  function addDomain(zone, hostname, service, id) {
    const domain = {
      id: id || newId('c'),
      zone_id: zone.id,
      zone_name: zone.name,
      hostname,
      service,
      environment: 'production',
      cert_id: crypto.randomUUID(),
    };
    const rec = makeRecord(zone, {
      type: 'AAAA', name: hostname, content: '100::', proxied: true,
      meta: { read_only: true, origin_worker_id: workerId(service) },
    });
    state.domains.push(domain);
    state.records.push(rec);
    domainRecord.set(domain.id, rec.id);
    return domain;
  }

  function removeRecord(id) {
    state.records = state.records.filter((r) => r.id !== id);
    lingering.delete(id);
  }

  // A detached Worker's record is still seen by the next few requests that
  // look at its name, then it goes.
  function seen(recs) {
    for (const r of recs) {
      if (!lingering.has(r.id)) continue;
      const left = lingering.get(r.id) - 1;
      if (left > 0) lingering.set(r.id, left); else removeRecord(r.id);
    }
  }

  function makeRule(r) {
    const id = r.id || newId('b');
    return {
      id,
      version: '1',
      action: r.action,
      expression: r.expression,
      description: r.description ?? '',
      enabled: r.enabled ?? true,
      ref: r.ref || id,
      ...(r.action_parameters && { action_parameters: r.action_parameters }),
      last_updated: stamp(),
    };
  }

  function makeRuleset(zone, { id, name, phase = REDIRECT_PHASE, rules = [] }) {
    return {
      id: id || newId('a'),
      zone_id: zone.id,
      name: name || 'default',
      description: '',
      kind: 'zone',
      phase,
      version: '1',
      last_updated: stamp(),
      rules: rules.map(makeRule),
    };
  }
  const publicRuleset = ({ zone_id, ...rs }) => rs;
  const entrypoint = (zoneId, phase) => state.rulesets.find((rs) => rs.zone_id === zoneId && rs.kind === 'zone' && rs.phase === phase);

  // Why a record's settings are refused, or null. The key alone is enough:
  // sending { flatten_cname: false } on a proxied record is still sending a
  // setting where it does not apply.
  function settingsProblem(type, proxied, settings) {
    if (settings == null) return null;
    if (typeof settings !== 'object' || Array.isArray(settings)) return 'settings must be an object.';
    if (proxied && 'flatten_cname' in settings) {
      return 'flatten_cname is unavailable for proxied records, since they are always flattened.';
    }
    if (!proxied && ('ipv4_only' in settings || 'ipv6_only' in settings)) {
      return `ipv4_only and ipv6_only apply only to proxied records, and this ${type} record is DNS only.`;
    }
    return null;
  }

  // What a redirect rule must hold before Cloudflare will save it.
  function ruleProblem(r) {
    if (!r || typeof r !== 'object') return 'a rule must be an object';
    if (typeof r.expression !== 'string' || !r.expression.trim()) return 'the rule needs an expression';
    if (r.action !== 'redirect') return `'${r.action}' is not a valid action in the ${REDIRECT_PHASE} phase`;
    const from = r.action_parameters?.from_value;
    if (!from?.target_url?.expression && !from?.target_url?.value) return 'the redirect needs a target_url';
    if (from.status_code != null && ![301, 302, 307, 308].includes(from.status_code)) return 'status_code must be 301, 302, 307 or 308';
    return null;
  }

  for (const r of records) {
    const zone = r.zone_id ? zoneById(r.zone_id) : zoneFor(String(r.name).toLowerCase());
    if (!zone) throw new Error('fake-cloudflare: no zone for record ' + r.name);
    state.records.push(makeRecord(zone, r));
  }
  for (const d of domains) {
    const host = d.hostname.toLowerCase();
    const zone = d.zone_id ? zoneById(d.zone_id) : zoneFor(host);
    if (!zone) throw new Error('fake-cloudflare: no zone for domain ' + d.hostname);
    addDomain(zone, host, d.service, d.id);
  }
  for (const rs of rulesets) {
    const zone = zoneById(rs.zone_id);
    if (!zone) throw new Error('fake-cloudflare: no zone ' + rs.zone_id + ' for a ruleset');
    state.rulesets.push(makeRuleset(zone, rs));
  }
  // "*.example.com/*" belongs to example.com.
  for (const r of routes) {
    const host = String(r.pattern).split('/')[0].toLowerCase().replace(/^\*\.?/, '');
    const zone = r.zone_id ? zoneById(r.zone_id) : zoneFor(host);
    if (!zone) throw new Error('fake-cloudflare: no zone for route ' + r.pattern);
    state.routes.push({ id: r.id || newId('7'), zone_id: zone.id, pattern: r.pattern, ...(r.script && { script: r.script }) });
    if (r.script) state.workers.add(r.script);
  }

  // --- Endpoints ---

  function listZones(q) {
    let list = state.zones;
    if (q.name) list = list.filter((z) => z.name === q.name.toLowerCase());
    if (q['account.id']) list = list.filter((z) => z.account.id === q['account.id']);
    if (q.status) list = list.filter((z) => z.status === q.status);
    const { result, result_info } = paged(list, q, 20);
    return ok(result, { result_info });
  }

  function listRecords(zone, q) {
    let list = state.records.filter((r) => r.zone_id === zone.id);
    const name = q.name ?? q['name.exact'];
    if (name) list = list.filter((r) => r.name === name.toLowerCase());
    if (q.type) list = list.filter((r) => r.type === q.type);
    const { result, result_info } = paged(list, q, 100, 5000);
    seen(result);
    return ok(result, { result_info });
  }

  function createRecord(zone, body) {
    if (!body?.type || !body.name || body.content == null || body.content === '') {
      return fail(400, 1004, 'DNS Validation Error', [{ code: 9000, message: 'type, name and content are required.' }]);
    }
    const type = String(body.type).toUpperCase();
    if (type === 'A' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(body.content)) {
      return fail(400, 1004, 'DNS Validation Error', [{ code: 9005, message: 'Content for A record must be a valid IPv4 address.' }]);
    }
    const problem = settingsProblem(type, WEBSITE.includes(type) && !!body.proxied, body.settings);
    if (problem) return fail(400, 1004, 'DNS Validation Error', [{ code: 9041, message: problem }]);
    const name = fqdn(body.name, zone);
    const here = recordsAt(zone.id, name);
    seen(here);
    if (here.some((r) => r.type === type && r.content === body.content)) {
      return fail(400, 81057, 'The record already exists.');
    }
    const clash = (type === 'CNAME' && here.some((r) => WEBSITE.includes(r.type)))
      || (WEBSITE.includes(type) && here.some((r) => r.type === 'CNAME'))
      || (WEBSITE.includes(type) && here.some((r) => r.meta?.read_only && WEBSITE.includes(r.type)));
    if (clash) return fail(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
    const rec = makeRecord(zone, { ...body, type, name, id: undefined, meta: undefined });
    state.records.push(rec);
    return ok(rec);
  }

  // Cloudflare documents this answer as just { result: { id } }.
  function deleteRecord(zone, id) {
    const rec = state.records.find((r) => r.zone_id === zone.id && r.id === id);
    if (!rec) return fail(404, 81044, 'Record does not exist.');
    if (rec.meta?.read_only) return fail(400, 1004, 'This record is managed by another Cloudflare product and cannot be changed here.');
    removeRecord(id);
    return json(200, { result: { id } });
  }

  function listDomains(q) {
    let list = state.domains;
    if (q.hostname) list = list.filter((d) => d.hostname === q.hostname.toLowerCase());
    if (q.zone_id) list = list.filter((d) => d.zone_id === q.zone_id);
    if (q.zone_name) list = list.filter((d) => d.zone_name === q.zone_name.toLowerCase());
    if (q.service) list = list.filter((d) => d.service === q.service);
    const { result, result_info } = paged(list, q, 1000);
    return ok(result, { result_info });
  }

  function attachDomain(body) {
    const hostname = String(body?.hostname || '').toLowerCase();
    const service = body?.service;
    if (!hostname || !service) return fail(400, 100100, 'hostname and service are required.');
    const zone = body.zone_id ? zoneById(body.zone_id) : zoneFor(hostname);
    if (!zone || zone.account.id !== accountId || !inZone(hostname, zone)) {
      return fail(400, 100101, `Hostname '${hostname}' is not in a zone on this account.`);
    }
    if (!state.workers.has(service)) return fail(404, 10007, 'This Worker does not exist on your account.');
    const current = state.domains.find((d) => d.hostname === hostname);
    // PUT: attaching the same hostname to the same Worker again changes nothing.
    if (current && current.service === service) return ok(current);
    if (current) return fail(409, 100116, `Hostname '${hostname}' is already attached to the Worker ${current.service}.`);
    const here = recordsAt(zone.id, hostname);
    seen(here);
    if (here.some((r) => WEBSITE.includes(r.type))) {
      return fail(409, 100117, `Hostname '${hostname}' already has externally managed DNS records (A, CNAME, etc). `
        + "Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override.");
    }
    return ok(addDomain(zone, hostname, service));
  }

  function detachDomain(id) {
    const domain = state.domains.find((d) => d.id === id);
    if (!domain) return fail(404, 100114, 'Domain not found.');
    state.domains = state.domains.filter((d) => d !== domain);
    const recId = domainRecord.get(id);
    domainRecord.delete(id);
    if (state.detachLag > 0) lingering.set(recId, state.detachLag); else removeRecord(recId);
    return ok(null);
  }

  function listRoutes(zone) {
    return ok(state.routes.filter((r) => r.zone_id === zone.id).map(({ zone_id, ...r }) => r));
  }

  function listSecrets(script) {
    if (!state.workers.has(script)) return fail(404, 10007, 'This Worker does not exist on your account.');
    return ok((state.secrets[script] || []).map((name) => ({ name, type: 'secret_text' })));
  }

  function sslSetting(zone) {
    const m = state.sslMode;
    const value = typeof m === 'string' ? m : m[zone.id] ?? 'full';
    return ok({ id: 'ssl', value, editable: true, modified_on: null });
  }

  function getEntrypoint(zone, phase) {
    const rs = entrypoint(zone.id, phase);
    if (!rs) return fail(404, 10003, `could not find entrypoint ruleset in the ${phase} phase`);
    return ok(publicRuleset(rs));
  }

  function createRuleset(zone, body) {
    if (body?.kind !== 'zone' || !body.phase) return fail(400, 20021, 'kind must be zone and phase is required');
    if (entrypoint(zone.id, body.phase)) {
      return fail(400, 20217, `'zone' is not a valid value for kind because exceeded maximum number of zone rulesets for phase ${body.phase}`);
    }
    const problem = (body.rules || []).map(ruleProblem).find(Boolean);
    if (problem) return fail(400, 20021, problem);
    const rs = makeRuleset(zone, body);
    state.rulesets.push(rs);
    return ok(publicRuleset(rs));
  }

  function bump(rs) {
    rs.version = String(Number(rs.version) + 1);
    rs.last_updated = stamp();
  }

  function addRule(zone, rsId, body) {
    const rs = state.rulesets.find((r) => r.zone_id === zone.id && r.id === rsId);
    if (!rs) return fail(404, 10003, 'could not find ruleset ' + rsId);
    const problem = ruleProblem(body);
    if (problem) return fail(400, 20021, problem);
    if (body.ref && rs.rules.some((r) => r.ref === body.ref)) return fail(400, 20021, `a rule with ref '${body.ref}' already exists in this ruleset`);
    rs.rules.push(makeRule({ ...body, id: undefined }));
    bump(rs);
    return ok(publicRuleset(rs));
  }

  function deleteRule(zone, rsId, ruleId) {
    const rs = state.rulesets.find((r) => r.zone_id === zone.id && r.id === rsId);
    if (!rs || !rs.rules.some((r) => r.id === ruleId)) return fail(404, 10003, 'could not find rule ' + ruleId);
    rs.rules = rs.rules.filter((r) => r.id !== ruleId);
    bump(rs);
    return ok(publicRuleset(rs));
  }

  const ZONE = '/zones/(?<zone>[^/]+)';
  const ACCOUNT = '/accounts/(?<account>[^/]+)';
  const endpoints = [
    ['GET', '/zones', (m, q) => listZones(q)],
    ['GET', ZONE + '/dns_records', (m, q, z) => listRecords(z, q)],
    ['POST', ZONE + '/dns_records', (m, q, z, b) => createRecord(z, b)],
    ['DELETE', ZONE + '/dns_records/(?<id>[^/]+)', (m, q, z) => deleteRecord(z, m.id)],
    ['GET', ZONE + '/settings/ssl', (m, q, z) => sslSetting(z)],
    ['GET', ZONE + '/workers/routes', (m, q, z) => listRoutes(z)],
    ['GET', ZONE + '/rulesets/phases/(?<phase>[^/]+)/entrypoint', (m, q, z) => getEntrypoint(z, m.phase)],
    ['POST', ZONE + '/rulesets', (m, q, z, b) => createRuleset(z, b)],
    ['POST', ZONE + '/rulesets/(?<rs>[^/]+)/rules', (m, q, z, b) => addRule(z, m.rs, b)],
    ['DELETE', ZONE + '/rulesets/(?<rs>[^/]+)/rules/(?<rule>[^/]+)', (m, q, z) => deleteRule(z, m.rs, m.rule)],
    ['GET', ACCOUNT + '/workers/domains', (m, q) => listDomains(q)],
    ['PUT', ACCOUNT + '/workers/domains', (m, q, z, b) => attachDomain(b)],
    ['DELETE', ACCOUNT + '/workers/domains/(?<id>[^/]+)', (m) => detachDomain(m.id)],
    ['GET', ACCOUNT + '/workers/scripts/(?<script>[^/]+)/secrets', (m) => listSecrets(decodeURIComponent(m.script))],
  ].map(([method, pattern, handle]) => ({ method, re: new RegExp('^' + pattern + '$'), handle }));

  function route(method, path, query, body) {
    const matches = endpoints.map((r) => ({ r, m: path.match(r.re) })).filter((x) => x.m);
    if (!matches.length) return fail(400, 7000, 'No route for that URI');
    const hit = matches.find((x) => x.r.method === method);
    if (!hit) return fail(405, 7001, `Method ${method} not available for that URI.`);
    const params = hit.m.groups || {};
    if (params.account && params.account !== accountId) return fail(403, 10000, 'Authentication error');
    let zone;
    if (params.zone) {
      zone = zoneById(params.zone);
      if (!zone) return fail(400, 7003, `Could not route to ${path}, perhaps your object identifier is invalid?`);
      if (zone.account.id !== accountId) return fail(403, 10000, 'Authentication error');
    }
    return hit.r.handle(params, query, zone, body);
  }

  function injected(method, path) {
    const f = failures.find((x) => x.times > 0 && (x.method === '*' || x.method === method)
      && (typeof x.pattern === 'string' ? x.pattern === path : x.pattern.test(path)));
    if (!f) return null;
    f.times--;
    const errors = f.codes.length ? f.codes.map((code) => ({ code, message: f.message })) : [{ message: f.message }];
    return json(f.status, { success: false, errors, messages: [], result: null });
  }

  async function fetchFake(input, init = {}) {
    if (init.signal?.aborted) throw init.signal.reason;
    const url = new URL(input.url ?? String(input));
    if (!url.href.startsWith(BASE + '/')) {
      throw new TypeError('fetch failed', { cause: new Error('fake-cloudflare only answers ' + BASE) });
    }
    const method = (init.method || 'GET').toUpperCase();
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    const query = Object.fromEntries(url.searchParams);
    const headers = new Headers(init.headers);
    let body;
    let badJson = false;
    if (init.body != null) {
      try { body = JSON.parse(init.body); } catch { badJson = true; }
    }
    calls.push({ method, url: url.href, path, query, headers: Object.fromEntries(headers), body, redirect: init.redirect, signal: init.signal });

    if (!/^Bearer \S+$/.test(headers.get('authorization') || '')) {
      return fail(400, 9106, 'Missing X-Auth-Key, X-Auth-Email or Authorization headers');
    }
    if (init.body != null && !/^application\/json\b/.test(headers.get('content-type') || '')) {
      return fail(400, 6003, 'Invalid request headers', [
        { code: 6105, message: 'Invalid Content-Type header, valid values are application/json,multipart/form-data' },
      ]);
    }
    if (badJson) return fail(400, 6007, 'Malformed JSON in request body');
    return injected(method, path) || route(method, path, query, body);
  }

  return {
    fetch: fetchFake,
    claims: (url) => url.href.startsWith(BASE + '/'),
    state,
    calls,
    // The next `times` requests whose method and path match fail with this
    // answer. `path` is exact when a string (no /client/v4, no query), or a
    // RegExp; `method` may be '*'.
    failOn(method, path, { status = 500, codes = [], message = 'Injected failure.', times = Infinity } = {}) {
      failures.push({ method: method.toUpperCase(), pattern: path, status, codes, message, times });
    },
    // Every record at a name, including one a detach has not cleared yet.
    recordsAt(name) {
      const n = name.toLowerCase();
      return state.records.filter((r) => r.name === n);
    },
    // The rules in a zone's redirect entry point, or [] when it has none.
    redirectRules(zoneId) {
      return entrypoint(zoneId, REDIRECT_PHASE)?.rules || [];
    },
  };
}

// The sites the desk fetches: staging, then the live and pair hosts.
// `pages` maps a URL to { status = 200, headers, body } (text/html unless the
// headers say otherwise), to a Response, or to a function (url, init) that
// returns either, or throws to act as a TLS or network failure. Lookup tries
// the exact URL, then the URL without its query, then "https://host/*". A
// host with no entry at all fails like a DNS lookup; an unknown path on a
// known host is a 404. `pages` stays live: tests change it between calls.
export function createFakeSites(pages = {}) {
  const calls = [];

  function toResponse(spec) {
    if (spec instanceof Response) return spec;
    const status = spec.status ?? 200;
    const headers = { 'content-type': 'text/html; charset=utf-8', ...spec.headers };
    return new Response([204, 205, 304].includes(status) ? null : spec.body ?? '', { status, headers });
  }

  async function go(url, init, hops) {
    const table = new Map(Object.entries(pages).map(([k, v]) => [new URL(k).href, v]));
    const hosts = new Set([...table.keys()].map((k) => new URL(k).host));
    if (!hosts.has(url.host)) {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND ' + url.hostname) });
    }
    let spec = table.get(url.href) ?? table.get(url.origin + url.pathname) ?? table.get(url.origin + '/*');
    if (typeof spec === 'function') spec = await spec(url, init);
    const res = toResponse(spec ?? { status: 404, body: '<title>Not found</title>' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status > 399 || !location || init.redirect === 'manual') return res;
    if (init.redirect === 'error' || hops >= 20) {
      throw new TypeError('fetch failed', { cause: new Error('redirect not allowed or too many') });
    }
    return go(new URL(location, url), init, hops + 1);
  }

  async function fetchSite(input, init = {}) {
    if (init.signal?.aborted) throw init.signal.reason;
    const url = new URL(input.url ?? String(input));
    calls.push({ url: url.href, method: (init.method || 'GET').toUpperCase(), redirect: init.redirect, signal: init.signal });
    return go(url, init, 0);
  }

  const claims = (url) => Object.keys(pages).some((k) => new URL(k).host === url.host);

  return { fetch: fetchSite, claims, pages, calls };
}

// --- Public DNS over HTTPS ---

// The two resolvers the desk asks, and the path each answers JSON on.
const RESOLVERS = { 'dns.google': '/resolve', 'cloudflare-dns.com': '/dns-query' };
const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [String(v), k]));

const bare = (name) => String(name).toLowerCase().replace(/\.$/, '');
const dotted = (name) => (name.endsWith('.') ? name : name + '.');

// Record data the way each resolver writes it: host names end in a dot, MX
// is "10 mx.example.net.", and cloudflare-dns.com quotes TXT where dns.google
// does not. Tests give plain values.
function dataFor(resolver, type, data) {
  if (['NS', 'CNAME', 'PTR'].includes(type)) return dotted(data);
  if (type === 'MX') return data.replace(/^(\d+\s+)(\S+)$/, (m, prio, host) => prio + dotted(host));
  if (type === 'TXT') {
    const plain = data.replace(/^"(.*)"$/s, '$1');
    return resolver === 'cloudflare-dns.com' ? `"${plain}"` : plain;
  }
  return data;
}

// dns.google and cloudflare-dns.com answering DoH JSON queries:
//   GET https://dns.google/resolve?name=<name>&type=<type>
//   GET https://cloudflare-dns.com/dns-query?name=<name>&type=<type>
//       (with accept: application/dns-json or ct=application/dns-json, or it
//       answers 400 like the real one)
// Each resolver is given a table, { 'example.com': { NS: ['ada.ns.cloudflare.com'],
// A: '192.0.2.10', MX: ['10 mx.example.net'] }, 'www.example.com': { CNAME:
// 'example.com' } }, where a value is data, { data, TTL }, or a list of them.
// Answers are { Status: 0, Answer: [{ name, type, TTL, data }] } with the type
// as a number, as the real ones are:
//   - a name not in the table is NXDOMAIN (Status 3, no Answer);
//   - a name without the asked type answers Status 0 and no Answer at all;
//   - a CNAME is followed, so an A query for www returns the CNAME and then
//     the A records of its target;
//   - dns.google ends names with a dot, cloudflare-dns.com does not.
// A resolver given a function (url, init) answers with what it returns (a
// Response or a JSON body such as { Status: 2 }) or fails like the network if
// it throws. A resolver given nothing cannot be reached. `answers` stays
// live: tests change it between calls, directly or with set().
export function createFakeDoh(answers = {}) {
  const calls = [];

  function lookup(table, resolver, qname, type) {
    const nodes = new Map(Object.entries(table).map(([k, v]) => [bare(k), v]));
    const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
    const entry = (name, t, v) => ({
      name: resolver === 'dns.google' ? name + '.' : name,
      type: TYPES[t],
      TTL: v?.TTL ?? 300,
      data: dataFor(resolver, t, String(v?.data ?? v)),
    });
    const Answer = [];
    let name = qname;
    for (let hop = 0; hop < 10; hop++) {
      const node = nodes.get(name);
      if (!node) return { Status: 3, Answer };
      const [cname] = type === 'CNAME' ? [] : list(node.CNAME);
      if (cname == null) {
        Answer.push(...list(node[type]).map((v) => entry(name, type, v)));
        return { Status: 0, Answer };
      }
      Answer.push(entry(name, 'CNAME', cname));
      name = bare(cname?.data ?? cname);
    }
    return { Status: 2, Answer }; // a CNAME loop: SERVFAIL
  }

  function reply(resolver, status, body) {
    const type = resolver === 'cloudflare-dns.com' ? 'application/dns-json' : 'application/json; charset=UTF-8';
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
  }

  async function fetchDoh(input, init = {}) {
    if (init.signal?.aborted) throw init.signal.reason;
    const url = new URL(input.url ?? String(input));
    const resolver = url.hostname;
    const headers = new Headers(init.headers ?? input.headers);
    const q = url.searchParams;
    calls.push({ resolver, url: url.href, name: q.get('name'), type: q.get('type'), accept: headers.get('accept') });
    const table = answers[resolver];
    if (!Object.hasOwn(RESOLVERS, resolver) || table == null) {
      throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT ' + resolver) });
    }
    if (url.pathname !== RESOLVERS[resolver]) return reply(resolver, 404, 'Not Found');
    if (typeof table === 'function') {
      const out = await table(url, init);
      return out instanceof Response ? out : reply(resolver, 200, out);
    }
    const json = /application\/dns-json/.test(headers.get('accept') || '') || q.get('ct') === 'application/dns-json';
    if (resolver === 'cloudflare-dns.com' && !json) return reply(resolver, 400, 'Bad Request');
    const asked = String(q.get('type') || 'A').toUpperCase();
    const type = TYPE_NAMES[asked] ?? asked;
    if (!q.get('name') || !TYPES[type]) return reply(resolver, 400, { Status: 1, Comment: 'Bad name or type.' });
    const qname = bare(q.get('name'));
    const { Status, Answer } = lookup(table, resolver, qname, type);
    return reply(resolver, 200, {
      Status, TC: false, RD: true, RA: true, AD: false, CD: false,
      Question: [{ name: resolver === 'dns.google' ? qname + '.' : qname, type: TYPES[type] }],
      ...(Answer.length && { Answer }),
    });
  }

  return {
    fetch: fetchDoh,
    claims: (url) => Object.hasOwn(RESOLVERS, url.hostname),
    answers,
    calls,
    // What name + type answers from now on: on every resolver that has a
    // table, or on `only` alone, which gets a table if it has none. null
    // removes the answer.
    set(name, type, values, only) {
      const isTable = (t) => t !== null && typeof t === 'object';
      for (const r of only ? [only] : Object.keys(RESOLVERS)) {
        if (only && !isTable(answers[r])) answers[r] = {};
        const table = answers[r];
        if (!isTable(table)) continue;
        const node = (table[bare(name)] ??= {});
        if (values == null) delete node[type]; else node[type] = values;
      }
    },
  };
}

// --- One fetch for all of them ---

// Puts several fakes behind one fetch, so one counted fetch can wrap them all
// the way it wraps the Worker's fetch. Each part is a fake from this file,
// which knows its own URLs, or [match, fetch] for anything else (the Access
// certs, say), where match is a hostname, a RegExp tried on the whole URL, or
// (url) => boolean. The first part that claims a URL answers it; a URL no
// part claims fails like a DNS lookup. `calls` lists every call in order.
export function combineFetches(...parts) {
  const claimer = (match) => {
    if (typeof match === 'function') return match;
    if (match instanceof RegExp) return (url) => match.test(url.href);
    return (url) => url.hostname === match;
  };
  const owners = parts.map((p) => (Array.isArray(p) ? { claims: claimer(p[0]), fetch: p[1] } : p));
  const calls = [];
  async function fetchAll(input, init = {}) {
    const url = new URL(input.url ?? String(input));
    calls.push({ url: url.href, method: (init.method || input.method || 'GET').toUpperCase() });
    const part = owners.find((o) => o.claims(url));
    if (!part) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND ' + url.hostname) });
    return part.fetch(input, init);
  }
  fetchAll.calls = calls;
  return fetchAll;
}
