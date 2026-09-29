import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanItem, itemJson, normalizeUrl, normalizeEmail, normalizePhone, normalizeHostname, normalizeDate, normalizeHandle,
  SERVICE_KINDS, DOMAIN_ROLES, SOCIAL_PLATFORMS, KINDS, CHOICES,
} from '../src/details.js';
import { InvalidField } from '../src/sites.js';

test('each kind of detail needs its required fields when it is added', () => {
  assert.throws(() => cleanItem('services', {}, { creating: true }), /Kind is required/);
  assert.throws(() => cleanItem('contacts', { role: 'Owner' }, { creating: true }), /Name is required/);
  assert.throws(() => cleanItem('domains', { hostname: 'acme.com' }, { creating: true }), /Used as is required/);
  assert.deepEqual(cleanItem('contacts', { name: ' Ana ' }, { creating: true }), { name: 'Ana' });
});

test('an edit touches only the fields it sends, and cannot blank a required one', () => {
  assert.deepEqual(cleanItem('services', { notes: 'x', id: 'y', site_id: 'z', rogue: 1 }), { notes: 'x' });
  assert.throws(() => cleanItem('contacts', { name: '' }), (e) => e instanceof InvalidField && e.field === 'name');
});

test('a service kind and a domain role come from their lists', () => {
  for (const [v] of SERVICE_KINDS) assert.equal(cleanItem('services', { kind: v }).kind, v);
  for (const [v] of DOMAIN_ROLES) assert.equal(cleanItem('domains', { role: v }).role, v);
  assert.throws(() => cleanItem('services', { kind: 'myspace' }), (e) => e.field === 'kind');
  assert.throws(() => cleanItem('domains', { role: 'main' }), (e) => e.field === 'role');
});

test('links are kept as full http(s) links, and nothing else', () => {
  assert.equal(normalizeUrl('dash.cloudflare.com/abc'), 'https://dash.cloudflare.com/abc');
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeUrl(' '), null);
  for (const bad of ['javascript:alert(1)', 'ftp://x.com/a', 'https://user:pw@x.com/', 'not a link', 'https://localhost/']) {
    assert.throws(() => normalizeUrl(bad), undefined, bad);
  }
});

test('emails and phone numbers are checked loosely', () => {
  assert.equal(normalizeEmail(' Ana@Acme.com '), 'Ana@Acme.com');
  assert.throws(() => normalizeEmail('ana at acme'));
  assert.equal(normalizePhone('+1 (416)  555-0100 ext 12'), '+1 (416) 555-0100 ext 12');
  assert.throws(() => normalizePhone('call me'));
  assert.throws(() => normalizePhone('12'));
});

test('a domain is a hostname alone, cleaned like the other addresses', () => {
  assert.equal(normalizeHostname('https://IMG.Acme.com/'), 'img.acme.com');
  assert.throws(() => normalizeHostname('acme.com/blog'), /without a path/);
  assert.throws(() => normalizeHostname('not a domain'));
});

test('a renewal date is a real day, written YYYY-MM-DD', () => {
  assert.equal(normalizeDate('2027-03-31'), '2027-03-31');
  assert.equal(normalizeDate(''), null);
  for (const bad of ['2027-02-30', '2027-3-1', '31/03/2027', 'soon']) assert.throws(() => normalizeDate(bad), undefined, bad);
});

test('DNS on Cloudflare is yes, no or not set, stored 0/1/NULL', () => {
  assert.equal(cleanItem('domains', { dns_on_cloudflare: true }).dns_on_cloudflare, 1);
  assert.equal(cleanItem('domains', { dns_on_cloudflare: null }).dns_on_cloudflare, null);
  assert.throws(() => cleanItem('domains', { dns_on_cloudflare: 'maybe' }), /DNS on Cloudflare must be yes, no or not set/);
  assert.equal(itemJson('domains', { dns_on_cloudflare: 0 }).dns_on_cloudflare, false);
  assert.equal(itemJson('domains', { dns_on_cloudflare: null }).dns_on_cloudflare, null);
});

test('the error names the field and says what is wrong in plain words', () => {
  try { cleanItem('services', { url: 'nope' }); assert.fail('should throw'); } catch (e) {
    assert.equal(e.field, 'url');
    assert.equal(e.message, 'Link is not a link.');
  }
  assert.deepEqual(KINDS, ['services', 'contacts', 'domains', 'tiktok', 'linkedin', 'facebook', 'x', 'instagram']);
});

test('each social platform takes only its own profile links, kept as https', () => {
  const ok = {
    tiktok: 'tiktok.com/@acme', linkedin: 'https://www.linkedin.com/company/acme/', facebook: 'http://m.facebook.com/acme',
    x: 'twitter.com/acme', instagram: 'instagram.com/acme',
  };
  for (const [platform, url] of Object.entries(ok)) {
    assert.match(cleanItem(platform, { url }, { creating: true }).url, /^https:\/\//, platform);
  }
  assert.equal(cleanItem('x', { url: 'x.com/acme' }).url, 'https://x.com/acme');
  assert.equal(cleanItem('facebook', { url: 'fb.me/acme' }).url, 'https://fb.me/acme');
  for (const [platform, bad] of [['tiktok', 'instagram.com/acme'], ['x', 'notx.com/acme'], ['linkedin', 'linkedin.com.evil.io/a'],
    ['instagram', 'javascript:alert(1)']]) {
    assert.throws(() => cleanItem(platform, { url: bad }), (e) => e.field === 'url', platform + ' ' + bad);
  }
  assert.throws(() => cleanItem('tiktok', { url: 'instagram.com/a' }), /Link should be a TikTok link, on tiktok.com/);
});

test('a social link is required, a handle loses its @', () => {
  assert.throws(() => cleanItem('instagram', { handle: 'acme' }, { creating: true }), /Link is required/);
  assert.equal(normalizeHandle(' @@acme.ca '), 'acme.ca');
  assert.equal(normalizeHandle(''), null);
  assert.throws(() => normalizeHandle('acme glass'), /one word/);
  assert.throws(() => normalizeHandle('@'), /one word/);
});

test('the page is told the platforms, in order', () => {
  assert.deepEqual(CHOICES.social_platforms, SOCIAL_PLATFORMS.map(([v, l]) => [v, l]));
  assert.deepEqual(CHOICES.social_platforms.map(([, l]) => l), ['TikTok', 'LinkedIn', 'Facebook', 'X', 'Instagram']);
});
