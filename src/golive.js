// Going live from the desk: the plan and its checks, the switch, the restore
// that undoes it, and the checks that say it worked. Nothing here reaches out
// on its own. Cloudflare (the client from cloudflare.js), the sites, public
// DNS, sleeping and the Durable Object's record of each step are all passed
// in. The caller passes the request's one counted fetch, so every call made
// here comes out of the request's budget, and the tests run whole switches
// and rollbacks against fakes.
//
// Every text a check or a log entry carries is plain text. Some of it quotes
// the outside world (a rule's description, a page's title, Cloudflare's own
// messages), so the page escapes all of it.
//
// Kept apart from worker.js so it can be tested under plain Node.

import { LIMIT } from './budget.js';
import { isConflict, isNotFound } from './cloudflare.js';

// The desk's own Worker and address. The desk never moves a host onto or off
// itself, and never changes DNS in its own zone.
export const DESK_WORKER = 'website-dashboard';
export const DESK_HOST = 'website.10xid.com';

const WEBSITE = ['A', 'AAAA', 'CNAME'];

// Ten seconds for any one answer, as for Cloudflare's.
const TIMEOUT = 10000;

// A home page is read this far and no further. The checks need the head and
// the first screens, and the Free plan allows 10 ms of CPU a request.
const MAX_PAGE = 1024 * 1024;

// How far a CNAME chain is followed inside the zone.
const MAX_HOPS = 5;

// A new Custom Domain can answer 5xx for a minute or so while Cloudflare puts
// its certificate in place. Past two minutes an error is an error.
const SETTLING = 2 * 60 * 1000;

// A host that gives no answer at all over HTTPS is waited for this long
// after the switch. After that, visitors cannot reach it either.
const NO_ANSWER = 15 * 60 * 1000;

// Waits between tries when Cloudflare reports a clash, which is usually a
// record on its way out: three tries in all.
const RETRY_WAITS = [1000, 2000];

// Waits between listings while a detached Worker's record goes: four
// listings in all.
const GONE_WAITS = [1000, 2000, 4000];

// What a request spends on the Access keys before the plan is rebuilt.
const CERT_CALLS = 2;

// How many Single Redirect rules a zone may have, by plan.
const RULE_LIMITS = { free: 10, pro: 25, business: 50, enterprise: 300 };

// The public resolvers the desk asks, and where each answers DoH JSON.
const RESOLVERS = {
  'dns.google': 'https://dns.google/resolve',
  'cloudflare-dns.com': 'https://cloudflare-dns.com/dns-query',
};
const DNS_TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA' };

const SSL_NAMES = {
  off: 'Off', flexible: 'Flexible', full: 'Full', strict: 'Full (strict)', origin_pull: 'Strict (SSL-Only Origin Pull)',
};

// Codes Cloudflare sends for a token that may not do what was asked.
const AUTH_CODES = [9109, 10000];

// The team works in Toronto. A Worker's clock is UTC, so the zone is named.
const TEAM_ZONE = 'America/Toronto';

// A switch that cannot go on. Thrown before every host is attached, so the
// caller puts everything back. `attached` is what was attached so far, and
// `stale` says another run holds the row now, so this one must not restore.
export class SwitchError extends Error {
  constructor(message, { attached = [], stale = false } = {}) {
    super(message);
    this.name = 'SwitchError';
    this.attached = attached;
    this.stale = stale;
  }
}

// A step the Durable Object refused because another run holds the row.
class Stale extends Error {}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noStep = async () => ({ ok: true });

// --- Small helpers ---

// "WWW.Acme.com." -> "www.acme.com".
const bare = (name) => String(name ?? '').trim().toLowerCase().replace(/\.$/, '');
const isWebsite = (r) => WEBSITE.includes(r.type);
const readOnly = (r) => r?.meta?.read_only === true;
const recordsOn = (records, host) => records.filter((r) => bare(r.name) === host);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const uniqueSorted = (list) => [...new Set(list)].sort();
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "a", "a and b", "a, b and c".
function listed(names, word = 'and') {
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' ' + word + ' ' + names.at(-1) : names[0] || '';
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// One trailing full stop, whatever the text came with.
const sentence = (s) => String(s).replace(/[.\s]*$/, '.');

const ttlText = (r) => (r.ttl == null || r.ttl === 1 ? 'TTL auto' : 'TTL ' + r.ttl);

// "A example.com → 192.0.2.10 (proxied, TTL auto)".
export function recordText(r) {
  return `${r.type} ${bare(r.name)} → ${r.content} (${r.proxied ? 'proxied' : 'DNS only'}, ${ttlText(r)})`;
}

// A Cloudflare error as the page shows it. With no answer at all (out of
// time, out of calls, unreachable) the desk's own words are clearer.
function cfSaid(e) {
  if (!(e?.status > 0)) return sentence(e?.message || e);
  const said = 'Cloudflare said: ' + sentence(e.message);
  const auth = e.status === 401 || e.status === 403 || (e.codes || []).some((c) => AUTH_CODES.includes(c));
  return auth ? said + ' The API token may be missing a permission; see the README.' : said;
}

function check(id, label, status, detail, items) {
  return items?.length ? { id, label, status, detail, items } : { id, label, status, detail };
}

// Fail beats wait beats warn beats pass.
function worst(...statuses) {
  return ['fail', 'wait', 'warn'].find((s) => statuses.includes(s)) || 'pass';
}

export const isReady = (checks) => !checks.some((c) => c.status === 'fail');

// "www.acme.com" is the main address of acme.com, as is acme.com itself.
const isMainAddress = (host, zoneName) => !!zoneName && (host === bare(zoneName) || host === 'www.' + bare(zoneName));

// A go-live record as the store keeps it (main_host, saved_records) or as the
// plan it was made from (main, delete_records, zone: { id, name }).
function runOf(r = {}) {
  return {
    siteId: r.site_id ?? null,
    zoneId: r.zone_id ?? r.zone?.id,
    zoneName: bare(r.zone_name ?? r.zone?.name),
    worker: r.worker,
    stagingHost: r.staging_host,
    main: bare(r.main_host ?? r.main),
    hosts: (r.hosts || []).map((h) => ({ hostname: bare(h.hostname), role: h.role })),
    records: r.saved_records ?? r.delete_records ?? [],
    domains: r.saved_domains ?? [],
    redirect: r.redirect ?? null,
    redirectRule: r.redirect_rule ?? null,
    attached: r.attached ?? [],
    mxTxt: r.mx_txt ?? [],
    switchedAt: r.switched_at ?? null,
    error: r.error ?? null,
  };
}

// --- Costs (§6.0) ---

// Calls a restore may need: three to start and finish, five per host for its
// detach and up to four listings while its Worker record goes, two per
// record put back, three per Custom Domain moved back, one for the redirect
// and one listing that tells the Worker's records apart.
export function restoreCost(record) {
  const r = runOf(record);
  return 3 + r.hosts.length * 5 + r.records.length * 2 + r.domains.length * 3 + (r.redirect ? 1 : 0) + 1;
}

// Calls a switch may make before every host is attached, the only part a
// restore can follow: one per delete and detach, three tries per attach.
// The listing and the redirect after that never lead to a restore, and a
// run out of calls there costs only the note or the redirect.
export function switchCost(plan) {
  const r = runOf(plan);
  return r.records.length + r.domains.length + r.hosts.length * 3;
}

// --- HTML and DNS helpers (§6.7). Regex-based and linear; no DOM. ---

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// A start tag at one place in the page. Quoted values may hold '>'.
const START_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTR = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// Elements whose text is not markup, and where each one ends.
const RAW_TEXT = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi, title: /<\/title\s*>/gi };
// Tags the checks read whatever they carry; any other tag only when it may
// load a file.
const READ_TAGS = new Set(['meta', 'link', 'a']);

function attributes(raw) {
  const attrs = {};
  for (const a of raw.matchAll(ATTR)) {
    const key = a[1].toLowerCase();
    const v = a[2] ?? a[3] ?? a[4] ?? '';
    if (!(key in attrs)) attrs[key] = v.includes('&') ? decode(v) : v;
  }
  return attrs;
}

// The page as the checks read it: its start tags with their attributes,
// its CSS and its title. One pass that never looks at a character twice: a
// comment, script or style is skipped to its end, and one never closed runs
// to the end of the page, as it does in a browser, so an odd page costs no
// more than a plain one. The checks read one page several ways and the Free
// plan allows 10 ms of CPU, so the last page is kept rather than read again.
let lastScan = { html: null };

function scan(html) {
  const text = String(html || '');
  if (lastScan.html === text) return lastScan;
  const tags = [];
  const css = [];
  let title = null;
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i)) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    START_TAG.lastIndex = i;
    const m = START_TAG.exec(text);
    if (!m) {
      // "<" then a letter that never closes: the rest of the page is inside it.
      if (/[a-zA-Z]/.test(text[i + 1] || '')) break;
      i++;
      continue;
    }
    i = START_TAG.lastIndex;
    const name = m[1].toLowerCase();
    if (READ_TAGS.has(name) || /src|poster|style/i.test(m[2])) tags.push({ name, attrs: attributes(m[2]) });
    const close = RAW_TEXT[name];
    if (!close) continue;
    close.lastIndex = i;
    const end = close.exec(text);
    const inner = text.slice(i, end ? end.index : text.length);
    if (name === 'style') css.push(inner);
    if (name === 'title' && title === null) title = inner;
    if (!end) break;
    i = close.lastIndex;
  }
  lastScan = { html: text, tags, css, title };
  return lastScan;
}

const tags = (html) => scan(html).tags;

const relHas = (rel, token) => String(rel || '').toLowerCase().split(/\s+/).includes(token);
const noindexIn = (text) => /\b(noindex|none)\b/i.test(text || '');
const headerOf = (headers, name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) || '';

// The body as text, reading no more than maxBytes, so a huge page costs no
// more than a big one.
export async function readCapped(response, maxBytes = MAX_PAGE) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, maxBytes - size);
    parts.push(part);
    size += part.length;
  }
  if (size >= maxBytes) await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return new TextDecoder().decode(bytes);
}

// What tells search engines to stay away: an X-Robots-Tag header or a robots
// meta tag saying noindex or none. The offending text, or null.
export function robotsNoindex(headers, html) {
  const header = headerOf(headers, 'x-robots-tag');
  if (noindexIn(header)) return 'X-Robots-Tag: ' + header;
  for (const { name, attrs } of tags(html)) {
    const who = String(attrs.name || '').toLowerCase();
    if (name === 'meta' && (who === 'robots' || who === 'googlebot') && noindexIn(attrs.content)) {
      return `<meta name="${who}" content="${attrs.content}">`;
    }
  }
  return null;
}

// The host of the page's canonical link, or null. A relative href is read
// against `base`, the page's own address.
export function canonicalHost(html, base) {
  for (const { name, attrs } of tags(html)) {
    if (name !== 'link' || !relHas(attrs.rel, 'canonical') || !attrs.href) continue;
    try {
      return new URL(attrs.href.trim(), base).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

// The link rels that load a file with the page.
const LOADING_RELS = ['stylesheet', 'icon', 'apple-touch-icon', 'preload', 'modulepreload', 'manifest'];

const srcsetUrls = (v) => v.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
// No '(' inside the value, so each try stops at the next url( and the
// whole search stays linear.
const cssUrls = (css) => [...String(css).matchAll(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi)].map((m) => m[2]);

// Every file the page loads, as absolute http(s) URLs, once each.
export function resourceUrls(html, base) {
  const found = [];
  const page = scan(html);
  for (const { name, attrs } of page.tags) {
    for (const k of ['src', 'data-src', 'poster']) if (attrs[k]) found.push(attrs[k]);
    for (const k of ['srcset', 'data-srcset']) if (attrs[k]) found.push(...srcsetUrls(attrs[k]));
    if (name === 'link' && attrs.href && LOADING_RELS.some((r) => relHas(attrs.rel, r))) found.push(attrs.href);
    if (attrs.style) found.push(...cssUrls(attrs.style));
  }
  for (const css of page.css) found.push(...cssUrls(css));
  // A page repeats its files; each is resolved once.
  const out = new Set();
  for (const raw of new Set(found.map((f) => f.trim()))) {
    if (!URL.canParse(raw, base)) continue;
    const u = new URL(raw, base);
    if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.href);
  }
  return [...out];
}

// Files that come from the old site: WordPress paths anywhere, or anything
// on the hosts that are about to change hands.
export function oldFiles(urls, hosts) {
  const old = new Set(hosts.filter(Boolean).map(bare));
  return urls.filter((u) => {
    try {
      const x = new URL(u);
      return /\/wp-(content|includes)\//i.test(x.pathname) || old.has(x.hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}

// The build's own files. Astro names them by content, so two pages from the
// same build list the same ones, on any host.
export function astroAssets(html) {
  return uniqueSorted(String(html || '').match(/\/_astro\/[^"'\s()<>?#,\\]+/g) || []);
}

export function pageTitle(html) {
  const { title } = scan(html);
  return title === null ? null : decode(title).replace(/\s+/g, ' ').trim();
}

// The first link to another page on the same site, as an absolute URL.
export function firstInternalLink(html, base) {
  const home = new URL(base);
  for (const { name, attrs } of tags(html)) {
    if (name !== 'a' || !attrs.href) continue;
    let u;
    try { u = new URL(attrs.href.trim(), home); } catch { continue; }
    if (u.origin !== home.origin || u.pathname === '/') continue;
    u.hash = '';
    return u.href;
  }
  return null;
}

// Whether the rules for every crawler (User-agent: *) include Disallow: /.
// Cloudflare's managed robots.txt adds its own groups first, a * group that
// allows everything among them, so every * group is read, not just the first.
export function robotsBlocksAll(text) {
  let agents = [];
  let inRules = false;
  for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
    const m = raw.replace(/#.*/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(value.toLowerCase());
    } else {
      inRules = true;
      if (key === 'disallow' && agents.includes('*') && (value === '/' || value === '/*')) return true;
    }
  }
  return false;
}

// TXT as one string: the quotes around each chunk go, and the chunks join
// with nothing between them, as DNS joins them.
const unquote = (txt) => {
  const s = String(txt ?? '').trim();
  return /^".*"$/s.test(s) ? s.slice(1, -1).replace(/"\s*"/g, '') : s;
};

// The hosts whose own address an SPF record lets send mail: `own`, the
// record's name, for a bare a, +a or a/24, and the host of a:host, +a:host
// or a:host/24. -a, ~a and anything but v=spf1 let none.
function spfAHosts(txt, own) {
  const s = unquote(txt);
  if (!/^v=spf1(\s|$)/i.test(s)) return [];
  return s.split(/\s+/).slice(1).flatMap((t) => {
    const m = /^\+?a(?::([^/]+))?(\/\d{1,3})?(\/\/\d{1,3})?$/i.exec(t);
    return m ? [m[1] ? bare(m[1]) : own] : [];
  });
}

// An SPF record whose `a` lets the domain's own address send mail (a, +a,
// a/24), or the address of one of `hosts` by name (a:host). a:other.domain
// does not count.
export function spfHasBareA(txt, hosts = []) {
  const named = new Set(hosts.map(bare));
  return spfAHosts(txt, '').some((h) => h === '' || named.has(h));
}

// Where `name` leads by the zone's own CNAME records, in order, at most five
// hops: ['acme.com'] for mail.acme.com CNAME acme.com. A loop ends it.
export function cnameChain(records, name) {
  const start = bare(name);
  const chain = [];
  let at = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const c = records.find((r) => r.type === 'CNAME' && bare(r.name) === at);
    if (!c) break;
    at = bare(c.content);
    if (at === start || chain.includes(at)) break;
    chain.push(at);
  }
  return chain;
}

// Whether a Worker route's pattern takes requests for `host`. The host part
// is what comes before the first '/', and '*' matches any run of characters.
export function routeCovers(pattern, host) {
  const part = String(pattern || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (!part) return false;
  return new RegExp('^' + part.split('*').map(escapeRe).join('.*') + '$').test(bare(host));
}

function dnsData(type, data) {
  if (type === 'NS' || type === 'CNAME') return bare(data);
  if (type === 'MX') return data.replace(/^(\d+)\s+(\S+)$/, (m, prio, host) => prio + ' ' + bare(host));
  if (type === 'TXT') return unquote(data);
  return data.toLowerCase();
}

// One DoH JSON question to one public resolver → [{ name, type, ttl, data }],
// names without their final dot. NXDOMAIN is an answer of nothing; anything
// else a resolver cannot answer (SERVFAIL, a bad status) throws.
export async function doh(fetchImpl, resolver, name, type) {
  const endpoint = RESOLVERS[resolver];
  if (!endpoint) throw new Error(`The desk does not ask ${resolver}.`);
  const url = `${endpoint}?name=${encodeURIComponent(bare(name))}&type=${encodeURIComponent(type)}`;
  const res = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status !== 200) {
    res.body?.cancel().catch(() => {});
    throw new Error(`${resolver} answered HTTP ${res.status}.`);
  }
  const body = await res.json().catch(() => null);
  if (!body || (body.Status !== 0 && body.Status !== 3)) {
    throw new Error(`${resolver} could not look up ${bare(name)} (status ${body?.Status ?? 'unknown'}).`);
  }
  return (Array.isArray(body.Answer) ? body.Answer : []).map((a) => {
    const t = DNS_TYPES[a.type] ?? String(a.type);
    return { name: bare(a.name), type: t, ttl: a.TTL, data: dnsData(t, String(a.data ?? '')) };
  });
}

// --- Fetching pages ---

const isHtml = (res) => /^text\/html\b/i.test(res.headers.get('content-type') || '');
const anyBody = () => true;
const noBody = () => false;

// A page as the checks need it. `wanted` says whether a 200's body is worth
// reading. Never throws: a page that cannot be had is { error }.
async function getPage(fetchImpl, url, wanted = isHtml) {
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
    const read = res.status === 200 && wanted(res);
    const body = read ? await readCapped(res) : null;
    if (!read) res.body?.cancel().catch(() => {});
    const headers = res.headers;
    return { url, status: res.status, headers, location: headers.get('location'), type: headers.get('content-type') || '', body };
  } catch (error) {
    return { url, error };
  }
}

// "HTTP 302 to https://…", "no answer: getaddrinfo ENOTFOUND …".
function answerText(p) {
  if (p.error) return 'no answer: ' + (p.error.cause?.message || p.error.message);
  if (p.location && p.status >= 300 && p.status < 400) return `HTTP ${p.status} to ${p.location}`;
  if (p.status === 200 && typeof p.body !== 'string') return `HTTP 200 with ${p.type || 'no content type'}`;
  return 'HTTP ' + p.status;
}

const hasPage = (p) => !p.error && p.status === 200 && typeof p.body === 'string';

// --- The plan (§6.3) ---

// Letters, digits, hyphens and dots, at least two labels, nothing else.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function addressesCheck(live, staging, deskHost) {
  const label = 'Live and staging addresses';
  const problems = [];
  if (!live) problems.push('The live domain is not set.');
  else if (!HOSTNAME.test(live)) problems.push(`The live domain ${live} is not a bare hostname such as acme.com (no path, no port).`);
  if (!staging) problems.push('The staging domain is not set.');
  else if (staging.includes('/')) {
    problems.push('Staging is a path on a shared preview host, not a Worker of its own. Give the site its own Worker and hostname first (gate 9).');
  } else if (!HOSTNAME.test(staging)) problems.push(`The staging domain ${staging} is not a bare hostname (no path, no port).`);
  if (live && live === staging) problems.push(`The live and staging domains are the same (${live}).`);
  if (deskHost && live === deskHost) problems.push(`The live domain ${live} is the desk's own address.`);
  if (deskHost && staging === deskHost) problems.push(`The staging domain ${staging} is the desk's own address.`);
  if (problems.length) return check('addresses', label, 'fail', problems.join(' '));
  return check('addresses', label, 'pass', `${live} goes live from ${staging}.`);
}

function zoneCheck(zone, live, deskHost) {
  const bad = (detail) => check('zone', 'Zone on Cloudflare', 'fail', detail);
  if (!zone) {
    return bad(`${live} is not a zone on our Cloudflare account, so the desk cannot change its DNS. Move its DNS to Cloudflare first (gate 6).`);
  }
  if (deskHost && (deskHost === zone.name || deskHost.endsWith('.' + zone.name))) {
    return bad(`${live} is in the desk's own zone (${zone.name}). The desk does not change DNS in its own zone; do that one by hand.`);
  }
  if (zone.status !== 'active') {
    return bad(`${zone.name} is ${zone.status} on Cloudflare, not active, so the records the desk would change are not the ones people see yet. Finish moving its DNS to Cloudflare first (gate 6).`);
  }
  if (zone.paused) return bad(`${zone.name} is paused on Cloudflare, so Cloudflare does not serve it. Unpause it first.`);
  if (zone.type !== 'full') {
    return bad(`${zone.name} is a ${zone.type || 'non-full'} zone: Cloudflare is not its DNS host, so the records the desk would change are not the ones people see.`);
  }
  return check('zone', 'Zone on Cloudflare', 'pass', `${zone.name} is active on our account (${zone.plan || 'unknown'} plan).`);
}

// Check 3 → { check, worker }. The staging host's Custom Domain names the
// Worker; that Worker must be a staging Worker, not someone's live one.
async function workerCheck(cf, staging, zone) {
  const label = 'Staging Worker';
  const bad = (detail) => ({ check: check('worker', label, 'fail', detail) });
  let found;
  try {
    found = await cf.listCustomDomains({ hostname: staging });
  } catch (e) {
    return bad(cfSaid(e));
  }
  if (!found.length) {
    return bad(`${staging} is not a Worker Custom Domain on our account (it may be a Route, a workers.dev address or hosted elsewhere). The desk can only point the live domain at a Worker it can see.`);
  }
  if (found.length > 1) return bad(`${staging} is listed on more than one Worker (${listed(found.map((d) => d.service))}), so the desk cannot tell which one is staging.`);
  const [domain] = found;
  const worker = domain.service;
  if (worker === DESK_WORKER) return bad(`${staging} runs on ${DESK_WORKER}, the desk itself. Staging must be the site's own Worker.`);
  if (isMainAddress(staging, domain.zone_name)) {
    return bad(`${staging} is the main address of ${domain.zone_name}, and a staging address is never a zone's main address — is this another site's live domain?`);
  }
  let served;
  try {
    served = await cf.listCustomDomains({ service: worker });
  } catch (e) {
    return bad(cfSaid(e));
  }
  const other = served.find((d) => d.zone_id !== zone.id && isMainAddress(bare(d.hostname), d.zone_name));
  if (other) return bad(`${worker} already serves ${other.hostname}; it looks like another site's live Worker.`);
  return { check: check('worker', label, 'pass', `${staging} runs on the Worker ${worker}.`), worker };
}

// Check 4 → { check, savedDomains, stop }. `stop` when a host is already on
// the staging Worker or on the desk: the records and mail checks would then
// read that Worker's own record as the old site's.
function hostsCheck({ main, pair, includePair, hosts, worker, domains, records, busy }) {
  const label = 'Hostnames to move';
  const fails = [];
  const warns = [];
  const items = [];
  const savedDomains = [];
  let stop = false;
  for (const { hostname, role } of hosts) {
    items.push(role === 'main' ? `${hostname}: the live address` : `${hostname}: redirects to ${main}`);
    const on = domains.find((d) => bare(d.hostname) === hostname);
    if (!on) continue;
    if (on.service === worker || on.service === DESK_WORKER) {
      stop = true;
      fails.push(on.service === worker
        ? `${hostname} already points at ${worker}; it looks live already.`
        : `${hostname} is on ${DESK_WORKER}, the desk's own Worker. The desk will not move itself.`);
    } else {
      savedDomains.push({ id: on.id, hostname, service: on.service });
      items.push(`${hostname} moves from ${on.service} to ${worker}`);
    }
  }
  const planned = hosts.map((h) => h.hostname);
  for (const b of busy) {
    const host = (b.hosts || []).map(bare).find((x) => planned.includes(x)) || main;
    fails.push(`${host} has an unfinished or live go-live on ${b.name}.`);
  }
  if (pair && !includePair) {
    const website = records ? recordsOn(records, pair).filter(isWebsite) : [];
    const alias = website.length === 1 && website[0].type === 'CNAME' && cnameChain(records, pair).includes(main);
    if (alias) fails.push(`${pair} is an alias of ${main}, so it cannot stay on the old site. Keep 'Also move ${pair}' ticked.`);
    else warns.push(`${pair} stays where it is today and keeps showing the old site.`);
  }
  const moves = hosts.length > 1 ? `Moves ${listed(hosts.map((h) => h.hostname))} to ${worker}; ${pair} redirects to ${main}.` : `Moves ${main} to ${worker}.`;
  const status = worst(fails.length ? 'fail' : 'pass', warns.length ? 'warn' : 'pass');
  return { check: check('hosts', label, status, [...fails, moves, ...warns].join(' '), items), savedDomains, stop };
}

// Check 5 → { check, deleteRecords }. The budget rule is added once the
// plan exists (it needs the whole plan).
function recordsCheck({ hosts, savedDomains, records }) {
  const label = 'DNS records to delete';
  const deleteRecords = [];
  const delegated = [];
  const blocked = [];
  const items = [];
  for (const { hostname } of hosts) {
    // NS records hand the name to other nameservers, so what Cloudflare
    // holds for it is not what people see.
    if (recordsOn(records, hostname).some((r) => r.type === 'NS')) delegated.push(hostname);
    // A hostname with a Custom Domain cannot also carry user A, AAAA or
    // CNAME records, so whatever the listing shows there is the Worker's.
    if (savedDomains.some((d) => d.hostname === hostname)) {
      items.push(`No record to delete on ${hostname}: it is a Custom Domain on another Worker.`);
      continue;
    }
    const here = recordsOn(records, hostname).filter(isWebsite);
    if (!here.length) items.push(`No website record on ${hostname} today.`);
    for (const r of here) {
      if (readOnly(r)) blocked.push(r);
      else deleteRecords.push(r);
      items.push(recordText(r));
    }
  }
  if (delegated.length || blocked.length) {
    const detail = [
      ...delegated.map((h) => `${h} is delegated to other nameservers (NS records), so the desk cannot move it.`),
      ...blocked.map((r) => `${r.type} ${bare(r.name)} is managed by another Cloudflare product; the desk will not touch it.`),
    ].join(' ');
    return { check: check('records', label, 'fail', detail, items), deleteRecords };
  }
  const detail = deleteRecords.length
    ? `Deletes ${plural(deleteRecords.length, 'record')}, saved first so Roll back can put them back exactly.`
    : 'Nothing to delete.';
  return { check: check('records', label, 'pass', detail, items), deleteRecords };
}

// The budget rule: the switch up to its last attach and a full restore must
// both fit in one request, after the Access keys and the `calls` the plan
// itself takes.
function budgetProblem(plan, calls) {
  return CERT_CALLS + calls + switchCost(plan) + restoreCost(plan) > LIMIT;
}

// Check 6: nothing that carries mail may follow a planned host to the Worker.
function mailCheck({ zoneName, hosts, pair, records, deleteRecords }) {
  const label = 'Mail';
  const planned = new Set(hosts.map((h) => h.hostname));
  // The planned host a name is, or reaches by the zone's CNAMEs.
  const reaches = (name) => [bare(name), ...cnameChain(records, name)].find((n) => planned.has(n));
  const fails = [];
  const warns = [];
  const items = [];
  const reported = new Set();

  for (const mx of records.filter((r) => r.type === 'MX')) {
    const target = bare(mx.content);
    const host = reaches(target);
    if (!host) continue;
    reported.add(target);
    items.push(`MX ${bare(mx.name)} → ${target}`);
    fails.push(`Mail for ${bare(mx.name)} is delivered to ${target}, which ${target === host ? 'moves' : 'follows ' + host} onto the Worker.`);
  }
  if (fails.length) {
    fails.push('Moving it would stop the client\'s email. Point the MX at the mail server\'s own name (with its own DNS-only A record) first.');
  }

  const aliases = new Map();
  for (const c of records.filter((r) => r.type === 'CNAME' && !readOnly(r))) {
    const name = bare(c.name);
    if (planned.has(name) || name === pair || reported.has(name)) continue;
    const host = reaches(c.content);
    if (host) aliases.set(host, [...(aliases.get(host) || []), name]);
  }
  for (const [host, names] of aliases) {
    items.push(...names.map((n) => `${n} → ${host}`));
    warns.push(names.length > 1
      ? `These names point at ${host} and will follow it to the new site: ${names.join(', ')}. If they are used for mail, FTP or cPanel, point them at the server's own address first.`
      : `${names[0]} points at ${host} and will follow it to the new site. If it is used for mail, FTP or cPanel, point it at the server's own address first.`);
  }

  // SPF at the apex or at main whose a lets a moving host's own address
  // send mail: a bare a there, or a:<that host>.
  const oldIps = (host) => deleteRecords.filter((r) => bare(r.name) === host && (r.type === 'A' || r.type === 'AAAA')).map((r) => r.content);
  const spfHosts = [...new Set([zoneName, hosts[0].hostname])]
    .flatMap((name) => recordsOn(records, name).filter((r) => r.type === 'TXT').flatMap((r) => spfAHosts(r.content, name)));
  for (const host of new Set(spfHosts)) {
    const ips = oldIps(host);
    if (!ips.length) continue;
    const add = ips.map((ip) => (ip.includes(':') ? 'ip6:' : 'ip4:') + ip).join(' ');
    warns.push(`SPF allows mail from ${host}'s own address (a). After the switch that address is Cloudflare's, so mail sent from ${listed(ips)} would fail SPF. Add ${add} to the SPF record first.`);
  }

  if (!fails.length && !warns.length) {
    return check('mail', label, 'pass', `No mail depends on ${listed(hosts.map((h) => h.hostname), 'or')}.`);
  }
  return check('mail', label, fails.length ? 'fail' : 'warn', [...fails, ...warns].join(' '), items);
}

function mxTxtOf(records, zoneName) {
  return recordsOn(records, zoneName)
    .filter((r) => r.type === 'MX' || r.type === 'TXT')
    .map((r) => ({ type: r.type, name: bare(r.name), content: r.content, priority: r.type === 'MX' ? r.priority ?? null : null }));
}

const mxTxtText = (x) => (x.type === 'MX' ? `MX ${x.priority ?? ''} ${bare(x.content)}`.replace(/\s+/g, ' ') : `TXT ${x.content}`);

// Check 7: the snapshot the verify compares against afterwards.
function mxTxtCheck(snapshot) {
  const mx = snapshot.filter((x) => x.type === 'MX').length;
  return check('mx-txt', 'MX and TXT records', 'pass',
    `${plural(mx, 'MX record')} and ${plural(snapshot.length - mx, 'TXT record')}. The desk never touches them and checks them again afterwards.`,
    snapshot.map(mxTxtText));
}

// Check 8: a Worker route runs before a Custom Domain on the same host.
function routesCheck(routes, hosts) {
  const label = 'Worker routes';
  const hits = [];
  const items = [];
  for (const r of routes) {
    const host = hosts.find((h) => routeCovers(r.pattern, h.hostname))?.hostname;
    if (!host) continue;
    items.push(r.pattern);
    hits.push(r.script
      ? `Worker route ${r.pattern} (Worker ${r.script}) runs in front of a Custom Domain, so ${host} would keep showing that Worker. Remove the route first.`
      : `Worker route ${r.pattern} (set to run no Worker) sits in front of a Custom Domain on ${host}. Remove the route first.`);
  }
  if (hits.length) return check('routes', label, 'fail', hits.join(' '), items);
  return check('routes', label, 'pass', `No Worker route covers ${listed(hosts.map((h) => h.hostname), 'or')}.`);
}

function sslCheck(got, zoneName) {
  const label = 'SSL/TLS mode';
  if (got.error) return check('ssl', label, 'warn', `Could not read the SSL/TLS mode. ${cfSaid(got.error)}`);
  if (got.value === 'full') return check('ssl', label, 'pass', 'SSL/TLS mode is Full. The desk does not change it.');
  return check('ssl', label, 'warn',
    `SSL/TLS mode is ${SSL_NAMES[got.value] || got.value}. Gate 13 keeps it Full for img.${zoneName}; the desk does not change it.`);
}

// The string literals a rule's wildcard operators test: wildcard r"…" and
// strict wildcard "…".
const WILDCARDS = /\bwildcard\s+r?"([^"]*)"/gi;
// What makes a rule's reach hard to read: the whole URL or its path, or an
// operator that matches part of a string.
const UNCLEAR = /full_uri|starts_with|ends_with|contains|matches|wildcard|http\.request\.uri/i;
// A literal that is a hostname, or a URL or pattern that starts with one:
// "blog.acme.com", "https://acme.com/old", r"https://www.*".
const HOST_LITERAL = /"(?:[a-z*]+:\/\/)?[a-z0-9*-]+(?:\.[a-z0-9*-]+)+(?:\/[^"]*)?"/i;

// Whether a rule's expression takes `host`: it names it as a whole
// hostname, not inside a longer one (shop.acme.com is not acme.com), or a
// wildcard in it matches the host or its home page.
function takes(expression, host) {
  if (new RegExp('(^|[^a-z0-9.-])' + escapeRe(host) + '($|[^a-z0-9.-])', 'i').test(expression)) return true;
  const forms = [`https://${host}/`, `http://${host}/`, host, host + '/'];
  return [...expression.matchAll(WILDCARDS)].some((m) => {
    const glob = new RegExp('^' + m[1].split('*').map(escapeRe).join('.*') + '$', 'i');
    return forms.some((f) => glob.test(f));
  });
}

// Check 10. Our own rule (a leftover the switch removes first) is not
// counted against the zone or against main.
function redirectsCheck({ got, main, pair, ref, plan }) {
  const label = 'Redirect rules';
  if (got.error) return check('redirects', label, 'fail', cfSaid(got.error));
  const rules = (got.value?.rules || []).filter((r) => r.ref !== ref);
  const name = (r) => r.description || r.ref || r.id;
  const fails = [];
  const warns = [];
  for (const r of rules.filter((x) => x.enabled !== false)) {
    const expression = String(r.expression || '');
    if (takes(expression, main)) {
      fails.push(`Redirect rule '${name(r)}' already sends ${main} somewhere. The new site would never be seen. Remove it first.`);
    } else if (pair && takes(expression, pair)) {
      warns.push(`Redirect rule '${name(r)}' also matches ${pair} and may answer before the desk's rule.`);
    } else if (UNCLEAR.test(expression) && !HOST_LITERAL.test(expression)) {
      warns.push(`The desk cannot tell whether redirect rule '${name(r)}' applies to ${main}; check it by hand.`);
    }
  }
  const most = RULE_LIMITS[plan];
  if (pair && most && rules.length >= most) {
    fails.push(`The zone already has ${rules.length} redirect rules, the most its plan allows.`);
  }
  const adds = pair ? `Will add a 301 from ${pair} to ${main}.` : null;
  const unread = 'Page Rules and Bulk Redirects are not checked.';
  if (fails.length) return check('redirects', label, 'fail', fails.join(' '));
  if (warns.length) return check('redirects', label, 'warn', [...warns, adds, unread].filter(Boolean).join(' '));
  return check('redirects', label, 'pass', [adds || `No redirect rule touches ${main}.`, unread].join(' '));
}

function wranglerCheck({ worker, hosts, repo, savedDomains }) {
  let detail = `A Workers Builds deploy replaces ${worker}'s Custom Domains with the list in the repo's wrangler config. `
    + `If ${repo || 'the repo'}'s wrangler.jsonc has a routes key, add ${listed(hosts.map((h) => h.hostname))} to it with custom_domain: true `
    + 'and push that BEFORE anything else is deployed. After a Roll back, take them out again.';
  const byWorker = new Map();
  for (const d of savedDomains) byWorker.set(d.service, [...(byWorker.get(d.service) || []), d.hostname]);
  for (const [x, names] of byWorker) {
    detail += ` Also disconnect Workers Builds on ${x}, or remove ${listed(names)} from ${x}'s wrangler config, or ${x}'s next build takes ${names.length > 1 ? 'them' : names[0]} back.`;
  }
  return check('wrangler', 'Wrangler config', 'warn', detail);
}

function stagingStaysCheck(staging, worker) {
  return check('staging-stays', 'Staging address', 'warn',
    `${staging} stays on ${worker} and, without noindex, is a second copy of the live site. Detach it, or keep it deliberately (gate 10).`);
}

// Checks 1–12: everything Cloudflare can say, in eight or nine calls. A
// start runs this again, so it never fetches a page. → { checks, plan,
// calls }; plan is null when an early check makes the rest meaningless, and
// `calls` (with a plan) is how many Cloudflare calls it made.
export async function buildPlan({ site, includePair = true, cf, deskHost = DESK_HOST, busyHosts = [] }) {
  const checks = [];
  const done = () => ({ checks, plan: null });
  const live = site?.live_domain ?? null;
  const staging = site?.staging_domain ?? null;
  const desk = deskHost ? bare(deskHost) : null;

  const addresses = addressesCheck(live, staging, desk);
  checks.push(addresses);
  if (addresses.status === 'fail') return done();

  let zone;
  try {
    zone = await cf.findZone(live);
  } catch (e) {
    checks.push(check('zone', 'Zone on Cloudflare', 'fail', cfSaid(e)));
    return done();
  }
  checks.push(zoneCheck(zone, live, desk));
  if (checks.at(-1).status === 'fail') return done();
  const zoneName = bare(zone.name);

  const w = await workerCheck(cf, staging, zone);
  checks.push(w.check);
  if (!w.worker) return done();
  const worker = w.worker;

  const main = live;
  const pair = main === zoneName ? 'www.' + zoneName : main === 'www.' + zoneName ? zoneName : null;
  const hosts = [{ hostname: main, role: 'main' }, ...(pair && includePair ? [{ hostname: pair, role: 'redirect' }] : [])];
  const planned = new Set(hosts.map((h) => h.hostname));
  const busy = busyHosts.filter((b) => !b.hosts || b.hosts.some((h) => planned.has(bare(h))));

  // One read of each, all at once: the zone's Custom Domains, every record,
  // its Worker routes, its SSL mode and its redirect rules.
  const [domains, listing, routes, ssl, redirects] = await Promise.all([
    settle(cf.listCustomDomains({ zone_id: zone.id })),
    settle(cf.listZoneRecords(zone.id)),
    settle(cf.listWorkerRoutes(zone.id)),
    settle(cf.getSslMode(zone.id)),
    settle(cf.getRedirectEntrypoint(zone.id)),
  ]);

  if (domains.error) {
    checks.push(check('hosts', 'Hostnames to move', 'fail', cfSaid(domains.error)));
    return done();
  }
  const records = listing.error ? null : listing.value;
  const h = hostsCheck({ main, pair, includePair, hosts, worker, domains: domains.value, records, busy });
  checks.push(h.check);
  if (h.stop) return done();
  const savedDomains = h.savedDomains;

  let deleteRecords = [];
  let snapshot = [];
  if (records) {
    const rec = recordsCheck({ hosts, savedDomains, records });
    deleteRecords = rec.deleteRecords;
    snapshot = mxTxtOf(records, zoneName);
    checks.push(rec.check, mailCheck({ zoneName, hosts, pair, records, deleteRecords }), mxTxtCheck(snapshot));
  } else {
    const unread = 'The desk could not read the zone\'s DNS records, so it could not check this.';
    checks.push(
      check('records', 'DNS records to delete', 'fail', cfSaid(listing.error)),
      check('mail', 'Mail', 'fail', unread),
      check('mx-txt', 'MX and TXT records', 'fail', unread));
  }

  checks.push(routes.error ? check('routes', 'Worker routes', 'fail', cfSaid(routes.error)) : routesCheck(routes.value, hosts));
  checks.push(sslCheck(ssl, zoneName));

  const ref = 'desk-' + site.id;
  const redirect = hosts.length > 1 ? { from: pair, to: main, ref } : null;
  checks.push(redirectsCheck({ got: redirects, main, pair: redirect ? pair : null, ref, plan: zone.plan }));
  checks.push(wranglerCheck({ worker, hosts, repo: site.github_repo, savedDomains }));
  checks.push(stagingStaysCheck(staging, worker));

  const plan = {
    site_id: site.id,
    zone: { id: zone.id, name: zoneName, plan: zone.plan ?? null, name_servers: zone.name_servers || [] },
    worker,
    staging_host: staging,
    main,
    hosts,
    delete_records: deleteRecords,
    saved_domains: savedDomains,
    redirect,
    mx_txt: snapshot,
    pair,
    ssl_mode: ssl.error ? null : ssl.value,
  };

  // What this took, and what a start rebuilding the plan takes: findZone
  // asks once per label it walks (www.acme.com, then acme.com), then come
  // the staging host's Custom Domain, its Worker's, and the five reads.
  const zoneLookups = live.split('.').length - zoneName.split('.').length + 1;
  const calls = zoneLookups + 2 + 5;
  if (records && budgetProblem(plan, calls)) {
    const i = checks.findIndex((c) => c.id === 'records');
    checks[i] = check('records', checks[i].label, 'fail',
      'This switch needs more Cloudflare calls than one request allows (too many records). Ask a developer to do it by hand.',
      checks[i].items);
  }
  return { checks, plan, calls };
}

// --- The page checks (13–17) ---

function stagingChecks(page, plan, site) {
  const staging = plan.staging_host;
  if (!hasPage(page)) {
    return [check('staging', 'Staging page', 'fail',
      `Staging did not answer with a page (${answerText(page)}). If it is behind Cloudflare Access or a login, the desk cannot check it.`)];
  }
  const out = [check('staging', 'Staging page', 'pass', `https://${staging}/ answers with a page.`)];

  const noindex = robotsNoindex(page.headers, page.body);
  const repo = site?.github_repo ? ` in ${site.github_repo}` : '';
  out.push(noindex
    ? check('noindex', 'Search engines', 'fail',
      `Staging still tells search engines not to index it, and the live site would inherit that. Delete the X-Robots-Tag block in public/_headers${repo}, push, wait for the build, then check again.`,
      [noindex])
    : check('noindex', 'Search engines', 'pass', 'Staging lets search engines index it.'));

  const main = plan.main;
  const canonical = canonicalHost(page.body, page.url);
  if (!canonical) {
    out.push(check('canonical', 'Canonical address', 'warn',
      `Staging's home page names no canonical address. Set site: 'https://${main}' in the Astro config so every page names one.`));
  } else if (canonical !== main) {
    out.push(check('canonical', 'Canonical address', 'fail',
      `Staging's pages name ${canonical} as their canonical address. Set site: 'https://${main}' in the Astro config first, or search engines will index ${canonical} instead of ${main}.`));
  } else {
    out.push(check('canonical', 'Canonical address', 'pass', `Staging's pages name ${main} as their canonical address.`));
  }

  const oldHosts = [main, plan.pair].filter(Boolean);
  const olds = oldFiles(resourceUrls(page.body, page.url), oldHosts);
  out.push(olds.length
    ? check('old-files', 'Files from the old site', 'fail',
      `Staging's home page loads ${plural(olds.length, 'file')} from the old site (WordPress paths, or ${listed(oldHosts, 'or')}), which break when the old site goes. Point them at the new site's own files first.`,
      olds.slice(0, 5))
    : check('old-files', 'Files from the old site', 'pass', 'Checked the home page; gate 19 checks every page.'));
  return out;
}

function robotsCheck(p) {
  const label = 'robots.txt';
  if (!p.error && p.status === 404) return check('robots', label, 'pass', 'Staging has no robots.txt.');
  if (!hasPage(p)) return check('robots', label, 'warn', `Could not read staging's robots.txt (${answerText(p)}).`);
  if (robotsBlocksAll(p.body)) {
    return check('robots', label, 'fail', 'Staging\'s robots.txt blocks every crawler (Disallow: /). The live site would inherit it.');
  }
  return check('robots', label, 'pass', 'Staging\'s robots.txt lets crawlers in.');
}

// Check 15: the records the desk changes are only the ones people see if
// public DNS asks Cloudflare's nameservers for this zone.
async function nameServersCheck(dohFetch, zone) {
  const label = 'Nameservers';
  const expected = uniqueSorted((zone.name_servers || []).map(bare));
  const asked = await Promise.all(Object.keys(RESOLVERS).map((resolver) => settle(doh(dohFetch, resolver, zone.name, 'NS'))
    .then((got) => ({ resolver, error: got.error, ns: got.value && uniqueSorted(got.value.filter((a) => a.type === 'NS').map((a) => a.data)) }))));
  if (!expected.length) {
    return check('nameservers', label, 'warn', `Cloudflare did not say which nameservers it assigned to ${zone.name}, so the desk could not compare.`);
  }
  const wrong = asked.find((a) => a.ns && !sameList(a.ns, expected));
  if (wrong) {
    return check('nameservers', label, 'fail',
      `Public DNS says ${zone.name}'s nameservers are ${wrong.ns.join(', ') || 'none'}, not the ones Cloudflare assigned (${expected.join(', ')}). The desk would change records nobody reads.`,
      asked.filter((a) => a.ns).map((a) => `${a.resolver}: ${a.ns.join(', ') || 'none'}`));
  }
  const silent = asked.filter((a) => a.error).map((a) => a.resolver);
  if (silent.length === asked.length) {
    return check('nameservers', label, 'warn', 'Neither dns.google nor cloudflare-dns.com answered, so the desk could not check the nameservers.');
  }
  if (silent.length) {
    const other = asked.find((a) => !a.error).resolver;
    return check('nameservers', label, 'warn',
      `${other} gives ${zone.name} the nameservers Cloudflare assigned, but ${silent[0]} did not answer, so only one resolver was checked.`);
  }
  return check('nameservers', label, 'pass',
    `dns.google and cloudflare-dns.com both give ${zone.name} the nameservers Cloudflare assigned (${expected.join(', ')}).`);
}

// Check 16: a site moving from another Worker may rely on secrets that the
// staging Worker does not have. Names only; values are never read.
async function secretsCheck(cf, plan) {
  const label = 'Secrets';
  const worker = plan.worker;
  const olds = [...new Set(plan.saved_domains.map((d) => d.service))];
  const [mine, ...theirs] = await Promise.all([worker, ...olds].map((w) => settle(cf.listSecretNames(w))));
  if (mine.error) return check('other-worker', label, 'warn', `Could not read ${worker}'s secret names. ${cfSaid(mine.error)}`);
  const have = new Set(mine.value);
  const lines = [];
  olds.forEach((x, i) => {
    if (theirs[i].error) { lines.push(`Could not read ${x}'s secret names. ${cfSaid(theirs[i].error)}`); return; }
    const missing = theirs[i].value.filter((n) => !have.has(n));
    if (missing.length) {
      lines.push(`${x} has ${missing.length > 1 ? 'secrets' : 'the secret'} ${listed(missing)} that ${worker} does not. If the new site needs ${missing.length > 1 ? 'them' : 'it'}, add ${missing.length > 1 ? 'them' : 'it'} to ${worker} first.`);
    }
  });
  if (lines.length) return check('other-worker', label, 'warn', lines.join(' '));
  return check('other-worker', label, 'pass', `${worker} has every secret name ${listed(olds)} has.`);
}

export function isFriday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TEAM_ZONE, weekday: 'short' }).format(new Date(now)) === 'Fri';
}

// Checks 13–17: the staging page, its robots.txt, public DNS, the secrets
// and the day. The heavy reading of HTML happens here, never in a start.
export async function pageChecks({ plan, site, cf, siteFetch, doh: dohFetch = siteFetch, now = Date.now() }) {
  const staging = plan.staging_host;
  const [page, robots, ns, secrets] = await Promise.all([
    getPage(siteFetch, `https://${staging}/`),
    getPage(siteFetch, `https://${staging}/robots.txt`, anyBody),
    nameServersCheck(dohFetch, plan.zone),
    plan.saved_domains.length ? secretsCheck(cf, plan) : null,
  ]);
  const checks = [...stagingChecks(page, plan, site), robotsCheck(robots), ns];
  if (secrets) checks.push(secrets);
  if (isFriday(now)) checks.push(check('friday', 'Friday', 'warn', 'It is Friday. Gate 13 says not on a Friday.'));
  return { checks };
}

// What the person must tick before Go live.
export function requiredAcks({ plan, site, now = Date.now() } = {}) {
  const zone = plan?.zone?.name || site?.live_domain || 'the domain';
  const repo = site?.github_repo || 'the repo';
  const acks = [
    { id: 'gate12', label: `Gate 12 is approved in sites/${zone}.md` },
    { id: 'wrangler', label: `I have checked ${repo}’s wrangler config (routes and custom domains)` },
  ];
  if (isFriday(now)) acks.push({ id: 'friday', label: 'It is Friday and this cannot wait' });
  return acks;
}

// The full check: the plan's checks, then the page checks, in order.
// → { checks, plan, ready, acks, planChecks }; planChecks are buildPlan's
// alone, the ones a start can build again.
export async function preflight({ site, includePair = true, cf, deskHost = DESK_HOST, busyHosts = [], siteFetch, doh: dohFetch = siteFetch, now = Date.now() }) {
  const built = await buildPlan({ site, includePair, cf, deskHost, busyHosts });
  const checks = [...built.checks];
  if (built.plan) checks.push(...(await pageChecks({ plan: built.plan, site, cf, siteFetch, doh: dohFetch, now })).checks);
  return { checks, plan: built.plan, ready: isReady(checks), acks: requiredAcks({ plan: built.plan, site, now }), planChecks: built.checks };
}

// Hex SHA-256 of `data` as JSON.
async function sha256(data) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// What a start compares with the check the person read. Only what the switch
// acts on is in it, so a changed SSL mode or page does not count, and a
// record changed since does.
export async function planHash(plan) {
  return sha256(plan ? [
    plan.zone.id,
    plan.worker,
    plan.hosts.map((h) => [h.hostname, h.role]),
    plan.delete_records.map((r) => [r.id, r.type, r.name, r.content, !!r.proxied, r.ttl]),
    plan.saved_domains.map((d) => [d.id, d.hostname, d.service]),
    plan.redirect && [plan.redirect.from, plan.redirect.to],
  ] : null);
}

// What the person read of buildPlan's checks: each one's id, status and
// items. A start compares it too, so a warning that appeared since the
// check (a new name pointing at the apex, say) is always seen before the
// switch, even when the plan itself is the same. Never the page checks: a
// start does not fetch pages.
export async function checksDigest(checks) {
  return sha256(checks.map((c) => [c.id, c.status, c.items || []]));
}

// --- The redirect rule (§6.2) ---

export function redirectRuleFor({ from, to, ref }) {
  return {
    ref,
    description: 'Website Desk: ' + from + ' to ' + to,
    expression: '(http.host eq "' + from + '")',
    action: 'redirect',
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: 'concat("https://' + to + '", http.request.uri.path)' },
        preserve_query_string: true,
      },
    },
    enabled: true,
  };
}

// --- The switch (§6.4) ---

// Why a record must not be switched, or null. Checked before anything is
// touched: the plan was built by this file, but the record came back through
// the database and the network.
function switchProblem(r) {
  if (!r.zoneId || !r.worker || !r.hosts.length) return 'the record has no zone, Worker or hosts.';
  const planned = new Set(r.hosts.map((h) => h.hostname));
  const moved = new Set(r.domains.map((d) => bare(d.hostname)));
  for (const rec of r.records) {
    const name = bare(rec.name);
    if (!rec.id) return `${recordText(rec)} has no id.`;
    if (!isWebsite(rec)) return `${rec.type} ${name} is not an A, AAAA or CNAME record.`;
    if (!planned.has(name)) return `${recordText(rec)} is not on a host this switch moves.`;
    if (readOnly(rec)) return `${recordText(rec)} is managed by another Cloudflare product.`;
    if (moved.has(name)) return `${recordText(rec)} is on ${name}, which is a Custom Domain on another Worker.`;
  }
  for (const d of r.domains) {
    if (!planned.has(bare(d.hostname))) return `${d.hostname} on ${d.service} is not a host this switch moves.`;
    if (!d.id || !d.service || d.service === r.worker) return `${d.hostname} is not on another Worker.`;
  }
  // The redirect's hosts go into the rule's expression as they are, and its
  // ref is how a Roll back finds the rule again.
  if (r.redirect) {
    const { from, to, ref } = r.redirect;
    if (!planned.has(from) || !planned.has(to) || from === to) return `the redirect from ${from} to ${to} is not between two hosts this switch moves.`;
    if (r.siteId && ref !== 'desk-' + r.siteId) return `the redirect rule's ref ${ref} is not this site's.`;
  }
  return null;
}

// Attaches, retrying a clash: it is usually a record just deleted, or the
// other Worker's record just detached, not quite gone yet. `before` runs
// before each try.
async function attachDomain(cf, sleep, domain, before = () => {}) {
  for (let i = 0; ; i++) {
    before();
    try {
      return await cf.attachCustomDomain(domain);
    } catch (e) {
      if (!isConflict(e) || i >= RETRY_WAITS.length) throw e;
      await sleep(RETRY_WAITS[i]);
    }
  }
}

// The record Cloudflare made for an attached host. Every user record there
// was deleted before the attach, so whatever is left is Cloudflare's.
function workerRecordId(listing, host, saved) {
  const here = recordsOn(listing, host).filter((x) => isWebsite(x) && !saved.some((s) => s.id === x.id));
  return (here.find(readOnly) || here[0])?.id ?? null;
}

// Deletes the old records, detaches the hosts from other Workers, attaches
// them to the staging Worker, then adds the redirect. `step(entry)` records
// each action as it happens (goliveStep for this run). A failure before every
// host is attached throws SwitchError, and the caller restores.
// → { attached, redirectRule, redirectError }.
export async function switchOn({ record, cf, sleep = pause, step = noStep, budget = null, deadline = null }) {
  const r = runOf(record);
  const unsafe = switchProblem(r);
  if (unsafe) throw new SwitchError(`The desk did not start: ${unsafe} Nothing was changed.`);
  const reserve = restoreCost(record);
  const attached = [];
  const stop = (message, extra) => new SwitchError(message, { attached: attached.map((a) => ({ ...a })), ...extra });

  // Go on only while there is time, and while this request keeps the calls a
  // restore would need after the call about to be made.
  const room = (what) => () => {
    if (deadline != null && Date.now() >= deadline) throw stop(`Ran out of time before ${what}.`);
    if (budget && budget.remaining() - 1 < reserve) {
      throw stop(`Stopped before ${what}: the Cloudflare calls left in this request are kept for putting everything back.`);
    }
  };
  // A step that cannot be written (the Durable Object reset or is busy)
  // leaves the row behind what was done. Before every host is attached the
  // switch stops, so the caller puts everything back. After that the site is
  // served from the Worker whatever the row says: the switch goes on and
  // writes nothing more.
  let unwritten = false;
  const note = async (entry) => {
    if (unwritten) return;
    let res;
    try {
      res = await step(entry);
    } catch (e) {
      if (attached.length < r.hosts.length) {
        throw stop(`Could not record a step, so the desk stopped and is putting everything back: ${sentence(e?.message || e)}`);
      }
      unwritten = true;
      return;
    }
    if (res?.stale) throw stop('Another run took over this go-live, so this one stopped.', { stale: true });
  };

  for (const rec of r.records) {
    room(`deleting ${recordText(rec)}`)();
    let gone = false;
    try {
      await cf.deleteDnsRecord(r.zoneId, rec.id);
    } catch (e) {
      if (!isNotFound(e)) throw stop(`Could not delete ${recordText(rec)}. ${cfSaid(e)}`);
      gone = true;
    }
    await note({
      log: [{
        action: 'record-deleted',
        text: gone ? `${recordText(rec)} was already gone.` : `Deleted ${recordText(rec)}. It is saved, so Roll back can put it back.`,
        detail: { record: rec, already_gone: gone },
      }],
      add: { steps_done: ['deleted:' + rec.id] },
    });
  }

  for (const d of r.domains) {
    room(`detaching ${d.hostname} from ${d.service}`)();
    let gone = false;
    try {
      await cf.detachCustomDomain(d.id);
    } catch (e) {
      if (!isNotFound(e)) throw stop(`Could not detach ${d.hostname} from ${d.service}. ${cfSaid(e)}`);
      gone = true;
    }
    await note({
      log: [{
        action: 'domain-detached',
        text: gone ? `${d.hostname} was no longer on ${d.service}.` : `Detached ${d.hostname} from ${d.service}.`,
        detail: { domain: d, already_gone: gone },
      }],
      add: { steps_done: ['detached:' + d.id] },
    });
  }

  for (const { hostname } of r.hosts) {
    let domain;
    try {
      domain = await attachDomain(cf, sleep, { hostname, service: r.worker, zone_id: r.zoneId }, room(`attaching ${hostname}`));
    } catch (e) {
      if (e instanceof SwitchError) throw e;
      throw stop(`Could not attach ${hostname} to ${r.worker}. ${cfSaid(e)}`);
    }
    attached.push({ id: domain.id, hostname });
    await note({
      log: [{ action: 'domain-attached', text: `Attached ${hostname} to ${r.worker}.`, detail: { domain } }],
      add: { attached: [{ id: domain.id, hostname }], steps_done: ['attached:' + hostname] },
    });
  }

  // Every host is on the staging Worker now, so the site is served from
  // there whatever happens next. Nothing below undoes the switch, and the
  // calls kept for a restore are free to use.
  let listing = null;
  try {
    listing = await cf.listZoneRecords(r.zoneId);
  } catch (e) {
    await note({
      log: [{
        action: 'worker-records-unknown',
        text: `Could not note the DNS records Cloudflare made for the hosts. ${cfSaid(e)} A Roll back looks for them again.`,
      }],
    });
  }
  if (listing) {
    for (const a of attached) a.dns_id = workerRecordId(listing, a.hostname, r.records);
    await note({
      log: [{
        action: 'worker-records',
        text: 'Noted the DNS record Cloudflare made for each host, so a Roll back can wait for it to go.',
        detail: { attached },
      }],
      fields: { attached },
    });
  }

  let redirectRule = null;
  let redirectError = null;
  if (r.redirect) {
    const { from, to, ref } = r.redirect;
    try {
      // A rule with our ref is left from an earlier run that was cut off.
      for (const old of await cf.findRedirectRules(r.zoneId, ref)) {
        await cf.deleteRedirectRule(r.zoneId, old.ruleset_id, old.rule_id).catch((e) => { if (!isNotFound(e)) throw e; });
        await note({ log: [{ action: 'redirect-removed', text: `Removed a redirect rule an earlier run left behind (${ref}).`, detail: { rule: old } }] });
      }
      redirectRule = await cf.addRedirectRule(r.zoneId, redirectRuleFor(r.redirect));
    } catch (e) {
      if (e instanceof SwitchError) throw e;
      redirectError = e;
    }
    if (redirectRule) {
      await note({
        log: [{ action: 'redirect-added', text: `Added a 301 redirect from ${from} to ${to}.`, detail: { redirect_rule: redirectRule } }],
        fields: { redirect_rule: redirectRule },
        add: { steps_done: ['redirect'] },
      });
    } else {
      await note({
        log: [{
          action: 'redirect-failed',
          text: `Could not add the redirect from ${from} to ${to}. ${cfSaid(redirectError)} The site works on both addresses, but ${from} does not redirect yet.`,
          detail: { error: redirectError.message },
        }],
      });
    }
  }
  return { attached, redirectRule, redirectError };
}

// --- The restore (§6.5) ---

const recordsFor = (r, host) => r.records.filter((x) => bare(x.name) === host);
const savedDomainFor = (r, host) => r.domains.find((d) => bare(d.hostname) === host) || null;

// The same record as a visitor sees it: type, name, content and proxy flag.
const sameRecord = (x, rec) => x.type === rec.type && bare(x.name) === bare(rec.name)
  && bare(x.content) === bare(rec.content) && !!x.proxied === !!rec.proxied;

// The Worker's own record at `host`: one of its known ids, or any read-only
// website record there.
function workerRecordAt(listing, host, dnsIds) {
  return listing.some((x) => dnsIds.includes(x.id) || (bare(x.name) === host && isWebsite(x) && readOnly(x)));
}

// A saved record is back when the same record is there and it is not the
// Worker's (read-only, or one of its ids): the Worker's AAAA 100:: looks
// exactly like the placeholder a www redirect used before.
function present(listing, rec, dnsIds) {
  return listing.some((x) => sameRecord(x, rec) && !readOnly(x) && !dnsIds.includes(x.id));
}

// "The record already exists" (81057): an identical record is there.
const identical = (e) => (e?.codes || []).includes(81057) || /^the record already exists|identical record already exists/i.test(e?.message || '');

// The fewest calls the restore still needs once host i's wait is over:
// putting host i back, a detach, a listing and the put-back for each later
// host, then the final two listings.
function reserveAfter(r, i) {
  const putBack = (h) => recordsFor(r, h).length + (savedDomainFor(r, h) ? 1 : 0);
  return r.hosts.slice(i).reduce((n, { hostname }, k) => n + putBack(hostname) + (k ? 2 : 0), 2);
}

// Puts back what a switch changed: the automatic restore after a failed
// switch, and Roll back. It finds what is there rather than trusting stored
// ids, never throws for one failed step, and works one host at a time
// (detach, wait, put back), so a run cut off leaves at most one host half
// done. The final listing decides `ok`. → { ok, errors, notes }.
export async function restore({ record, cf, sleep = pause, step = noStep, budget = null }) {
  const r = runOf(record);
  const errors = [];
  const notes = [];
  const trouble = [];
  const skipped = new Set();
  const detached = [];
  const savedIds = new Set(r.records.map((x) => x.id));
  // The zone's records as the restore first found them, and in them the ids
  // of the Worker's own records, by host.
  let first = null;
  const workerIds = new Map();

  // A step that cannot be written goes into the notes and the restore goes
  // on: a restore given up half done is worse than a gap in the log.
  const note = async (entry) => {
    let res;
    try {
      res = await step(entry);
    } catch (e) {
      const text = `Could not record a step, so the log may miss it: ${sentence(e?.message || e)}`;
      if (!notes.includes(text)) notes.push(text);
      return;
    }
    if (res?.stale) throw new Stale();
  };
  const logProblem = (text) => note({ log: [{ action: 'restore-problem', text }] });
  // A host the restore leaves as it is: a note, not an error.
  const leave = (host, text, detail) => {
    skipped.add(host);
    notes.push(text);
    return note({ log: [{ action: 'host-left', text, detail }] });
  };

  // Whether `host` is on the Worker now: by the Custom Domain listing, or,
  // with none, by what the switch attached.
  const onWorker = (host, domains) => (domains
    ? domains.some((d) => bare(d.hostname) === host && d.service === r.worker)
    : r.attached.some((a) => bare(a.hostname) === host));
  // The Worker's records at `host`: the one noted at the switch, and every
  // one found there while the host was on the Worker.
  const dnsIdsFor = (host) => [
    ...r.attached.filter((a) => bare(a.hostname) === host && a.dns_id).map((a) => a.dns_id),
    ...(workerIds.get(host) || []),
  ];
  // A saved record the Worker's own record looks exactly like.
  const workerLike = (rec, dnsIds) => (first || []).some((x) => (readOnly(x) || dnsIds.includes(x.id)) && sameRecord(x, rec));

  // A host's problem. The final listing has the last word on it: a record
  // whose create timed out may well be there.
  const problem = (text) => {
    trouble.push(text);
    return logProblem(text);
  };

  // The final listing does not look at redirect rules, so a rule that could
  // not be removed is an error in its own right.
  async function removeRedirect() {
    const { from, to, ref } = r.redirect;
    let rules;
    try {
      rules = await cf.findRedirectRules(r.zoneId, ref);
    } catch (e) {
      errors.push(`Could not look for the redirect rule from ${from} to ${to}. ${cfSaid(e)}`);
      return logProblem(errors.at(-1));
    }
    for (const rule of rules) {
      let failure = null;
      await cf.deleteRedirectRule(r.zoneId, rule.ruleset_id, rule.rule_id).catch((e) => { if (!isNotFound(e)) failure = e; });
      if (failure) {
        errors.push(`Could not remove the redirect rule from ${from} to ${to}. ${cfSaid(failure)}`);
        await logProblem(errors.at(-1));
      } else {
        await note({ log: [{ action: 'redirect-removed', text: `Removed the redirect rule from ${from} to ${to}.`, detail: { rule } }] });
      }
    }
  }

  // Every website record on a host that is on the Worker is the Worker's
  // own: a Custom Domain's host carries no other. Found once, before any
  // detach, because the automatic restore never has a noted dns_id and
  // Cloudflare does not promise to mark them read-only. Without it the
  // restore cannot tell them from a saved record, so it cannot say it
  // finished.
  async function findWorkerRecords(domains) {
    try {
      first = await cf.listZoneRecords(r.zoneId);
    } catch (e) {
      errors.push(`Could not read ${r.zoneName}'s DNS records, so the desk could not tell the Worker's own records from the saved ones. ${cfSaid(e)}`);
      return logProblem(errors.at(-1));
    }
    for (const { hostname: host } of r.hosts) {
      if (onWorker(host, domains)) workerIds.set(host, recordsOn(first, host).filter((x) => isWebsite(x) && !savedIds.has(x.id)).map((x) => x.id));
    }
  }

  // Lists until the Worker's record at `host` has gone: 1 s, 2 s, then 4 s
  // apart. → the listing, or null when it is still there.
  async function waitGone(host, dnsIds, i) {
    let lastError = null;
    for (let n = 0; n <= GONE_WAITS.length; n++) {
      if (n) {
        // Another look only while the rest of the restore keeps its calls.
        if (budget && budget.remaining() - 1 < reserveAfter(r, i)) break;
        await sleep(GONE_WAITS[n - 1]);
      }
      let listing;
      try {
        listing = await cf.listZoneRecords(r.zoneId);
      } catch (e) {
        lastError = e;
        // No answer at all (out of time, out of calls, unreachable) will
        // not come back in a few seconds; a Cloudflare error may.
        if (!(e?.status > 0)) break;
        continue;
      }
      lastError = null;
      if (!workerRecordAt(listing, host, dnsIds)) return listing;
    }
    await problem(lastError
      ? `Could not read ${r.zoneName}'s DNS records to put ${host} back. ${cfSaid(lastError)}`
      : `The Worker's DNS record on ${host} is still there after the detach, so the desk did not put ${host} back yet. Roll back again in a minute.`);
    return null;
  }

  async function recreate(rec, dnsIds) {
    let made = null;
    for (let i = 0; !made; i++) {
      try {
        made = await cf.createDnsRecord(r.zoneId, rec);
      } catch (e) {
        // An identical record is the saved one back, unless the Worker's own
        // record looks the same: then it may be that one, not gone yet.
        if (identical(e) && !workerLike(rec, dnsIds)) return;
        if (!isConflict(e) || i >= RETRY_WAITS.length) return problem(`Could not put back ${recordText(rec)}. ${cfSaid(e)}`);
        await sleep(RETRY_WAITS[i]);
      }
    }
    await note({ log: [{ action: 'record-restored', text: `Put back ${recordText(rec)}.`, detail: { record: made, saved_id: rec.id } }] });
  }

  async function restoreHost(host, domains, i) {
    const saved = savedDomainFor(r, host);
    const here = (domains || []).filter((d) => bare(d.hostname) === host);
    const other = here.find((d) => d.service !== r.worker && d.service !== saved?.service);
    if (other) {
      return leave(host, `${host} is now on ${other.service}, so the desk left it and did not put its old records back.`, { domain: other });
    }
    // Back on the Worker it came from: nothing of the switch is left here.
    if (saved && here.some((d) => d.service === saved.service)) return;

    // Off the Worker, with website records that are neither the saved ones
    // nor the Worker's: someone has pointed it somewhere since, and the old
    // records next to theirs would split its visitors between two sites.
    const dnsIds = dnsIdsFor(host);
    if (first && !onWorker(host, domains)) {
      const theirs = recordsOn(first, host).filter((x) => isWebsite(x) && !readOnly(x) && !dnsIds.includes(x.id)
        && !recordsFor(r, host).some((s) => s.id === x.id || sameRecord(x, s)));
      if (theirs.length) {
        return leave(host, `${host} has other records now (${listed(theirs.map((x) => `${x.type} ${x.content}`))}), so the desk did not put its old ones back next to them.`,
          { records: theirs });
      }
    }

    const ids = new Set([
      ...here.filter((d) => d.service === r.worker).map((d) => d.id),
      ...r.attached.filter((a) => bare(a.hostname) === host && a.id).map((a) => a.id),
    ]);
    for (const id of ids) {
      let failure = null;
      let gone = false;
      await cf.detachCustomDomain(id).catch((e) => { if (isNotFound(e)) gone = true; else failure = e; });
      if (failure) return problem(`Could not detach ${host} from ${r.worker}. ${cfSaid(failure)}`);
      if (gone) continue;
      detached.push(host);
      await note({ log: [{ action: 'domain-detached', text: `Detached ${host} from ${r.worker}.`, detail: { id, hostname: host } }] });
    }

    const listing = await waitGone(host, dnsIds, i);
    if (!listing) return;

    if (saved) {
      let domain;
      try {
        domain = await attachDomain(cf, sleep, { hostname: host, service: saved.service, zone_id: r.zoneId });
      } catch (e) {
        return problem(`Could not move ${host} back to ${saved.service}. ${cfSaid(e)}`);
      }
      return note({ log: [{ action: 'domain-reattached', text: `Moved ${host} back to ${saved.service}.`, detail: { domain } }] });
    }
    for (const rec of recordsFor(r, host)) {
      if (!present(listing, rec, dnsIds)) await recreate(rec, dnsIds);
    }
  }

  // The last word: what is actually there now.
  async function finalCheck() {
    let domains;
    let listing;
    try {
      domains = await cf.listCustomDomains({ zone_id: r.zoneId });
      listing = await cf.listZoneRecords(r.zoneId);
    } catch (e) {
      errors.push(...trouble, `Could not check what is back. ${cfSaid(e)}`);
      return;
    }
    for (const { hostname: host } of r.hosts) {
      const on = (service) => domains.some((d) => bare(d.hostname) === host && d.service === service);
      // Even a host left as it is must be off the Worker by now.
      if (on(r.worker)) errors.push(`${host} is still attached to ${r.worker}.`);
      if (skipped.has(host)) continue;
      const saved = savedDomainFor(r, host);
      if (saved) {
        if (!on(saved.service)) errors.push(`${host} is not back on ${saved.service}.`);
        continue;
      }
      const dnsIds = dnsIdsFor(host);
      for (const rec of recordsFor(r, host)) {
        if (!present(listing, rec, dnsIds)) errors.push(`${recordText(rec)} is not back.`);
      }
    }
  }

  try {
    // A heartbeat first: a run that no longer holds the row changes nothing.
    await note({});
    if (r.redirect) await removeRedirect();
    let domains = null;
    try {
      domains = await cf.listCustomDomains({ zone_id: r.zoneId });
    } catch (e) {
      await problem(`Could not list the Custom Domains, so the desk could not see whether a host is on another Worker now. ${cfSaid(e)}`);
    }
    await findWorkerRecords(domains);
    for (const [i, { hostname }] of r.hosts.entries()) await restoreHost(hostname, domains, i);
    await finalCheck();
  } catch (e) {
    if (!(e instanceof Stale)) throw e;
    return { ok: false, errors: [...errors, 'Another run took over this go-live, so this restore stopped.'], notes, stale: true };
  }
  // Cloudflare keeps a detached Custom Domain's certificate.
  if (detached.length) {
    notes.push(`Cloudflare keeps the certificate it made for ${listed([...new Set(detached)])}. It does no harm; delete it under SSL/TLS › Edge Certificates if you want it gone.`);
  }
  return { ok: errors.length === 0, errors, notes };
}

// --- Verification (§6.6) ---

const unanswered = (host) => `${host} has not answered over HTTPS for 15 minutes since the switch. Visitors may not reach it. Roll back if it does not clear.`;

function httpsCheck(p, main, settling, patient) {
  const label = 'HTTPS';
  if (p.error) {
    return patient ? check('https', label, 'wait', `Waiting for HTTPS on ${main}…`) : check('https', label, 'fail', unanswered(main));
  }
  if (hasPage(p)) return check('https', label, 'pass', `https://${main}/ answers with a page.`);
  if (p.status >= 500) {
    return settling
      ? check('https', label, 'wait', `${main} answers HTTP ${p.status} while Cloudflare finishes setting it up. Waiting…`)
      : check('https', label, 'fail', `The live address answers HTTP ${p.status}. Visitors see an error now. Roll back if it does not clear.`);
  }
  return check('https', label, 'fail', `The live address answers ${answerText(p)}, not the new site's page.`);
}

function liveNoindexCheck(live) {
  const found = robotsNoindex(live.headers, live.body);
  return found
    ? check('noindex', 'Search engines', 'fail',
      'The live site tells search engines not to index it. Delete the X-Robots-Tag block in public/_headers, push, wait for the build, then check again.', [found])
    : check('noindex', 'Search engines', 'pass', 'The live site lets search engines index it.');
}

function sameSiteCheck(live, staging, main) {
  const label = 'Same build as staging';
  if (!hasPage(staging)) return check('same-site', label, 'warn', `Could not read staging (${answerText(staging)}) to compare the builds.`);
  const a = astroAssets(live.body);
  const b = astroAssets(staging.body);
  if (a.length || b.length) {
    if (sameList(a, b)) return check('same-site', label, 'pass', `${main} serves the staging build (the same ${plural(a.length, 'file')} under /_astro/).`);
    return check('same-site', label, 'fail', `${main} is not serving the staging build yet.`);
  }
  if (pageTitle(live.body) === pageTitle(staging.body)) return check('same-site', label, 'warn', 'Same title; could not compare the builds.');
  return check('same-site', label, 'fail', `${main} is not serving the staging build yet.`);
}

async function deepPageCheck(siteFetch, live, main) {
  const label = 'A page past the home page';
  const link = firstInternalLink(live.body, live.url);
  if (!link) return check('deep-page', label, 'warn', `The home page links to no other page on ${main}, so only the home page was checked.`);
  let p = await getPage(siteFetch, link, noBody);
  // One redirect on the same address is how a site adds its trailing slash.
  if (!p.error && p.status >= 300 && p.status < 400 && p.location) {
    const next = URL.canParse(p.location, link) ? new URL(p.location, link) : null;
    if (next?.origin === new URL(link).origin) p = await getPage(siteFetch, next.href, noBody);
  }
  const path = new URL(link).pathname;
  if (!p.error && p.status === 200) return check('deep-page', label, 'pass', `${path} on ${main} answers.`);
  return check('deep-page', label, 'fail', `${path} on ${main} answers ${answerText(p)}.`);
}

// `added` says whether the rule is known to be in. The pair is tested either
// way: when it answers the right 301, the redirect works.
function redirectCheck(hop, r, pair, added, patient) {
  const label = 'Redirect';
  const want = `https://${r.main}/desk-check?x=1`;
  if (!hop.error && hop.status === 301 && hop.location === want) return check('redirect', label, 'pass', `${pair} answers with a 301 to ${r.main}.`);
  if (!added) {
    return check('redirect', label, 'fail',
      `The redirect rule was not added: ${sentence(r.error || 'the switch stopped before adding it')} ${pair} shows the site without redirecting.`);
  }
  if (hop.error) return patient ? check('redirect', label, 'wait', `Waiting for HTTPS on ${pair}…`) : check('redirect', label, 'fail', unanswered(pair));
  return check('redirect', label, 'fail',
    `${pair} answers ${answerText(hop)}, not a 301 to ${want}.${hop.status === 308 ? ' A 308 means another rule answered first.' : ''}`);
}

function stillAttachedCheck(got, r) {
  const label = 'Custom Domains';
  if (got.error) return check('still-attached', label, 'fail', `Could not list the Custom Domains. ${cfSaid(got.error)}`);
  const hosts = r.hosts.map((h) => h.hostname);
  const gone = hosts.filter((h) => !got.value.some((d) => bare(d.hostname) === h && d.service === r.worker));
  if (gone.length) {
    return check('still-attached', label, 'fail', gone.map((h) =>
      `${h} is no longer attached to ${r.worker} (a Workers Builds deploy replaces Custom Domains with the repo's list). The site is down on ${h}.`).join(' '));
  }
  return check('still-attached', label, 'pass', `${listed(hosts)} ${hosts.length > 1 ? 'are' : 'is'} attached to ${r.worker}.`);
}

// Public DNS for every host from both resolvers. Only a DNS-only record
// gave its own content to the world; a proxied one gave Cloudflare's
// addresses before and after, so there is nothing to wait for.
async function publicDnsCheck(dohFetch, r) {
  const label = 'Public DNS';
  const old = r.records.filter((x) => !x.proxied && isWebsite(x));
  if (!old.length) {
    return check('public-dns', label, 'pass', 'The old records were proxied, so public DNS gave Cloudflare\'s addresses before and after; nothing to wait for.');
  }
  const types = old.some((x) => x.type === 'AAAA') ? ['A', 'AAAA'] : ['A'];
  const asks = [];
  for (const { hostname } of r.hosts) {
    for (const resolver of Object.keys(RESOLVERS)) for (const type of types) asks.push({ resolver, hostname, type });
  }
  const got = await Promise.all(asks.map((q) => settle(doh(dohFetch, q.resolver, q.hostname, q.type)).then((a) => ({ ...q, ...a }))));
  const oldContent = new Set(old.map((x) => bare(x.content)));
  const hits = got.flatMap((q) => (q.value || []).filter((a) => oldContent.has(bare(a.data))));
  if (hits.length) {
    const ttl = Math.max(...hits.map((a) => a.ttl || 0));
    return check('public-dns', label, 'wait',
      `Public DNS still returns the old address ${listed(uniqueSorted(hits.map((a) => a.data)))} (cached for up to ${ttl} s).`);
  }
  const silent = uniqueSorted(got.filter((q) => q.error).map((q) => q.resolver));
  if (silent.length === Object.keys(RESOLVERS).length) {
    return check('public-dns', label, 'wait', 'Neither dns.google nor cloudflare-dns.com answered. Checking again later.');
  }
  if (silent.length) {
    return check('public-dns', label, 'warn', `Public DNS no longer returns the old address, but ${silent[0]} did not answer, so only one resolver was checked.`);
  }
  return check('public-dns', label, 'pass', 'Public DNS no longer returns the old address (dns.google + cloudflare-dns.com).');
}

function mxTxtVerifyCheck(listing, mx, r) {
  const label = 'MX and TXT';
  if (listing.error) return check('mx-txt', label, 'fail', `Could not read ${r.zoneName}'s records. ${cfSaid(listing.error)}`);
  const before = new Set(r.mxTxt.map(mxTxtText));
  const now = mxTxtOf(listing.value, r.zoneName);
  const after = new Set(now.map(mxTxtText));
  const items = [
    ...[...before].filter((k) => !after.has(k)).map((k) => 'Gone: ' + k),
    ...[...after].filter((k) => !before.has(k)).map((k) => 'New: ' + k),
  ];
  if (!mx.error) {
    const want = uniqueSorted(r.mxTxt.filter((x) => x.type === 'MX').map((x) => bare(x.content)));
    const got = uniqueSorted(mx.value.filter((a) => a.type === 'MX').map((a) => bare(a.data.split(/\s+/).pop())));
    if (!sameList(want, got)) items.push(`dns.google gives MX ${got.join(', ') || 'none'}, not ${want.join(', ') || 'none'}.`);
  }
  if (items.length) return check('mx-txt', label, 'fail', `MX or TXT at ${r.zoneName} is not what it was before the switch.`, items);
  const count = `${plural(now.filter((x) => x.type === 'MX').length, 'MX record')} and ${plural(now.filter((x) => x.type === 'TXT').length, 'TXT record')}`;
  if (mx.error) {
    return check('mx-txt', label, 'warn', `${count} at ${r.zoneName}, unchanged on Cloudflare; dns.google did not answer, so public DNS was not compared.`);
  }
  return check('mx-txt', label, 'pass', `${count} at ${r.zoneName}, unchanged, and dns.google gives the same mail servers.`);
}

// Is the switch done? Called by Check now and by the page's polling.
// → { checks, done, redirectRule }, statuses pass, fail, warn or wait.
// redirectRule is the desk's rule when the row did not have it and Cloudflare
// does (an answer or a step lost), so the caller can store it; else null.
export async function verify({ record, cf, siteFetch, doh: dohFetch = siteFetch, now = Date.now() }) {
  const r = runOf(record);
  // NaN when the switch time is unknown: nothing to count from, so no
  // settling, and no giving up on a host that does not answer.
  const since = new Date(now).getTime() - Date.parse(r.switchedAt);
  const settling = since <= SETTLING;
  const patient = !(since > NO_ANSWER);
  const pair = r.hosts.find((h) => h.role === 'redirect')?.hostname ?? null;
  const lookUp = !!r.redirect && !r.redirectRule;

  const [live, hop, found, domains, listing, mx, dns] = await Promise.all([
    getPage(siteFetch, `https://${r.main}/`),
    pair ? getPage(siteFetch, `https://${pair}/desk-check?x=1`, noBody) : null,
    lookUp ? settle(cf.findRedirectRules(r.zoneId, r.redirect.ref)) : {},
    settle(cf.listCustomDomains({ zone_id: r.zoneId })),
    settle(cf.listZoneRecords(r.zoneId)),
    settle(doh(dohFetch, 'dns.google', r.zoneName, 'MX')),
    publicDnsCheck(dohFetch, r),
  ]);
  const redirectRule = found.value?.[0] ?? null;

  const checks = [httpsCheck(live, r.main, settling, patient)];
  if (hasPage(live)) {
    const [staging, deep] = await Promise.all([
      r.stagingHost ? getPage(siteFetch, `https://${r.stagingHost}/`) : { error: new Error('The record names no staging host.') },
      deepPageCheck(siteFetch, live, r.main),
    ]);
    checks.push(liveNoindexCheck(live), sameSiteCheck(live, staging, r.main), deep);
  }
  if (pair) checks.push(redirectCheck(hop, r, pair, !!(r.redirectRule || redirectRule), patient));
  checks.push(stillAttachedCheck(domains, r), dns, mxTxtVerifyCheck(listing, mx, r));
  return { checks, done: checks.every((c) => c.status === 'pass' || c.status === 'warn'), redirectRule };
}
