import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSite, normalizeAddress, normalizeRepo, normalizeChatUrl, toJson, InvalidField, ensureSitesSchema, COLUMNS } from '../src/sites.js';
import { sqliteStorage } from './sqlite-adapter.js';

test('addresses lose scheme, trailing slash and host case, keep a path', () => {
  assert.equal(normalizeAddress('https://WWW.Example.com/'), 'www.example.com');
  assert.equal(normalizeAddress('http://example.ca'), 'example.ca');
  assert.equal(normalizeAddress('preview.10xid.com/id/Bolde/'), 'preview.10xid.com/id/Bolde');
  assert.equal(normalizeAddress('site.workers.dev:8787'), 'site.workers.dev:8787');
  assert.equal(normalizeAddress('  '), null);
  assert.equal(normalizeAddress(null), null);
  assert.throws(() => normalizeAddress('not a domain'));
  assert.throws(() => normalizeAddress('localhost'));
  assert.throws(() => normalizeAddress('example.com/has space'));
});

test('repos come back as owner/repo whatever form they arrive in', () => {
  assert.equal(normalizeRepo('0TBS/website-dashboard'), '0TBS/website-dashboard');
  assert.equal(normalizeRepo('https://github.com/0TBS/website-dashboard'), '0TBS/website-dashboard');
  assert.equal(normalizeRepo('https://github.com/0TBS/website-dashboard.git'), '0TBS/website-dashboard');
  assert.equal(normalizeRepo('git@github.com:0TBS/site.ca.git'), '0TBS/site.ca');
  assert.equal(normalizeRepo(''), null);
  assert.throws(() => normalizeRepo('just-a-name'));
  assert.throws(() => normalizeRepo('https://gitlab.com/a/b'));
});

test('a new site needs a name; everything else may be left not set', () => {
  assert.throws(() => cleanSite({}, { creating: true }), InvalidField);
  assert.throws(() => cleanSite({ name: '   ' }, { creating: true }), /Client name is required/);
  assert.deepEqual(cleanSite({ name: ' Acme ' }, { creating: true }), { name: 'Acme' });
});

test('flags take yes, no or not set, and nothing else', () => {
  const out = cleanSite({ astro_staging: true, domain_ours: false, needs_seo_ppc: null });
  assert.deepEqual(out, { astro_staging: 1, domain_ours: 0, needs_seo_ppc: null });
  assert.throws(() => cleanSite({ domain_ours: 'maybe' }), /Domain must be yes, no or not set/);
});

test('platform is one of the four, or not set', () => {
  assert.equal(cleanSite({ live_platform: 'wordpress' }).live_platform, 'wordpress');
  assert.equal(cleanSite({ live_platform: '' }).live_platform, null);
  assert.throws(() => cleanSite({ live_platform: 'wix' }), (e) => e.field === 'live_platform');
});

test('a patch touches only the fields it sends', () => {
  assert.deepEqual(cleanSite({ needs_seo_ppc: true }), { needs_seo_ppc: 1 });
  assert.deepEqual(cleanSite({ id: 'x', created_at: 'y', rogue: 1 }), {});
});

test('the error names the field that failed', () => {
  try { cleanSite({ github_repo: 'nope' }); assert.fail('should throw'); } catch (e) {
    assert.equal(e.field, 'github_repo');
    assert.match(e.message, /GitHub repo should look like owner\/repo/);
  }
});

test('stored 0/1/NULL flags reach the page as false/true/null', () => {
  const s = toJson({ id: 'a', name: 'A', astro_staging: 1, domain_ours: 0, needs_seo_ppc: null });
  assert.equal(s.astro_staging, true);
  assert.equal(s.domain_ours, false);
  assert.equal(s.needs_seo_ppc, null);
});

test('a chat link is kept only when it is a claude.ai link', () => {
  assert.equal(normalizeChatUrl('https://claude.ai/code/session_01Abc'), 'https://claude.ai/code/session_01Abc');
  assert.equal(normalizeChatUrl('claude.ai/code/session_01Abc/'), 'https://claude.ai/code/session_01Abc');
  assert.equal(normalizeChatUrl('https://www.claude.ai/chat/abc?x=1'), 'https://claude.ai/chat/abc?x=1');
  assert.equal(normalizeChatUrl('  '), null);
  assert.equal(normalizeChatUrl(null), null);
  for (const bad of ['http://claude.ai/code/x', 'https://claude.ai.evil.com/x', 'https://evil.com/claude.ai',
    'javascript:alert(1)', 'https://user@claude.ai/x', 'https://claude.ai:8443/x', 'not a link at all']) {
    assert.throws(() => normalizeChatUrl(bad), undefined, bad);
  }
  try { cleanSite({ chat_url: 'https://example.com' }); assert.fail('should throw'); } catch (e) {
    assert.equal(e.field, 'chat_url');
    assert.match(e.message, /Chat link should be a claude.ai link/);
  }
});

test('an environment is one short line', () => {
  assert.equal(cleanSite({ environment: '  backblaze/CF \n ' }).environment, 'backblaze/CF');
  assert.equal(cleanSite({ environment: 'a\nb' }).environment, 'a b');
  assert.equal(cleanSite({ environment: '' }).environment, null);
  assert.throws(() => cleanSite({ environment: 'x'.repeat(81) }), (e) => e.field === 'environment');
});

test('the sites table gains chat_url and environment in place, keeping every row', () => {
  const { sql } = sqliteStorage();
  // The table as the live desk made it before these two fields existed.
  sql.exec(`CREATE TABLE sites (id TEXT PRIMARY KEY, name TEXT NOT NULL, live_domain TEXT, staging_domain TEXT,
    github_repo TEXT, live_platform TEXT, astro_staging INTEGER, domain_ours INTEGER, needs_seo_ppc INTEGER,
    notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  sql.exec("INSERT INTO sites (id, name, created_at, updated_at) VALUES ('a', 'Acme', 't', 't')");
  ensureSitesSchema(sql);
  ensureSitesSchema(sql);   // a second start changes nothing
  const cols = sql.exec('PRAGMA table_info(sites)').toArray().map((c) => c.name);
  for (const c of COLUMNS) assert.ok(cols.includes(c), c);
  const row = sql.exec('SELECT * FROM sites').toArray()[0];
  assert.equal(row.name, 'Acme');
  assert.equal(row.chat_url, null);
  assert.equal(row.environment, null);
});

test('a fresh desk gets every column at once', () => {
  const { sql } = sqliteStorage();
  ensureSitesSchema(sql);
  const cols = sql.exec('PRAGMA table_info(sites)').toArray().map((c) => c.name);
  for (const c of COLUMNS) assert.ok(cols.includes(c), c);
});
