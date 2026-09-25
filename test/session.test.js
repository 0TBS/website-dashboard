import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToken, cookieValues, sessionCookie, clearCookie, COOKIE, MAX_AGE } from '../src/session.js';

test('the login cookie holds a value made from the key, never the key itself', async () => {
  const key = 'example-desk-key';
  const a = await sessionToken(key);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await sessionToken(key), a, 'the same key always gives the same value');
  assert.notEqual(await sessionToken(key + 'x'), a, 'a new key logs everyone out');
  assert.ok(!a.includes(key));
});

test('every cookie under the name is read, so a stray one cannot lock anyone out', () => {
  assert.deepEqual(cookieValues(null), []);
  assert.deepEqual(cookieValues('theme=dark'), []);
  assert.deepEqual(cookieValues(`${COOKIE}=abc`), ['abc']);
  assert.deepEqual(cookieValues(`a=1; ${COOKIE}=bad;${COOKIE}=good ; b=2`), ['bad', 'good']);
  assert.deepEqual(cookieValues(`x${COOKIE}=nope`), []);
});

test('the cookie is out of reach of scripts and other sites, and lasts 400 days', () => {
  const c = sessionCookie('abc', true);
  assert.equal(MAX_AGE, 34560000);
  for (const part of [`${COOKIE}=abc`, 'Path=/', 'Max-Age=34560000', 'HttpOnly', 'SameSite=Strict', 'Secure']) {
    assert.ok(c.split('; ').includes(part), part);
  }
  assert.ok(!c.includes('Domain='), 'kept to this one host');
  assert.ok(!sessionCookie('abc', false).includes('Secure'), 'plain-HTTP wrangler dev cannot keep a Secure cookie');
});

test('Log off clears the cookie at once', () => {
  const c = clearCookie(true);
  assert.ok(c.startsWith(`${COOKIE}=;`));
  assert.ok(c.includes('Max-Age=0'));
});
