// The one place that knows what a site record is: its fields, what each may
// hold, and how raw input is cleaned before it reaches the database. The
// Worker and the tests both read from here, so the rules cannot drift apart.

// Where the live site runs. 'none' is a real answer ("not live yet"); a
// missing value (null) means nobody has filled it in, which is not the same.
export const PLATFORMS = ['astro', 'wordpress', 'other', 'none'];

// The yes/no questions. null is "not set" — shown as such, never as a no.
export const FLAGS = ['astro_staging', 'domain_ours', 'needs_seo_ppc'];

const TEXT_LIMITS = { name: 120, environment: 80, notes: 2000 };
const ADDRESS_LIMIT = 300;

// Every field a person sets, in the order the table holds them.
export const COLUMNS = ['name', 'live_domain', 'staging_domain', 'github_repo', 'chat_url', 'environment',
  'live_platform', ...FLAGS, 'notes'];

// Made when the object first starts rather than by a migration step, so a
// fresh deploy works with nothing to run by hand.
const SCHEMA = `CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  live_domain    TEXT,
  staging_domain TEXT,
  github_repo    TEXT,
  chat_url       TEXT,
  environment    TEXT,
  live_platform  TEXT CHECK (live_platform IN ('astro','wordpress','other','none')),
  astro_staging  INTEGER CHECK (astro_staging IN (0,1)),
  domain_ours    INTEGER CHECK (domain_ours IN (0,1)),
  needs_seo_ppc  INTEGER CHECK (needs_seo_ppc IN (0,1)),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`;

// Columns that came after the live table was first made. SQLite adds a
// column in place and keeps every row, so an existing desk picks them up the
// next time it starts; once they are there this does nothing.
const ADDED = { chat_url: 'TEXT', environment: 'TEXT' };

// `sql` is the Durable Object's ctx.storage.sql, or anything shaped like it.
export function ensureSitesSchema(sql) {
  sql.exec(SCHEMA);
  const have = new Set(sql.exec('PRAGMA table_info(sites)').toArray().map((c) => c.name));
  for (const [name, type] of Object.entries(ADDED)) {
    if (!have.has(name)) sql.exec(`ALTER TABLE sites ADD COLUMN ${name} ${type}`);
  }
}

export class InvalidField extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

// "https://www.Example.com/" -> "www.example.com". A staging address may carry
// a path (preview hosts often serve a site under /id/<name>/), so the path is
// kept; only the scheme, the trailing slash and the host's case are dropped.
export function normalizeAddress(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  if (!s) return null;
  const slash = s.indexOf('/');
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? '' : s.slice(slash);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(host)) {
    throw new Error('is not a domain');
  }
  if (/\s/.test(path)) throw new Error('cannot contain spaces');
  const out = host + path;
  if (out.length > ADDRESS_LIMIT) throw new Error('is too long');
  return out;
}

// "https://github.com/Owner/Repo.git" or "Owner/Repo" -> "Owner/Repo".
// GitHub's own casing is kept, since that is how the repo is named.
export function normalizeRepo(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!m) throw new Error('should look like owner/repo');
  return m[1] + '/' + m[2];
}

// The Claude chat where the site is worked on: "claude.ai/code/session_…" or
// the same with https://. Only claude.ai links are kept, so the page never
// shows a link to anywhere else under the name "Chat".
export function normalizeChatUrl(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
  } catch {
    throw new Error('should be a claude.ai link');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (host !== 'claude.ai' && host !== 'www.claude.ai') || url.username || url.password || url.port) {
    throw new Error('should be a claude.ai link');
  }
  const out = 'https://claude.ai' + url.pathname.replace(/\/+$/, '') + url.search;
  if (out.length > ADDRESS_LIMIT) throw new Error('is too long');
  return out;
}

function normalizeFlag(raw) {
  if (raw === null || raw === '' || raw === undefined) return null;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'yes') return 1;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false' || raw === 'no') return 0;
  throw new Error('must be yes, no or not set');
}

function normalizeText(raw, limit) {
  if (raw == null) return null;
  const s = String(raw).replace(/\r\n/g, '\n').trim();
  if (!s) return null;
  if (s.length > limit) throw new Error('is longer than ' + limit + ' characters');
  return s;
}

const LABELS = {
  name: 'Client name', live_domain: 'Live domain', staging_domain: 'Staging domain',
  github_repo: 'GitHub repo', chat_url: 'Chat link', environment: 'Environment',
  live_platform: 'Live platform', notes: 'Notes',
  astro_staging: 'Astro staging', domain_ours: 'Domain', needs_seo_ppc: 'SEO / PPC',
};

// Cleans whichever fields are present in `input` and ignores everything else,
// so a PATCH that sends one field changes one field. With `creating`, a name
// is required.
export function cleanSite(input, { creating = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidField(null, 'Expected a JSON object.');
  }
  const out = {};
  const run = (field, fn) => {
    if (!(field in input)) return;
    try { out[field] = fn(input[field]); } catch (e) {
      throw new InvalidField(field, LABELS[field] + ' ' + e.message + '.');
    }
  };
  run('name', (v) => normalizeText(v, TEXT_LIMITS.name));
  run('notes', (v) => normalizeText(v, TEXT_LIMITS.notes));
  run('live_domain', normalizeAddress);
  run('staging_domain', normalizeAddress);
  run('github_repo', normalizeRepo);
  run('chat_url', normalizeChatUrl);
  // One line: an environment's name, such as "backblaze/CF".
  run('environment', (v) => normalizeText(v, TEXT_LIMITS.environment)?.replace(/\s+/g, ' ') ?? null);
  run('live_platform', (v) => {
    if (v === null || v === '' || v === undefined) return null;
    if (!PLATFORMS.includes(v)) throw new Error('must be one of ' + PLATFORMS.join(', '));
    return v;
  });
  FLAGS.forEach((f) => run(f, normalizeFlag));

  if ((creating || 'name' in input) && !out.name) {
    throw new InvalidField('name', 'Client name is required.');
  }
  return out;
}

// The database stores flags as 0/1/NULL; the page gets true/false/null.
export function toJson(row) {
  const site = { ...row };
  FLAGS.forEach((f) => { site[f] = row[f] === null || row[f] === undefined ? null : row[f] === 1; });
  return site;
}
