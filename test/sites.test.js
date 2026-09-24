import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSite, normalizeAddress, normalizeRepo, toJson, InvalidField } from '../src/sites.js';

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
