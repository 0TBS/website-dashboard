import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSite, normalizeAddress, normalizeRepo, normalizeChatUrl, toJson, InvalidField, COLUMNS } from '../src/sites.js';
import { ITEMS } from '../src/details.js';
import { MIGRATIONS, migrate } from '../src/schema.js';
import { freshDatabase } from './pglite.js';

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

const columnsOf = async (db, table) => (await db.query(
  'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]
)).rows.map((c) => c.column_name);

test('a fresh database has every column a site and its details are cleaned into', async () => {
  const { db } = await freshDatabase();
  const cols = await columnsOf(db, 'sites');
  for (const c of COLUMNS) assert.ok(cols.includes(c), c);
  for (const spec of Object.values(ITEMS)) {
    const have = await columnsOf(db, spec.table);
    for (const f of Object.keys(spec.fields)) assert.ok(have.includes(f), spec.table + '.' + f);
  }
});

test('the migrations run once each, and running them again changes nothing', async () => {
  const { db, connect } = await freshDatabase();
  await db.query("INSERT INTO sites (id, name, created_at, updated_at) VALUES ('a', 'Acme', 't', 't')");
  assert.equal(await migrate(connect), MIGRATIONS.length);
  const done = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  assert.deepEqual(done, MIGRATIONS.map((_, i) => i + 1));
  assert.equal((await db.query('SELECT name FROM sites')).rows[0].name, 'Acme');
});

test('the database refuses a flag or platform the desk would never write', async () => {
  const { db } = await freshDatabase();
  await assert.rejects(db.query("INSERT INTO sites (id, name, astro_staging, created_at, updated_at) VALUES ('a', 'A', 2, 't', 't')"));
  await assert.rejects(db.query("INSERT INTO sites (id, name, live_platform, created_at, updated_at) VALUES ('a', 'A', 'wix', 't', 't')"));
});
