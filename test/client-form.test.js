import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanClientForm, MAIN_CONTACT } from '../src/client-form.js';
import { InvalidField } from '../src/sites.js';
import { Store } from '../src/store.js';
import { freshDatabase } from './pglite.js';

const FORM = {
  business: ' Acme Glass ',
  live_url: 'https://www.AcmeGlass.com/',
  contact: { name: 'Ana Lee', email: 'Ana@AcmeGlass.com', phone: '416 555 0100' },
  delegates: [
    { name: 'Bo Chan', email: 'bo@acmeglass.com', phone: '', position: 'Office manager' },
    { name: '', email: '', phone: '', position: '' },
  ],
  services: [
    { kind: 'godaddy', login: '1Password → Acme → GoDaddy' },
    { kind: 'backblaze_bucket', login: '' },
    { kind: '', login: '' },
  ],
  jobs: [
    { url: 'acmeglass.com', clone: true, database_b2: true, seo_ppc: false, live: false },
    { url: 'shop.acmeglass.com/store', clone: false, database_b2: false, seo_ppc: true, live: true },
    { url: '', clone: false },
  ],
  notify_rep: true,
  notify_client: false,
  competitor_analysis: true,
};

const fieldOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof InvalidField, e.message); return [e.field, e.message]; } assert.fail('should throw'); };

test('the form becomes a site, its contacts, services, jobs and options, empty rows dropped', () => {
  const out = cleanClientForm(FORM);
  assert.deepEqual(out.site, { name: 'Acme Glass', live_domain: 'www.acmeglass.com', needs_seo_ppc: 1 });
  assert.deepEqual(out.contacts, [
    { name: 'Ana Lee', email: 'Ana@AcmeGlass.com', phone: '416 555 0100', role: MAIN_CONTACT },
    { name: 'Bo Chan', email: 'bo@acmeglass.com', phone: null, role: 'Office manager' },
  ]);
  assert.deepEqual(out.services, [
    { kind: 'godaddy', account: '1Password → Acme → GoDaddy', password: null },
    { kind: 'backblaze_bucket', account: null, password: null },
  ]);
  assert.deepEqual(out.jobs, [
    { url: 'acmeglass.com', clone: 1, database_b2: 1, seo_ppc: 0, live: 0 },
    { url: 'shop.acmeglass.com/store', clone: 0, database_b2: 0, seo_ppc: 1, live: 1 },
  ]);
  assert.deepEqual(out.options, { notify_rep: 1, notify_client: 0, competitor_analysis: 1 });
});

test('with no job needing SEO / PPC, the site leaves that question unanswered', () => {
  const out = cleanClientForm({ ...FORM, jobs: [] });
  assert.equal('needs_seo_ppc' in out.site, false);
});

test('each error names the box on the form that is wrong', () => {
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, business: ' ' })), ['business', 'Business is required.']);
  assert.equal(fieldOf(() => cleanClientForm({ ...FORM, live_url: 'not a url' }))[0], 'live_url');
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, contact: { name: 'Ana' } })),
    ['contact.email', 'Contact: Email is required.']);
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, contact: { ...FORM.contact, email: 'ana at acme' } })),
    ['contact.email', 'Contact: Email is not an email address.']);
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, delegates: [{}, { position: 'Owner' }] })),
    ['delegates.1.name', 'Delegate 2: Name is required.']);
  assert.equal(fieldOf(() => cleanClientForm({ ...FORM, delegates: [{ name: 'Bo', position: 'x'.repeat(121) }] }))[0],
    'delegates.0.position');
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, services: [{ login: 'the office login' }] })),
    ['services.0.kind', 'Service 1: Kind is required.']);
  assert.equal(fieldOf(() => cleanClientForm({ ...FORM, services: [{ kind: 'myspace' }] }))[0], 'services.0.kind');
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, jobs: [{ clone: true }] })),
    ['jobs.0.url', 'Job 1: URL is required.']);
  assert.deepEqual(fieldOf(() => cleanClientForm({ ...FORM, jobs: [{ url: 'a.com' }, { url: 'https://A.com/' }] })),
    ['jobs.1.url', 'Job 2: That URL is already in the list.']);
  assert.equal(fieldOf(() => cleanClientForm({ ...FORM, jobs: 'a.com' }))[0], 'jobs');
  assert.equal(fieldOf(() => cleanClientForm({ ...FORM, delegates: Array(21).fill({ name: 'x' }) }))[0], 'delegates');
  assert.equal(fieldOf(() => cleanClientForm(null))[0], null);
});

test('login info that looks like a password is refused; where the login lives is fine', () => {
  for (const bad of ['password: hunter2', 'user acme / pw=abc123', 'Pass - letmein', 'PWD: x']) {
    assert.equal(fieldOf(() => cleanClientForm({ ...FORM, services: [{ kind: 'godaddy', login: bad }] }))[0], 'services.0.login', bad);
  }
  for (const ok of ['1Password → Acme → GoDaddy', 'info@acmeglass.com (the client’s own login)', 'Bitwarden, Acme vault']) {
    assert.equal(cleanClientForm({ ...FORM, services: [{ kind: 'godaddy', login: ok }] }).services[0].account, ok);
  }
});

async function desk() {
  const { db, connect } = await freshDatabase();
  return { db, store: new Store(connect) };
}

test('a sent form makes the site and everything under it, in one go', async () => {
  const { db, store } = await desk();
  const { site } = await store.createClient(cleanClientForm(FORM));
  assert.equal(site.id, '0001');
  assert.equal(site.name, 'Acme Glass');
  assert.equal(site.live_domain, 'www.acmeglass.com');
  assert.equal(site.needs_seo_ppc, true);
  const d = await store.details(site.id);
  assert.deepEqual(d.contacts.map((c) => [c.name, c.role]), [['Ana Lee', MAIN_CONTACT], ['Bo Chan', 'Office manager']]);
  assert.deepEqual(d.services.map((s) => [s.kind, s.account]), [['backblaze_bucket', null], ['godaddy', '1Password → Acme → GoDaddy']]);
  assert.deepEqual(d.jobs.map((j) => [j.id, j.url, j.clone, j.database_b2, j.seo_ppc, j.live]), [
    ['0001', 'acmeglass.com', true, true, false, false],
    ['0002', 'shop.acmeglass.com/store', false, false, true, true],
  ]);
  assert.deepEqual({ ...d.client_form, created_at: null, updated_at: null },
    { id: '0001', notify_rep: true, notify_client: false, competitor_analysis: true, created_at: null, updated_at: null });
  // Every row it made is in the history.
  const added = (await db.query("SELECT item FROM history WHERE action = 'added' ORDER BY id")).rows.map((r) => r.item);
  assert.deepEqual(added, ['site', 'contact', 'contact', 'service', 'service', 'job', 'job', 'client_form']);
  // A site added on the desk has no form.
  const other = await store.create({ name: 'Beta' });
  assert.equal((await store.details(other.id)).client_form, null);
});

test('a client already on the desk can send another form, which makes a site of its own', async () => {
  const { db, store } = await desk();
  const first = (await store.createClient(cleanClientForm(FORM))).site;
  const second = (await store.createClient(cleanClientForm(FORM))).site;
  assert.notEqual(second.id, first.id);
  assert.equal(second.name, first.name);
  const count = async (t) => (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  assert.equal(await count('sites'), 2);
  assert.equal(await count('client_forms'), 2);
  // Each site has its own contacts, services and jobs.
  assert.equal((await store.details(second.id)).contacts.length, 2);
  assert.equal((await store.details(first.id)).jobs.length, 2);
});

test('a form that fails part-way leaves nothing behind', async () => {
  const { db, store } = await desk();
  const form = cleanClientForm(FORM);
  form.jobs.push({ ...form.jobs[0] });   // past the cleaner: the table's own rule refuses it
  await assert.rejects(() => store.createClient(form));
  for (const t of ['sites', 'site_contacts', 'site_services', 'site_jobs', 'client_forms']) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, t);
  }
});

test('a job is edited and removed on the desk like any other detail', async () => {
  const { store } = await desk();
  const s = await store.create({ name: 'Acme' });
  const { item } = await store.createItem('jobs', s.id, { url: 'acme.com', clone: 1, database_b2: null, seo_ppc: 0, live: 0 });
  assert.equal(item.clone, true);
  assert.equal(item.database_b2, null);
  assert.deepEqual(await store.createItem('jobs', s.id, { url: 'acme.com' }), { duplicate: 'url' });
  const edited = await store.updateItem('jobs', s.id, item.id, { live: 1 }, item.updated_at);
  assert.equal(edited.item.live, true);
  assert.equal(await store.removeItem('jobs', s.id, item.id), true);
});
