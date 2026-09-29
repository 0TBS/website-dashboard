// The client form (public/client-form.html): one submission that makes a new
// site with its contact, associates, service accounts and job list, all at
// once. This is the one place that says what the form may hold; each part is
// cleaned by the same rules the desk uses for it (sites.js, details.js), so a
// contact from the form is the same as a contact added on the desk.
//
// Errors name the form's own field, as a path: `business`, `live_url`,
// `contact.email`, `associates.1.position`, `services.0.kind`, `jobs.2.url`,
// so the page can mark the box that is wrong.
//
// Never a password, here as anywhere on the desk: "login info" says where the
// login lives, and a line that looks like a password is refused.

import { InvalidField, normalizeAddress, normalizeText } from './sites.js';
import { cleanItem, JOB_TASKS, normalizeEmail } from './details.js';

// The ticks beside the job list. Recorded with the site (client_forms); the
// desk does not send any email yet.
export const OPTIONS = [
  ['notify_rep', 'Notify rep (me)'],
  ['notify_client', 'Notify client'],
  ['competitor_analysis', 'Competitor analysis'],
];

export const LIMITS = { associates: 20, services: 30, jobs: 50 };

// The main contact's role on the desk, beside the associates' job positions.
export const MAIN_CONTACT = 'Main contact';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const blank = (v) => v == null || (typeof v === 'string' && !v.trim()) || v === false;

// "password: hunter2", "pw = …", "pass - …": the shape of a password written
// down. Where the login lives ("1Password → Acme → GoDaddy") passes.
const PASSWORD = /\b(password|passwd|passcode|pass|pwd|pw)\b\s*[:=\-]/i;

// Runs one part's cleaner and renames its error to the form's own field.
function part(path, label, fields, fn) {
  try { return fn(); } catch (e) {
    if (!(e instanceof InvalidField)) throw e;
    const name = fields[e.field] ?? e.field;
    throw new InvalidField(name ? path + name : null, (label ? label + ': ' : '') + e.message);
  }
}

function list(input, key, what) {
  const v = input[key];
  if (v == null) return [];
  if (!Array.isArray(v)) throw new InvalidField(key, `${what} should be a list.`);
  if (v.length > LIMITS[key]) throw new InvalidField(key, `At most ${LIMITS[key]} ${what.toLowerCase()} fit on one form.`);
  return v.map((row) => (isObject(row) ? row : {}));
}

function flag(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on' ? 1 : 0;
}

// → { site, contacts, services, jobs, options }, every part ready for the
// store. Rows left completely empty are dropped, as a person leaves a spare
// row on paper.
export function cleanClientForm(input) {
  if (!isObject(input)) throw new InvalidField(null, 'Expected a JSON object.');

  const site = {};
  try { site.name = normalizeText(input.business, 120); } catch (e) {
    throw new InvalidField('business', 'Business ' + e.message + '.');
  }
  if (!site.name) throw new InvalidField('business', 'Business is required.');
  try { site.live_domain = normalizeAddress(input.live_url); } catch (e) {
    throw new InvalidField('live_url', 'Live website URL ' + e.message + '.');
  }

  const c = isObject(input.contact) ? input.contact : {};
  const contact = part('contact.', 'Contact', {}, () =>
    cleanItem('contacts', { name: c.name, email: c.email, phone: c.phone }, { creating: true }));
  if (!contact.email) throw new InvalidField('contact.email', 'Contact: Email is required.');
  contact.role = MAIN_CONTACT;

  const associates = [];
  list(input, 'associates', 'Associates').forEach((a, i) => {
    if (['name', 'email', 'phone', 'position'].every((k) => blank(a[k]))) return;
    associates.push(part(`associates.${i}.`, `Associate ${i + 1}`, { role: 'position' }, () =>
      cleanItem('contacts', { name: a.name, email: a.email, phone: a.phone, role: a.position }, { creating: true })));
  });

  const services = [];
  list(input, 'services', 'Services').forEach((s, i) => {
    if (blank(s.kind) && blank(s.login)) return;
    const out = part(`services.${i}.`, `Service ${i + 1}`, { account: 'login' }, () =>
      cleanItem('services', { kind: s.kind || null, account: s.login }, { creating: true }));
    if (out.account && PASSWORD.test(out.account)) {
      throw new InvalidField(`services.${i}.login`,
        `Service ${i + 1}: Login info looks like a password. Never put a password on the desk: say where the login lives, such as "1Password → Acme → GoDaddy".`);
    }
    services.push(out);
  });

  const jobs = [];
  const seen = new Set();
  list(input, 'jobs', 'Jobs').forEach((j, i) => {
    if (blank(j.url) && JOB_TASKS.every(([t]) => !flag(j[t]))) return;
    const row = { url: j.url };
    for (const [t] of JOB_TASKS) row[t] = flag(j[t]);
    const out = part(`jobs.${i}.`, `Job ${i + 1}`, {}, () => cleanItem('jobs', row, { creating: true }));
    if (seen.has(out.url)) throw new InvalidField(`jobs.${i}.url`, `Job ${i + 1}: That URL is already in the list.`);
    seen.add(out.url);
    jobs.push(out);
  });

  const options = Object.fromEntries(OPTIONS.map(([k]) => [k, flag(input[k])]));
  // A job that needs SEO / PPC answers the site's own question.
  if (jobs.some((j) => j.seo_ppc === 1)) site.needs_seo_ppc = 1;

  return { site, contacts: [contact, ...associates], services, jobs, options };
}

// What the duplicate check compares: the live site's host without its
// www., and the contact's email in lower case.
export function hostOf(address) {
  return address ? address.split('/')[0].replace(/:\d+$/, '').replace(/^www\./, '') : null;
}

// The query for GET /api/client-form/check, cleaned the same way. A value
// that is not valid yet is not checked: the form says what is wrong with it
// when it is sent.
export function cleanCheck(params) {
  const tryIt = (fn) => { try { return fn(); } catch { return null; } };
  return {
    name: tryIt(() => normalizeText(params.get('business'), 120)),
    host: hostOf(tryIt(() => normalizeAddress(params.get('live_url')))),
    email: tryIt(() => normalizeEmail(params.get('email')))?.toLowerCase() ?? null,
  };
}
