// The client form. Everything is sent in one POST to /api/client-form, which
// makes the site and all it holds in one go, or nothing (src/client-form.js
// says what each box may hold). Every form makes a new site, even for a
// client already on the desk: a client can come back for something new.
//
// The desk's login cookie is the key here too; with none, the page asks for
// the desk key the way the desk does.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('cf');
  const note = $('cf-note');
  const errEl = $('cf-err');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Sent by the Worker with GET /api/client-form, so the lists never drift.
  let choices = { service_kinds: [], job_tasks: [], options: [], limits: {} };
  // The three kinds of row: what each is called, and its boxes.
  const ROWS = {
    delegates: {
      what: 'Delegate', list: $('cf-delegates'),
      html: () => `<div class="edgrid">
        ${text('name', 'Name', 120)}${text('email', 'Email', 120, 'type="email" inputmode="email" spellcheck="false"')}
        ${text('phone', 'Phone number', 40, 'type="tel" inputmode="tel"')}${text('position', 'Job position', 120)}</div>`,
    },
    services: {
      what: 'Service', list: $('cf-services'),
      html: () => `<div class="edgrid">
        <label class="field"><span>Service</span><select data-k="kind"><option value="">Choose one</option>
          ${choices.service_kinds.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>
        ${text('login', 'Login info', 120, 'placeholder="Where the login lives, never the password" spellcheck="false"')}</div>`,
    },
    jobs: {
      what: 'URL', list: $('cf-jobs'),
      html: () => `${text('url', 'URL', 300, 'placeholder="clientsite.com/page" inputmode="url" spellcheck="false"')}
        <div class="cfticks">${choices.job_tasks.map(([v, l]) => tick(v, l)).join('')}</div>`,
    },
  };
  function text(k, label, max, extra = '') {
    return `<label class="field"><span>${esc(label)}</span><input data-k="${k}" maxlength="${max}" autocomplete="off" ${extra}></label>`;
  }
  function tick(k, label) {
    return `<label class="cftick"><input type="checkbox" data-k="${esc(k)}"><span>${esc(label)}</span></label>`;
  }

  // ---- the API, as the desk calls it ----
  class Locked extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  async function api(method, path, body) {
    const opts = { method, headers: { 'x-desk': '1' } };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch(path, opts); } catch {
      throw new Error('Could not reach the desk. Check the connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Locked(data.error || 'Wrong or missing desk key.', data.code);
    if (!res.ok) {
      const e = new Error(data.error || 'The desk answered ' + res.status + '.');
      Object.assign(e, { field: data.field, code: data.code, site: data.site, status: res.status });
      throw e;
    }
    return data;
  }

  // ---- rows ----
  function addRow(kind, focus) {
    const spec = ROWS[kind];
    const max = choices.limits[kind];
    if (max && spec.list.children.length >= max) {
      showErr(`At most ${max} ${kind} fit on one form.`);
      return;
    }
    const li = document.createElement('li');
    li.className = 'cfrow';
    li.innerHTML = `<div class="cfrowh"><p class="sect" data-title></p>
      <button class="btn danger" type="button" data-remove>Remove<span class="sr" data-sr></span></button></div>${spec.html()}`;
    spec.list.append(li);
    renumber(kind);
    if (focus) li.querySelector('input,select').focus();
    return li;
  }
  // Each box is named by its place, as the Worker names it in an error:
  // delegates.0.name, jobs.2.url. Empty rows count, as they are sent.
  function renumber(kind) {
    const spec = ROWS[kind];
    [...spec.list.children].forEach((li, i) => {
      li.querySelector('[data-title]').textContent = `${spec.what} ${i + 1}`;
      li.querySelector('[data-sr]').textContent = ` ${spec.what.toLowerCase()} ${i + 1}`;
      li.querySelectorAll('[data-k]').forEach((el) => { el.dataset.f = `${kind}.${i}.${el.dataset.k}`; });
    });
  }
  form.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add]');
    if (add) { addRow(add.dataset.add, true); return; }
    const rm = ev.target.closest('[data-remove]');
    if (!rm) return;
    const li = rm.closest('.cfrow');
    const kind = Object.keys(ROWS).find((k) => ROWS[k].list.contains(li));
    const next = li.nextElementSibling || li.previousElementSibling;
    li.remove();
    renumber(kind);
    (next ? next.querySelector('[data-remove]') : form.querySelector(`[data-add="${kind}"]`)).focus();
  });

  // ---- reading the form ----
  const val = (f) => { const el = form.querySelector(`[data-f="${f}"]`); return el ? el.value.trim() : ''; };
  function rowsOf(kind) {
    return [...ROWS[kind].list.children].map((li) => Object.fromEntries(
      [...li.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el.type === 'checkbox' ? el.checked : el.value.trim()])));
  }
  function values() {
    const out = {
      business: val('business'), live_url: val('live_url'),
      contact: { name: val('contact.name'), email: val('contact.email'), phone: val('contact.phone') },
      delegates: rowsOf('delegates'), services: rowsOf('services'), jobs: rowsOf('jobs'),
    };
    for (const [k] of choices.options) out[k] = !!form.querySelector(`[data-f="${k}"]`)?.checked;
    return out;
  }

  // A box marked wrong is unmarked as soon as it is typed in again.
  form.addEventListener('input', (ev) => {
    if (ev.target.getAttribute('aria-invalid')) ev.target.removeAttribute('aria-invalid');
  });
  // The live website is usually the first URL with work to do.
  form.addEventListener('change', (ev) => {
    if (ev.target.dataset.f !== 'live_url') return;
    const first = form.querySelector('[data-f="jobs.0.url"]');
    if (first && !first.value.trim() && !first.dataset.touched) first.value = ev.target.value.trim();
  });
  form.addEventListener('input', (ev) => { if (ev.target.dataset.f === 'jobs.0.url') ev.target.dataset.touched = '1'; });

  // ---- sending ----
  function showErr(text, field) {
    errEl.textContent = text;
    errEl.hidden = false;
    const bad = field && form.querySelector(`[data-f="${field}"]`);
    if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errEl.hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const save = $('cf-save');
    save.disabled = true;
    try {
      const { site } = await api('POST', '/api/client-form', values());
      done(site);
    } catch (ex) {
      if (ex instanceof Locked) { lock(ex); return; }
      showErr(ex.message, ex.field);
    } finally {
      save.disabled = false;
    }
  });

  function done(site) {
    form.hidden = true;
    $('cf-done-h').textContent = 'Saved';
    $('cf-done-p').textContent = `${site.name} is on the desk as site ${site.id}, with everything from the form.`;
    $('cf-open').href = '/#site=' + encodeURIComponent(site.id);
    $('cf-done').hidden = false;
    $('cf-done').focus();
  }
  $('cf-again').addEventListener('click', () => {
    $('cf-done').hidden = true;
    fresh();
    form.querySelector('[data-f="contact.name"]').focus();
  });

  // An empty form: one row of each kind, nothing ticked.
  function fresh() {
    form.reset();
    for (const kind of Object.keys(ROWS)) { ROWS[kind].list.innerHTML = ''; addRow(kind); }
    errEl.hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    form.hidden = false;
  }

  // ---- the key ----
  const gate = $('gate');
  const GATE_MSG = {
    'no-key-configured': 'This desk has no key set yet, so nobody can open it. Set DASH_KEY on the Worker (see the README), then enter it here.',
    'bad-key': 'That is not the desk key. Check it and try again.',
    'stale-session': 'The desk key has changed since this browser logged in. Enter the new key.',
  };
  // Asking for the key again (it was changed, or this browser logged off)
  // only hides the form: what was typed stays, and comes back on unlock.
  let wasDone = false;
  function lock(why) {
    wasDone = !$('cf-done').hidden;
    form.hidden = true;
    $('cf-done').hidden = true;
    note.textContent = '';
    $('gatemsg').textContent = (why && GATE_MSG[why.code])
      || 'Enter the desk key to fill in a client form. This browser stays logged in until you log off on the desk.';
    gate.hidden = false;
    $('gatekey').focus();
  }
  $('gateform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = $('gatekey').value.trim();
    if (!k) return;
    try { await api('POST', '/api/session', { key: k }); } catch (ex) {
      if (ex instanceof Locked) lock(ex); else $('gatemsg').textContent = ex.message;
      return;
    }
    $('gatekey').value = '';
    start();
  });

  // The form is drawn once. After that, start() only checks the login again
  // and shows the form as it was left; "Fill in another" is what empties it.
  let drawn = false;
  async function start() {
    note.hidden = false;
    note.textContent = 'Loading the form…';
    try {
      choices = (await api('GET', '/api/client-form')).choices;
    } catch (ex) {
      if (ex instanceof Locked) { lock(ex); return; }
      note.innerHTML = esc(ex.message) + ' <button class="linkbtn" type="button" id="retry">Try again</button>';
      $('retry').addEventListener('click', start);
      return;
    }
    gate.hidden = true;
    note.textContent = '';
    note.hidden = true;
    if (drawn) {
      if (wasDone) $('cf-done').hidden = false; else form.hidden = false;
      return;
    }
    $('cf-options').innerHTML = choices.options.map(([k, l]) =>
      `<label class="cftick"><input type="checkbox" data-f="${esc(k)}"><span>${esc(l)}</span></label>`).join('');
    fresh();
    drawn = true;
  }
  start();
})();
