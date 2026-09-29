// Everything about a site beyond its one row in `sites`: the services and
// accounts it uses, the client's people, its domains in detail, the job list
// from the client form, and its social media accounts. A site
// can have any number of each, so each is a table of its own (schema.js).
// Like sites.js, this is the one place that says what each field may hold,
// and the Worker, the page (through /api/sites/:id/details) and the tests all
// read from here.
//
// Never a password or an API key, in any field: the desk is behind one
// shared key. A service says where its login lives, not what it is.

import { InvalidField, normalizeAddress, normalizeFlag, normalizeText } from './sites.js';

// The kinds of service, in the order the page offers them. A new kind is a
// line here; the database does not check the list, so it needs no migration.
export const SERVICE_KINDS = [
  ['godaddy', 'GoDaddy'],
  ['cloudflare', 'Cloudflare account'],
  ['cloudflare_worker', 'Cloudflare Worker'],
  ['cloudflare_zone', 'Cloudflare zone'],
  ['backblaze_bucket', 'Backblaze B2 bucket'],
  ['database', 'Database'],
  ['gtm', 'Google Tag Manager'],
  ['ga4', 'Google Analytics 4'],
  ['search_console', 'Search Console'],
  ['google_ads', 'Google Ads'],
  ['business_profile', 'Google Business Profile'],
  ['recaptcha', 'reCAPTCHA'],
  ['resend', 'Resend'],
  ['calcom', 'Cal.com'],
  ['stripe', 'Stripe'],
  ['wordpress', 'WordPress admin'],
  ['hosting', 'Other hosting'],
  ['other', 'Other'],
];

// What each domain is for. The database checks this list (schema.js), so a
// change to it is a migration.
export const DOMAIN_ROLES = [
  ['live', 'Live'],
  ['staging', 'Staging'],
  ['image', 'Images (img.)'],
  ['redirect', 'Redirects to the site'],
  ['old', 'Old domain'],
  ['other', 'Other'],
];

// The social media platforms. Each has a table of its own (schema.js), so a
// new platform is a line here and a new migration step, not a line alone.
// The third entry is the domains its profile links live on.
export const SOCIAL_PLATFORMS = [
  ['tiktok', 'TikTok', ['tiktok.com']],
  ['linkedin', 'LinkedIn', ['linkedin.com']],
  ['facebook', 'Facebook', ['facebook.com', 'fb.com', 'fb.me']],
  ['x', 'X', ['x.com', 'twitter.com']],
  ['instagram', 'Instagram', ['instagram.com', 'instagr.am']],
];

// The work a URL on the client form can need, one tick each (site_jobs).
export const JOB_TASKS = [
  ['clone', 'Clone'],
  ['database_b2', 'Database / Backblaze B2'],
  ['seo_ppc', 'SEO / PPC'],
  ['live', 'Live'],
];

const TEXT = { short: 120, identifier: 200, notes: 2000, registrar: 80, phone: 40, handle: 100 };
const URL_LIMIT = 300;

// "https://dash.cloudflare.com/…" or "dash.cloudflare.com/…": kept as a full
// https link, since the page opens it. Only http and https.
export function normalizeUrl(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
  } catch {
    throw new Error('is not a link');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.') || url.username || url.password) {
    throw new Error('is not a link');
  }
  const out = url.toString();
  if (out.length > URL_LIMIT) throw new Error('is too long');
  return out;
}

// Loose on purpose: the desk only needs to be able to write to it.
export function normalizeEmail(raw) {
  const s = normalizeText(raw, TEXT.short);
  if (s === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('is not an email address');
  return s;
}

export function normalizePhone(raw) {
  const s = normalizeText(raw, TEXT.phone);
  if (s === null) return null;
  if (!/^\+?[0-9 ().-]+(\s*(x|ext\.?)\s*[0-9]+)?$/i.test(s) || s.replace(/\D/g, '').length < 7) {
    throw new Error('is not a phone number');
  }
  return s.replace(/\s+/g, ' ');
}

// "@acme", " acme " -> "acme": the name on the platform, without its @.
export function normalizeHandle(raw) {
  const s = normalizeText(raw, TEXT.handle);
  if (s === null) return null;
  const out = s.replace(/^@+/, '');
  if (!out || /\s/.test(out)) throw new Error('should be one word, like @acme');
  return out;
}

// A profile link, on the platform's own domains, always https.
export function profileUrl(label, domains) {
  return (raw) => {
    const s = normalizeUrl(raw);
    if (s === null) return null;
    const url = new URL(s);
    const host = url.hostname.toLowerCase();
    if (!domains.some((d) => host === d || host.endsWith('.' + d))) {
      throw new Error('should be a ' + label + ' link, on ' + domains.join(' or '));
    }
    url.protocol = 'https:';
    return url.toString();
  };
}

// A domain's hostname alone: no path, unlike a staging address.
export function normalizeHostname(raw) {
  const s = normalizeAddress(raw);
  if (s !== null && s.includes('/')) throw new Error('should be a domain without a path');
  return s;
}

// YYYY-MM-DD, and a day that exists.
export function normalizeDate(raw) {
  const s = normalizeText(raw, 10);
  if (s === null) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== s) throw new Error('should be a date like 2027-03-31');
  return s;
}

const oneOf = (list) => (raw) => {
  if (raw === null || raw === '' || raw === undefined) return null;
  if (!list.some(([v]) => v === raw)) throw new Error('must be one of ' + list.map(([v]) => v).join(', '));
  return raw;
};

const text = (limit) => (raw) => normalizeText(raw, limit);

// Each kind of detail: its table, its fields in order with their labels and
// cleaners, which ones must be given, and which are yes/no.
export const ITEMS = {
  services: {
    table: 'site_services',
    item: 'service',
    noun: 'service',
    fields: {
      kind: ['Kind', oneOf(SERVICE_KINDS)],
      identifier: ['ID or name', text(TEXT.identifier)],
      url: ['Link', normalizeUrl],
      account: ['Account', text(TEXT.short)],
      notes: ['Notes', text(TEXT.notes)],
    },
    required: ['kind'],
    flags: [],
    order: 'kind, identifier, created_at',
  },
  contacts: {
    table: 'site_contacts',
    item: 'contact',
    noun: 'contact',
    fields: {
      name: ['Name', text(TEXT.short)],
      role: ['Role', text(TEXT.short)],
      email: ['Email', normalizeEmail],
      phone: ['Phone', normalizePhone],
      notes: ['Notes', text(TEXT.notes)],
    },
    required: ['name'],
    flags: [],
    order: 'lower(name), created_at',
  },
  domains: {
    table: 'site_domains',
    item: 'domain',
    noun: 'domain',
    fields: {
      hostname: ['Domain', normalizeHostname],
      role: ['Used as', oneOf(DOMAIN_ROLES)],
      registrar: ['Registrar', text(TEXT.registrar)],
      dns_on_cloudflare: ['DNS on Cloudflare', normalizeFlag],
      renews_on: ['Renews on', normalizeDate],
      notes: ['Notes', text(TEXT.notes)],
    },
    required: ['hostname', 'role'],
    flags: ['dns_on_cloudflare'],
    order: 'hostname',
    unique: 'hostname',
  },
  // The client form's job list: a URL (an address, with a path if it has
  // one) and the work it needs.
  jobs: {
    table: 'site_jobs',
    item: 'job',
    noun: 'job',
    fields: {
      url: ['URL', normalizeAddress],
      ...Object.fromEntries(JOB_TASKS.map(([task, label]) => [task, [label, normalizeFlag]])),
      notes: ['Notes', text(TEXT.notes)],
    },
    required: ['url'],
    flags: JOB_TASKS.map(([task]) => task),
    order: 'created_at, id',
    unique: 'url',
  },
  // One kind per social media platform, each with its own table. The page
  // shows them together, under Social media (`group`).
  ...Object.fromEntries(SOCIAL_PLATFORMS.map(([platform, label, domains]) => [platform, {
    table: 'site_' + platform,
    item: platform,
    noun: label + ' link',
    group: 'socials',
    fields: {
      handle: ['Handle', normalizeHandle],
      url: ['Link', profileUrl(label, domains)],
      account: ['Account', text(TEXT.short)],
      notes: ['Notes', text(TEXT.notes)],
    },
    required: ['url'],
    flags: [],
    order: 'created_at',
    unique: 'url',
  }])),
};

export const KINDS = Object.keys(ITEMS);

// Cleans whichever fields of `kind` are present in `input` and ignores the
// rest, as cleanSite() does. With `creating`, the required ones must be there.
export function cleanItem(kind, input, { creating = false } = {}) {
  const spec = ITEMS[kind];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidField(null, 'Expected a JSON object.');
  }
  const out = {};
  for (const [field, [label, clean]] of Object.entries(spec.fields)) {
    if (!(field in input)) continue;
    try { out[field] = clean(input[field]); } catch (e) {
      throw new InvalidField(field, label + ' ' + e.message + '.');
    }
  }
  for (const field of spec.required) {
    if ((creating || field in input) && out[field] == null) {
      throw new InvalidField(field, spec.fields[field][0] + ' is required.');
    }
  }
  return out;
}

// Flags are 0/1/NULL in the database and true/false/null on the page.
export function itemJson(kind, row) {
  const out = { ...row };
  for (const f of ITEMS[kind].flags) out[f] = row[f] === null || row[f] === undefined ? null : row[f] === 1;
  return out;
}

// What the page needs to draw the forms, so its lists never drift from these.
export const CHOICES = {
  service_kinds: SERVICE_KINDS,
  domain_roles: DOMAIN_ROLES,
  job_tasks: JOB_TASKS,
  social_platforms: SOCIAL_PLATFORMS.map(([value, label]) => [value, label]),
};
