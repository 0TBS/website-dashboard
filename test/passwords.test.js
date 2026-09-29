import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPassword, decryptPassword, cleanPassword, SecretsNotSetUp } from '../src/secrets.js';
import { cleanClientForm } from '../src/client-form.js';
import { Store } from '../src/store.js';
import { freshDatabase } from './pglite.js';

// 32 bytes of base64, as `openssl rand -base64 32` gives.
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER = Buffer.alloc(32, 9).toString('base64');

test('a password comes back exactly as typed, and is never stored as itself', async () => {
  for (const pw of ['hunter2', '  spaces around  ', 'ünïcødé 🔑', 'x'.repeat(500)]) {
    const stored = await encryptPassword(KEY, pw);
    assert.match(stored, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.ok(!stored.includes(pw.trim() || 'x'));
    assert.equal(await decryptPassword(KEY, stored), pw);
  }
  // A fresh IV each time: the same password never looks the same twice.
  assert.notEqual(await encryptPassword(KEY, 'same'), await encryptPassword(KEY, 'same'));
});

test('no key, a bad key or the wrong key refuses rather than guessing', async () => {
  await assert.rejects(() => encryptPassword(undefined, 'x'), SecretsNotSetUp);
  await assert.rejects(() => encryptPassword('', 'x'), SecretsNotSetUp);
  await assert.rejects(() => encryptPassword('too-short', 'x'), /32 random bytes/);
  const stored = await encryptPassword(KEY, 'secret');
  await assert.rejects(() => decryptPassword(OTHER, stored), /not the key it was saved with/);
  await assert.rejects(() => decryptPassword(KEY, stored.replace(/.$/, stored.endsWith('A') ? 'B' : 'A')), /could not be decrypted/);
  await assert.rejects(() => decryptPassword(KEY, 'plain text'), /not in a form/);
});

test('a password is kept as typed, empty is none, and it has a limit', () => {
  assert.equal(cleanPassword(' a b '), ' a b ');
  assert.equal(cleanPassword(''), null);
  assert.equal(cleanPassword(null), null);
  assert.throws(() => cleanPassword('x'.repeat(501)), /longer than 500/);
  assert.throws(() => cleanPassword(12345), /should be text/);
});

test('the form takes a password per service, and still refuses one typed as login info', () => {
  const base = { business: 'Acme', contact: { name: 'Ana', email: 'ana@acme.com' } };
  assert.throws(() => cleanClientForm({ ...base, services: [{ password: 'orphan' }] }), /Service 1: Kind is required/);
  const ok = cleanClientForm({ ...base, services: [{ kind: 'godaddy', login: 'ana@acme.com', password: 'hunter2' }] });
  assert.deepEqual(ok.services, [{ kind: 'godaddy', account: 'ana@acme.com', password: 'hunter2' }]);
  assert.throws(() => cleanClientForm({ ...base, services: [{ kind: 'godaddy', login: 'password: hunter2' }] }),
    /Put the password in the Password box/);
});

async function desk() {
  const { db, connect } = await freshDatabase();
  return { db, store: new Store(connect) };
}

test('a service keeps its password encrypted, says only that it has one, and the history never holds it', async () => {
  const { db, store } = await desk();
  const site = await store.create({ name: 'Acme' });
  const cipher = await encryptPassword(KEY, 'hunter2');
  const { item } = await store.createItem('services', site.id, { kind: 'godaddy', account: 'ana@acme.com' }, { password: cipher });
  assert.equal(item.has_password, true);
  assert.equal('password' in item || 'ciphertext' in item, false);
  const read = await store.readPassword(site.id, item.id);
  assert.equal(await decryptPassword(KEY, read.ciphertext), 'hunter2');

  // Changed, then removed: each is a history line that names the field, never the value.
  const changed = await store.updateItem('services', site.id, item.id, {}, item.updated_at, { password: await encryptPassword(KEY, 'n3w') });
  assert.notEqual(changed.item.updated_at, item.updated_at);
  assert.equal(await decryptPassword(KEY, (await store.readPassword(site.id, item.id)).ciphertext), 'n3w');
  await store.updateItem('services', site.id, item.id, {}, null, { password: null });
  assert.deepEqual(await store.readPassword(site.id, item.id), { none: true });
  assert.equal((await store.details(site.id)).services[0].has_password, false);
  const lines = (await db.query("SELECT field, old_value, new_value FROM history WHERE field = 'password' ORDER BY id")).rows;
  assert.deepEqual(lines, [
    { field: 'password', old_value: null, new_value: '(hidden)' },
    { field: 'password', old_value: '(hidden)', new_value: '(hidden)' },
    { field: 'password', old_value: '(hidden)', new_value: null },
  ]);
  const all = JSON.stringify((await db.query('SELECT * FROM history')).rows);
  assert.ok(!all.includes('hunter2') && !all.includes('n3w') && !all.includes('v1:'), 'no password or ciphertext in the history');

  // Removing a password that is not there changes nothing.
  const before = (await db.query('SELECT count(*)::int AS n FROM history')).rows[0].n;
  assert.equal((await store.updateItem('services', site.id, item.id, {}, null, { password: null })).item.has_password, false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM history')).rows[0].n, before);
});

test('a stale edit to a password is refused like any other, and a password goes with its service', async () => {
  const { db, store } = await desk();
  const site = await store.create({ name: 'Acme' });
  const { item } = await store.createItem('services', site.id, { kind: 'godaddy' }, { password: await encryptPassword(KEY, 'a') });
  await store.updateItem('services', site.id, item.id, { notes: 'teammate' }, item.updated_at);
  const stale = await store.updateItem('services', site.id, item.id, {}, item.updated_at, { password: await encryptPassword(KEY, 'b') });
  assert.equal(stale.conflict, true);
  assert.equal(await decryptPassword(KEY, (await store.readPassword(site.id, item.id)).ciphertext), 'a');
  assert.deepEqual(await store.readPassword(site.id, '9999'), { missing: true });
  await store.removeItem('services', site.id, item.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM service_passwords')).rows[0].n, 0);
});

test('a client form saves each service password encrypted, in the same transaction', async () => {
  const { db, store } = await desk();
  const form = cleanClientForm({ business: 'Acme', contact: { name: 'Ana', email: 'ana@acme.com' },
    services: [{ kind: 'godaddy', login: 'ana@acme.com', password: 'hunter2' }, { kind: 'backblaze_bucket' }] });
  for (const s of form.services) s.password = s.password && await encryptPassword(KEY, s.password);
  const { site } = await store.createClient(form);
  const services = (await store.details(site.id)).services;
  assert.deepEqual(services.map((s) => [s.kind, s.has_password]), [['backblaze_bucket', false], ['godaddy', true]]);
  const godaddy = services.find((s) => s.kind === 'godaddy');
  assert.equal(await decryptPassword(KEY, (await store.readPassword(site.id, godaddy.id)).ciphertext), 'hunter2');
  const raw = JSON.stringify((await db.query('SELECT * FROM service_passwords')).rows);
  assert.ok(!raw.includes('hunter2'));
});
