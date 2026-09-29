import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formEmails, sendEmails, DEFAULT_FROM, DEFAULT_REP } from '../src/notify.js';
import { cleanClientForm } from '../src/client-form.js';

const INPUT = {
  business: 'North Shore Dental', live_url: 'northshore.ca',
  contact: { name: 'Mira Patel', email: 'mira@northshore.ca', phone: '416 555 0182' },
  delegates: [{ name: 'Dev Singh', email: 'dev@northshore.ca', position: 'Office manager' }],
  services: [{ kind: 'godaddy', login: 'mira@northshore.ca', password: 'hunter2' }],
  jobs: [{ url: 'northshore.ca', clone: true, database_b2: true }, { url: 'northshore.ca/book', seo_ppc: true }],
};
const SITE = { id: '0012', name: 'North Shore Dental' };
const opts = { deskUrl: 'https://website.10xid.com' };

test('no box ticked, no email', () => {
  assert.deepEqual(formEmails(cleanClientForm(INPUT), SITE, opts), []);
});

test('Notify rep sends the rep the whole form, with a link to the site and no password', () => {
  const [mail, ...rest] = formEmails(cleanClientForm({ ...INPUT, notify_rep: true }), SITE, opts);
  assert.equal(rest.length, 0);
  assert.equal(mail.who, 'rep');
  assert.equal(mail.from, DEFAULT_FROM);
  assert.equal(mail.to, DEFAULT_REP);
  assert.equal(mail.subject, 'Client form: North Shore Dental (site 0012)');
  for (const part of ['https://website.10xid.com/#site=0012', 'Name: Mira Patel', 'Phone: 416 555 0182',
    'Live website: northshore.ca', '- Dev Singh · Office manager · dev@northshore.ca',
    '- GoDaddy · login: mira@northshore.ca · password saved on the desk',
    '- northshore.ca: Clone, Database / Backblaze B2', '- northshore.ca/book: SEO / PPC',
    'Notify rep: yes', 'Notify client: no', 'Competitor analysis: no']) {
    assert.ok(mail.text.includes(part), part);
  }
  assert.ok(!mail.text.includes('hunter2'));
});

test('Notify client sends the main contact a short note, replies going to the rep', () => {
  const mails = formEmails(cleanClientForm({ ...INPUT, notify_client: true }), SITE, { ...opts, from: 'X <x@y.z>', rep: 'rep@y.z' });
  assert.equal(mails.length, 1);
  const [mail] = mails;
  assert.equal(mail.who, 'client');
  assert.equal(mail.to, 'mira@northshore.ca');
  assert.equal(mail.reply_to, 'rep@y.z');
  assert.equal(mail.from, 'X <x@y.z>');
  assert.equal(mail.subject, 'We have received your details for North Shore Dental');
  assert.ok(mail.text.startsWith('Hi Mira Patel,'));
  assert.ok(mail.text.includes('- northshore.ca/book: SEO / PPC'));
  for (const hidden of ['hunter2', 'GoDaddy', 'website.10xid.com', 'Dev Singh']) assert.ok(!mail.text.includes(hidden), hidden);
});

test('each email is sent on its own, and every result says whether it went', async () => {
  const mails = formEmails(cleanClientForm({ ...INPUT, notify_rep: true, notify_client: true }), SITE, opts);
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    if (calls.length === 1) return Response.json({ id: 'em_1' });
    return Response.json({ message: 'The 10xid.com domain is not verified.' }, { status: 403 });
  };
  const out = await sendEmails(mails, 're_test', fake);
  assert.deepEqual(out, [
    { who: 'rep', to: DEFAULT_REP, sent: true, id: 'em_1' },
    { who: 'client', to: 'mira@northshore.ca', sent: false, error: 'Resend answered 403: The 10xid.com domain is not verified.' },
  ]);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].auth, 'Bearer re_test');
  assert.equal('who' in calls[0].body, false);
  assert.equal(calls[1].body.reply_to, DEFAULT_REP);
});

test('with no API key nothing is sent, and a network error is reported, not thrown', async () => {
  const mails = formEmails(cleanClientForm({ ...INPUT, notify_rep: true }), SITE, opts);
  let called = false;
  const none = await sendEmails(mails, undefined, async () => { called = true; });
  assert.equal(called, false);
  assert.match(none[0].error, /not set up/);
  const down = await sendEmails(mails, 're_test', async () => { throw new Error('connect ECONNREFUSED'); });
  assert.deepEqual(down, [{ who: 'rep', to: DEFAULT_REP, sent: false, error: 'Could not reach Resend: connect ECONNREFUSED' }]);
});
