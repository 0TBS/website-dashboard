// The client form's emails, sent through Resend once the form is saved:
//   Notify rep     a summary of the form to the rep (FORM_EMAIL_REP)
//   Notify client  a short note to the main contact that their details are in
// Both come from FORM_EMAIL_FROM, as plain text. Never a password: a service
// with one says only that it is saved on the desk.
//
// Sending happens after the save, so an email that fails never loses the
// form: the answer says which emails went and which did not. With no
// RESEND_API_KEY on the Worker, nothing is sent and each email says so.
//
// Kept apart from worker.js so it can be tested under plain Node.

import { JOB_TASKS, SERVICE_KINDS } from './details.js';

export const DEFAULT_FROM = '10XiD <noreply@brandingcentres.com>';
export const DEFAULT_REP = 'paolo@tboxstudio.com';
const RESEND = 'https://api.resend.com/emails';

const label = (list, v) => (list.find(([k]) => k === v) || [v, v])[1];
const line = (name, v) => (v ? `${name}: ${v}` : null);
const lines = (...xs) => xs.filter((x) => x != null).join('\n');

function jobsText(jobs) {
  return jobs.map((j) => {
    const work = JOB_TASKS.filter(([t]) => j[t] === 1).map(([, l]) => l);
    return `- ${j.url}${work.length ? ': ' + work.join(', ') : ''}`;
  }).join('\n');
}

// The emails the form asks for. `form` is the cleaned form (client-form.js),
// `site` the saved site, `deskUrl` the desk's own address.
// → [{ who: 'rep' | 'client', to, subject, text, reply_to? }]
export function formEmails(form, site, { deskUrl, from = DEFAULT_FROM, rep = DEFAULT_REP } = {}) {
  const out = [];
  const [contact, ...delegates] = form.contacts;
  const business = form.site.name;
  if (form.options.notify_rep) {
    const text = lines(
      `A client form was saved for ${business}. It is on the desk as site ${site.id}:`,
      `${deskUrl}/#site=${encodeURIComponent(site.id)}`,
      '',
      'CONTACT',
      line('Name', contact.name), line('Email', contact.email), line('Phone', contact.phone), line('Business', business),
      line('Live website', form.site.live_domain),
      ...(delegates.length ? ['', 'DELEGATES', ...delegates.map((d) =>
        '- ' + [d.name, d.role, d.email, d.phone].filter(Boolean).join(' · '))] : []),
      ...(form.services.length ? ['', 'SERVICES & ACCOUNTS', ...form.services.map((s) =>
        '- ' + [label(SERVICE_KINDS, s.kind), s.account && `login: ${s.account}`, s.password && 'password saved on the desk']
          .filter(Boolean).join(' · '))] : []),
      ...(form.jobs.length ? ['', 'JOB INFO', jobsText(form.jobs)] : []),
      '',
      'OPTIONS',
      `Notify rep: ${form.options.notify_rep ? 'yes' : 'no'}`,
      `Notify client: ${form.options.notify_client ? 'yes' : 'no'}`,
      `Competitor analysis: ${form.options.competitor_analysis ? 'yes' : 'no'}`,
    );
    out.push({ who: 'rep', from, to: rep, subject: `Client form: ${business} (site ${site.id})`, text });
  }
  if (form.options.notify_client && contact.email) {
    const text = lines(
      `Hi ${contact.name},`,
      '',
      `Thank you. We have received your details for ${business}.`,
      ...(form.jobs.length ? ['', 'Here is what we have down to work on:', jobsText(form.jobs)] : []),
      '',
      'We will be in touch soon. If anything needs changing, reply to this email.',
      '',
      '10XiD',
    );
    out.push({ who: 'client', from, to: contact.email, reply_to: rep, subject: `We have received your details for ${business}`, text });
  }
  return out;
}

// Sends each one on its own, so one that fails does not stop the other.
// → [{ who, to, sent: true, id } | { who, to, sent: false, error }]
export async function sendEmails(emails, apiKey, fetchImpl = fetch) {
  const results = [];
  for (const { who, ...email } of emails) {
    if (!apiKey) {
      results.push({ who, to: email.to, sent: false, error: 'Email is not set up on the desk yet (RESEND_API_KEY).' });
      continue;
    }
    try {
      const res = await fetchImpl(RESEND, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(email),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.id) results.push({ who, to: email.to, sent: true, id: data.id });
      else results.push({ who, to: email.to, sent: false, error: `Resend answered ${res.status}${data.message ? ': ' + data.message : ''}` });
    } catch (e) {
      results.push({ who, to: email.to, sent: false, error: 'Could not reach Resend: ' + (e?.message || e) });
    }
  }
  return results;
}
