// A site's services and accounts, contacts, domains, social media and history, shown in
// its opened row. Read from /api/sites/:id/details each time the row opens,
// and again after every change made here, so the history is always current.
//
// app.js draws the row and asks this file for this part of it
// (deskDetails.html), says when a row opens (deskDetails.opened) and when the
// desk locks (deskDetails.forget). This file reaches the desk only through
// app.js's `desk` hooks: its API call, the key, and the Copy and Open
// buttons the rest of the row uses. Everything here is in a function of its
// own, so none of its names can clash with app.js's.
'use strict';
(() => {
  const { api, Locked, lock, esc, copyBtn, openBtn, whenAt, fieldLabel, byId, PLATFORMS, FLAGS } = window.desk;

  // The labels and limits are src/details.js's, repeated here: the page has
  // no build step to share them. The choices for Kind and Used as come from
  // the Worker with each answer, so those lists never drift.
  const KINDS = {
    services: {
      noun: 'service', a: 'a service', title: 'Services & accounts',
      empty: 'No services or accounts listed yet.',
      hint: 'Never put a password or API key here. Say where the login lives instead.',
      fields: [
        { name: 'kind', label: 'Kind', type: 'select', choices: 'service_kinds', required: true },
        { name: 'identifier', label: 'ID or name', max: 200, placeholder: 'G-ABC123DEF4, or the bucket’s name' },
        { name: 'url', label: 'Link', max: 300, placeholder: 'dash.cloudflare.com/…', inputmode: 'url' },
        { name: 'account', label: 'Account', max: 120, placeholder: 'Which login it is under, not the password' },
        { name: 'notes', label: 'Notes', type: 'textarea', max: 2000 },
      ],
    },
    contacts: {
      noun: 'contact', a: 'a contact', title: 'Contacts',
      empty: 'No contacts listed yet.',
      fields: [
        { name: 'name', label: 'Name', max: 120, required: true },
        { name: 'role', label: 'Role', max: 120, placeholder: 'Owner, office manager…' },
        { name: 'email', label: 'Email', type: 'email', max: 120, inputmode: 'email', group: 1 },
        { name: 'phone', label: 'Phone', type: 'tel', max: 40, inputmode: 'tel', group: 1 },
        { name: 'notes', label: 'Notes', type: 'textarea', max: 2000 },
      ],
    },
    domains: {
      noun: 'domain', a: 'a domain', title: 'Domains',
      empty: 'No domains listed yet.',
      fields: [
        { name: 'hostname', label: 'Domain', max: 300, required: true, placeholder: 'example.com', inputmode: 'url' },
        { name: 'role', label: 'Used as', type: 'select', choices: 'domain_roles', required: true, group: 1 },
        { name: 'registrar', label: 'Registrar', max: 80, placeholder: 'GoDaddy, Cloudflare…', group: 1 },
        { name: 'dns_on_cloudflare', label: 'DNS on Cloudflare', type: 'select', flag: true, group: 1 },
        { name: 'renews_on', label: 'Renews on', type: 'date', group: 1 },
        { name: 'notes', label: 'Notes', type: 'textarea', max: 2000 },
      ],
    },
  };

  // Each social media platform is a kind of its own, with its own table on
  // the Worker, and they are shown together under one section. Adding one
  // asks for the platform first (KINDS.socials); an item edits under its
  // platform, which does not change.
  const SOCIAL = [['tiktok', 'TikTok'], ['linkedin', 'LinkedIn'], ['facebook', 'Facebook'], ['x', 'X'], ['instagram', 'Instagram']];
  const SOCIAL_FIELDS = [
    { name: 'url', label: 'Link', max: 300, required: true, placeholder: 'instagram.com/acme', inputmode: 'url' },
    { name: 'handle', label: 'Handle', max: 100, placeholder: '@acme', group: 1 },
    { name: 'account', label: 'Account', max: 120, placeholder: 'Which login it is under', group: 1 },
    { name: 'notes', label: 'Notes', type: 'textarea', max: 2000 },
  ];
  const SOCIAL_HINT = 'Never put a password here. Say where the login lives instead.';
  for (const [platform, name] of SOCIAL) {
    KINDS[platform] = { noun: name + ' link', a: 'a ' + name + ' link', platform: name, section: 'socials', hint: SOCIAL_HINT, fields: SOCIAL_FIELDS };
  }
  KINDS.socials = {
    noun: 'social media link', a: 'a social media link', title: 'Social media',
    empty: 'No social media links yet.', hint: SOCIAL_HINT, kinds: SOCIAL.map(([platform]) => platform),
    fields: [{ name: 'platform', label: 'Platform', type: 'select', choices: 'social_platforms', required: true }, ...SOCIAL_FIELDS],
  };
  const ORDER = ['services', 'contacts', 'domains', 'socials'];
  const ITEM_KIND = {
    service: 'services', contact: 'contacts', domain: 'domains',
    ...Object.fromEntries(SOCIAL.map(([platform]) => [platform, platform])),
  };
  // Every kind that has items, and the section each is shown in.
  const ITEM_KINDS = Object.values(ITEM_KIND);
  const sectionOf = (kind) => (KINDS[kind] && KINDS[kind].section) || kind;
  const HISTORY_FIRST = 20;
  const HISTORY_LIMIT = 200;   // the most the Worker sends
  const SOON = 30;             // a renewal this many days away or less is flagged
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // site id -> { data, err, seq, histOpen, histAll, say: { kind: [text, bad] } }.
  // `data` is the last answer, kept while a fresh one loads, so the row does
  // not flash back to "Loading" after every change.
  const cache = new Map();
  const grid = document.getElementById('grid');
  const enc = encodeURIComponent;
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const labelOf = (list, v) => ((list || []).find(([value]) => value === v) || [null, v])[1];

  // ---- loading ----
  function entry(id) {
    let e = cache.get(id);
    if (!e) {
      e = { data: null, err: null, seq: 0, histOpen: false, histAll: false, say: {}, sayTimer: {} };
      cache.set(id, e);
    }
    return e;
  }

  async function load(id) {
    const e = entry(id);
    const my = ++e.seq;
    e.err = null;
    paint(id);
    let data;
    try {
      data = await api('GET', '/api/sites/' + enc(id) + '/details');
    } catch (ex) {
      if (cache.get(id) !== e || my !== e.seq) return;
      if (ex instanceof Locked) { lockDesk(ex); return; }
      e.err = ex.message;
      paint(id);
      return;
    }
    if (cache.get(id) !== e || my !== e.seq) return;
    e.data = data;
    paint(id);
  }

  function lockDesk(why) {
    if (dialog.open) dialog.close();
    lock(why);   // app.js calls forget() from here
  }

  // ---- drawing ----
  const state = (e) => (!e ? 'closed' : e.data ? 'ready' : e.err ? 'error' : 'loading');

  function inner(id, e) {
    if (!e) return '';
    const err = e.err && `<p class="dtnote" data-bad role="alert">${esc(e.data
      ? 'Could not refresh this site’s details: ' + e.err
      : 'Could not load this site’s details: ' + e.err)}
      <button class="linkbtn" type="button" data-dact="retry">Try again</button></p>`;
    if (!e.data) return err || '<p class="dtnote" role="status">Loading services, contacts, domains and social media…</p>';
    return (err || '') + ORDER.map((kind) => sectionHtml(id, e, kind)).join('') + historyHtml(id, e);
  }

  function sectionHtml(id, e, kind) {
    const spec = KINDS[kind];
    // [kind, item] pairs: a section can show several kinds (Social media).
    const items = (spec.kinds || [kind]).flatMap((k) => (Array.isArray(e.data[k]) ? e.data[k] : []).map((it) => [k, it]));
    const s = byId(id);
    const hid = `dt-${kind}-${id}`;
    const [said, bad] = e.say[kind] || ['', false];
    return `<section class="dtsec" aria-labelledby="${esc(hid)}">
      <div class="dthead"><p class="sect" id="${esc(hid)}">${esc(spec.title)}</p>
        <button class="btn" type="button" data-dact="add" data-kind="${kind}">Add ${esc(spec.a)}<span class="sr"> to ${esc(s ? s.name : 'this site')}</span></button></div>
      ${spec.hint ? `<p class="dthint">${esc(spec.hint)}</p>` : ''}
      <p class="dtsay" role="status" data-say="${kind}"${bad ? ' data-bad' : ''}>${esc(said)}</p>
      ${items.length
        ? `<ul class="dtlist">${items.map(([k, it]) => itemHtml(k, it, e.data.choices || {})).join('')}</ul>`
        : `<p class="dtnone">${esc(spec.empty)}</p>`}
    </section>`;
  }

  // One row of an item, in the same shape as the row's addresses.
  const row = (label, value, btns = '', top = false) =>
    `<div class="arow${top ? ' dttop' : ''}"><dt>${esc(label)}</dt><dd>${value}</dd><dd class="${btns ? 'btns' : ''}">${btns}</dd></div>`;
  const plain = (label, v) => (v ? row(label, `<span class="val">${esc(v)}</span>`) : '');
  const mono = (label, v) => (v ? row(label, `<span class="val mono">${esc(v)}</span>`) : '');
  const link = (label, shown, href, what, open) => row(label,
    `<a class="val mono" href="${esc(href)}"${open ? ' target="_blank" rel="noopener"' : ''}>${esc(shown)}</a>`,
    copyBtn(open ? href : shown, what) + (open ? openBtn(href, what) : ''));
  const notes = (v) => (v ? row('Notes', `<p class="notes dtnotes">${esc(v)}</p>`, '', true) : '');
  const telHref = (p) => 'tel:' + p.replace(/\s*(x|ext\.?)\s*[0-9]+$/i, '').replace(/[^\d+]/g, '');

  // "2027-03-31" as "31 Mar 2027".
  function dayText(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? `${+m[3]} ${MONTHS[m[2] - 1]} ${m[1]}` : ymd;
  }

  // The day as written, and whether it needs looking at: past, or within a month.
  function renewal(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return esc(ymd);
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const now = new Date();
    const days = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const flag = days < 0 ? ['pill-bad', 'The renewal date has passed']
      : days === 0 ? ['pill-open', 'Renews today']
        : days <= SOON ? ['pill-open', days === 1 ? 'Renews tomorrow' : `Renews in ${days} days`] : null;
    return `<span class="dtdate"><span class="val">${esc(dayText(ymd))}</span>` +
      (flag ? `<span class="pill ${flag[0]}">${flag[1]}</span>` : '') + '</span>';
  }

  // What an item is called: in the history, and for a screen reader beside
  // its buttons.
  function itemName(kind, it, choices) {
    if (!it) return '';
    if (kind === 'services') return [labelOf(choices.service_kinds, it.kind), it.identifier].filter(Boolean).join(' ');
    if (kind === 'contacts') return it.name || '';
    if (kind === 'domains') return it.hostname || '';
    const where = it.handle ? '@' + it.handle : (it.url || '').replace(/^https:\/\/(www\.)?/, '');
    return [KINDS[kind] ? KINDS[kind].platform : kind, where].filter(Boolean).join(' ');
  }

  function itemHtml(kind, it, choices) {
    const name = itemName(kind, it, choices);
    let head;
    let rows;
    if (kind === 'services') {
      head = `<p class="dtt">${esc(labelOf(choices.service_kinds, it.kind))}</p>`;
      rows = [
        mono('ID or name', it.identifier),
        it.url && link('Link', it.url.replace(/^https:\/\//, ''), it.url, `the ${name} link`, true),
        plain('Account', it.account),
        notes(it.notes),
      ];
    } else if (kind === 'contacts') {
      head = `<p class="dtt">${esc(it.name)}${it.role ? ` <span class="dtsub">${esc(it.role)}</span>` : ''}</p>`;
      rows = [
        it.email && link('Email', it.email, 'mailto:' + it.email, `${it.name}’s email address`),
        it.phone && link('Phone', it.phone, telHref(it.phone), `${it.name}’s phone number`),
        notes(it.notes),
      ];
    } else if (KINDS[kind].section === 'socials') {
      head = `<p class="dtt">${esc(KINDS[kind].platform)}${it.handle ? ` <span class="dtsub">@${esc(it.handle)}</span>` : ''}</p>`;
      rows = [
        link('Link', it.url.replace(/^https:\/\//, ''), it.url, `the ${name} link`, true),
        plain('Account', it.account),
        notes(it.notes),
      ];
    } else {
      const dns = it.dns_on_cloudflare;
      head = `<p class="dtt">${esc(labelOf(choices.domain_roles, it.role))}</p>`;
      rows = [
        link('Domain', it.hostname, 'https://' + it.hostname, `the domain ${it.hostname}`, true),
        plain('Registrar', it.registrar),
        row('DNS on Cloudflare', dns === true ? '<span class="val">Yes</span>' : dns === false ? '<span class="val">No</span>'
          : '<span class="none">Not set</span>'),
        it.renews_on && row('Renews on', renewal(it.renews_on)),
        notes(it.notes),
      ];
    }
    const btn = (act, word, cls = '') =>
      `<button class="btn${cls}" type="button" data-dact="${act}" data-kind="${kind}" data-item="${esc(it.id)}">${word}<span class="sr"> ${esc(name)}</span></button>`;
    rows = rows.filter(Boolean).join('');
    return `<li class="dti">
      <div class="dtih">${head}<span class="btns">${btn('edit', 'Edit')}${btn('remove', 'Remove', ' danger')}</span></div>
      ${rows ? `<dl class="addr dtkv">${rows}</dl>` : ''}
    </li>`;
  }

  // ---- history ----
  // The name of each item the history mentions: as it is now, or as it was
  // when it was added or removed. Keyed by what it is and its id: each kind
  // counts from 0001, so service 0001 and contact 0001 are two things.
  const nameKey = (item, id) => item + ':' + id;
  const ITEM_OF = Object.fromEntries(Object.entries(ITEM_KIND).map(([item, kind]) => [kind, item]));
  function historyNames(data) {
    const names = new Map();
    const choices = data.choices || {};
    for (const h of data.history || []) {
      const kind = ITEM_KIND[h.item];
      const row = kind && h.action !== 'changed' && parse(h.action === 'added' ? h.new_value : h.old_value);
      const key = nameKey(h.item, h.item_id);
      if (row && !names.has(key)) names.set(key, itemName(kind, row, choices));
    }
    for (const kind of ITEM_KINDS) {
      for (const it of data[kind] || []) names.set(nameKey(ITEM_OF[kind], it.id), itemName(kind, it, choices));
    }
    return names;
  }
  function parse(text) {
    try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
  }

  // A value as the history stores it (text, and '1'/'0' for yes/no), in words.
  function valueText(item, field, v, choices) {
    if (v == null || v === '') return null;
    if (item === 'site') {
      if (field === 'live_platform') return PLATFORMS[v] || v;
      if (FLAGS[field]) return v === '1' ? FLAGS[field].opts[0] : v === '0' ? FLAGS[field].opts[1] : v;
      return v;
    }
    if (field === 'kind') return labelOf(choices.service_kinds, v);
    if (field === 'role' && item === 'domain') return labelOf(choices.domain_roles, v);
    if (field === 'dns_on_cloudflare') return v === '1' ? 'Yes' : v === '0' ? 'No' : v;
    if (field === 'renews_on') return dayText(v);
    return v;
  }
  function fieldName(item, field) {
    if (item === 'site') {
      try { return fieldLabel(field); } catch { return field; }
    }
    const f = (KINDS[ITEM_KIND[item]] || { fields: [] }).fields.find((x) => x.name === field);
    return f ? f.label : field;
  }
  const val = (t) => (t == null ? '<span class="none">not set</span>' : `<span class="dtval">${esc(clip(t))}</span>`);

  // "service G-ABC", or "Instagram link @acme" rather than "instagram Instagram @acme".
  function itemWords(kind, item, name) {
    const platform = KINDS[kind] && KINDS[kind].platform;
    const noun = platform ? KINDS[kind].noun : item;
    const rest = platform && name.startsWith(platform + ' ') ? name.slice(platform.length + 1) : name;
    return esc(noun) + (rest ? ` <span class="dtval">${esc(clip(rest))}</span>` : '');
  }

  function historyLine(h, names, choices) {
    const who = esc(h.who || 'Someone');
    const kind = ITEM_KIND[h.item];
    const what = h.item === 'site' ? 'this site' : itemWords(kind, h.item, names.get(nameKey(h.item, h.item_id)) || '');
    let text;
    if (h.action === 'added' || h.action === 'removed') {
      const row = kind && parse(h.action === 'added' ? h.new_value : h.old_value);
      const name = row ? itemName(kind, row, choices) : '';
      text = h.item === 'site' ? `${who} ${h.action} this site` : `${who} ${h.action} ${itemWords(kind, h.item, name)}`;
    } else {
      const from = valueText(h.item, h.field, h.old_value, choices);
      const to = valueText(h.item, h.field, h.new_value, choices);
      const label = esc(fieldName(h.item, h.field));
      const where = h.item === 'site' ? '' : ` for ${what}`;
      text = from == null ? `${who} set ${label}${where} to ${val(to)}`
        : `${who} changed ${label}${where} from ${val(from)} to ${val(to)}`;
    }
    return `<li><span class="dtwhen">${esc(whenAt(h.at))}</span> · ${text}</li>`;
  }

  function historyHtml(id, e) {
    const all = Array.isArray(e.data.history) ? e.data.history : [];
    const shown = e.histAll ? all : all.slice(0, HISTORY_FIRST);
    const hid = 'dth-' + id;
    const names = historyNames(e.data);
    const count = !all.length ? 'nothing yet' : all.length >= HISTORY_LIMIT ? `the latest ${all.length} changes` : plural(all.length, 'change');
    const more = all.length > shown.length
      ? `<p class="dtmore"><button class="linkbtn" type="button" data-dact="all">Show all ${all.length}</button></p>` : '';
    return `<section class="dtsec">
      <button class="dtfold" type="button" data-dact="history" aria-expanded="${e.histOpen}" aria-controls="${esc(hid)}">
        <span class="sect">History</span><span class="dtcount">${esc(count)}</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="dthbody" id="${esc(hid)}"${e.histOpen ? '' : ' hidden'}>
        ${all.length
          ? `<ul class="dthist">${shown.map((h) => historyLine(h, names, e.data.choices || {})).join('')}</ul>${more}`
          : '<p class="dtnone">No changes recorded yet.</p>'}
      </div>
    </section>`;
  }

  // Redraws one site's part of its row, where it stands. A control that had
  // the focus gets it back if it is still there.
  function paint(id) {
    const box = grid.querySelector(`[data-dts="${CSS.escape(id)}"]`);
    if (!box) return;
    const a = document.activeElement;
    const key = a && box.contains(a) && a.dataset.dact ? focusKey(a.dataset.dact, a.dataset.kind, a.dataset.item) : null;
    const e = cache.get(id);
    box.innerHTML = inner(id, e);
    box.dataset.state = state(e);
    const back = key && box.querySelector(key);
    if (back) back.focus();
  }
  function focusKey(act, kind, item) {
    return `[data-dact="${act}"]` + (kind ? `[data-kind="${kind}"]` : '') + (item ? `[data-item="${CSS.escape(item)}"]` : '');
  }

  // A word under a section's title: "Saved", or why something was not.
  function say(id, kind, text, bad) {
    const e = cache.get(id);
    if (!e) return;
    e.say[kind] = [text, !!bad];
    clearTimeout(e.sayTimer[kind]);
    const put = () => {
      const el = grid.querySelector(`[data-dts="${CSS.escape(id)}"] [data-say="${kind}"]`);
      if (!el) return;
      const [t, b] = e.say[kind] || ['', false];
      el.textContent = t;
      if (b) el.setAttribute('data-bad', ''); else el.removeAttribute('data-bad');
    };
    put();
    if (!bad) e.sayTimer[kind] = setTimeout(() => { delete e.say[kind]; put(); }, 2000);
  }

  // ---- remove: two taps, no pop-up, as Delete does for a site ----
  async function remove(btn, id, kind, itemId) {
    if (!btn.hasAttribute('data-armed')) {
      if (!btn._label) btn._label = btn.innerHTML;
      btn.setAttribute('data-armed', '');
      btn.textContent = 'Tap again to remove';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.removeAttribute('data-armed'); btn.innerHTML = btn._label; }, 4000);
      return;
    }
    clearTimeout(btn._t);
    btn.disabled = true;
    try {
      await api('DELETE', `/api/sites/${enc(id)}/${kind}/${enc(itemId)}`);
      say(id, sectionOf(kind), 'Removed.');
    } catch (ex) {
      if (ex instanceof Locked) { lockDesk(ex); return; }
      btn.disabled = false;
      btn.removeAttribute('data-armed');
      btn.innerHTML = btn._label;
      say(id, sectionOf(kind), 'Not removed: ' + ex.message, true);
      if (ex.status !== 404) return;   // gone already: the list below catches up
    }
    load(id);
  }

  // ---- add / edit: the same dialog as a site's, one for each kind ----
  const dialog = document.getElementById('dt-editor');
  const form = document.getElementById('dtform');
  const errEl = document.getElementById('dterr');
  // What the dialog is editing. An edit sends only what changed against
  // `base` (the form as it opened) and names `stamp` (the item's updated_at
  // then), so a teammate's newer save is merged rather than overwritten.
  const ed = { id: null, kind: null, item: null, base: null, stamp: null, opener: null };

  function fieldHtml(f, choices, current) {
    const attrs = (f.max ? ` maxlength="${f.max}"` : '') + (f.required ? ' required' : '');
    let control;
    if (f.type === 'select') {
      let opts = f.flag ? [['', 'Not set'], ['1', 'Yes'], ['0', 'No']]
        : [['', 'Choose one'], ...(Array.isArray(choices[f.choices]) ? choices[f.choices] : [])];
      // A value the list no longer has is kept, not silently changed.
      if (current != null && !f.flag && !opts.some(([v]) => v === current)) opts = [...opts, [current, current]];
      control = `<select name="${f.name}"${attrs}>${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      control = `<textarea name="${f.name}" rows="3"${attrs}></textarea>`;
    } else {
      control = `<input name="${f.name}" type="${f.type || 'text'}"${attrs} autocomplete="off" spellcheck="false"` +
        (f.inputmode ? ` inputmode="${f.inputmode}"` : '') + (f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '') + '>';
    }
    return `<label class="field"><span>${esc(f.label)}</span>${control}</label>`;
  }

  // The fields, with those that share a group side by side where there is room.
  function fieldsHtml(spec, choices, item) {
    const out = [];
    let group = [];
    const flush = () => { if (group.length) out.push(`<div class="edgrid">${group.join('')}</div>`); group = []; };
    for (const f of spec.fields) {
      const html = fieldHtml(f, choices, item ? item[f.name] : null);
      if (f.group) group.push(html); else { flush(); out.push(html); }
    }
    flush();
    return out.join('');
  }

  function itemToForm(kind, item) {
    const out = {};
    for (const f of KINDS[kind].fields) {
      const v = item ? item[f.name] : null;
      out[f.name] = f.flag ? (v === true || v === false ? v : null) : (v == null || v === '' ? null : String(v));
    }
    return out;
  }
  function fillForm(values) {
    for (const [k, v] of Object.entries(values)) {
      const el = form.elements.namedItem(k);
      if (el) el.value = v === true ? '1' : v === false ? '0' : v == null ? '' : v;
    }
  }
  function formValues() {
    const out = {};
    for (const f of KINDS[ed.kind].fields) {
      const v = form.elements.namedItem(f.name).value.trim();
      out[f.name] = f.flag ? (v === '1' ? true : v === '0' ? false : null) : v || null;
    }
    return out;
  }
  const label = (name) => (KINDS[ed.kind].fields.find((f) => f.name === name) || { label: name }).label;
  function showErr(text, field) {
    errEl.textContent = text;
    errEl.hidden = false;
    const bad = field && form.elements.namedItem(field);
    if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
  }

  function openEditor(id, kind, item, opener) {
    const e = cache.get(id);
    const spec = KINDS[kind];
    const choices = (e && e.data && e.data.choices) || {};
    Object.assign(ed, { id, kind, item: item || null, opener, base: itemToForm(kind, item), stamp: item ? item.updated_at : null });
    // "Edit TikTok link @acme", not "Edit TikTok link TikTok @acme".
    const called = spec.platform ? itemName(kind, item, choices).slice(spec.platform.length + 1) : itemName(kind, item, choices);
    document.getElementById('dt-title').textContent = item
      ? `Edit ${spec.noun}${called ? ' ' + called : ''}` : `Add ${spec.a}`;
    const hint = document.getElementById('dt-hint');
    hint.textContent = spec.hint || '';
    hint.hidden = !spec.hint;
    document.getElementById('dt-fields').innerHTML = fieldsHtml(spec, choices, item);
    errEl.hidden = true;
    fillForm(ed.base);
    dialog.showModal();
    form.elements.namedItem(spec.fields[0].name).focus();
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    errEl.hidden = true;
    const { id, item } = ed;
    let { kind } = ed;
    const spec = KINDS[kind];
    const values = formValues();
    const missing = spec.fields.find((f) => f.required && values[f.name] == null);
    if (missing) { showErr(missing.label + ' is required.', missing.name); return; }
    // A new social media link goes to its platform's own table.
    if (kind === 'socials') {
      kind = values.platform;
      delete values.platform;
    }
    let body = values;
    if (item) {
      body = {};
      for (const k of Object.keys(values)) if (values[k] !== ed.base[k]) body[k] = values[k];
      if (!Object.keys(body).length) { dialog.close(); return; }   // nothing was changed
      body.expected_updated_at = ed.stamp;
    }
    const save = document.getElementById('dt-save');
    save.disabled = true;
    try {
      const path = `/api/sites/${enc(id)}/${kind}` + (item ? '/' + enc(item.id) : '');
      const res = await api(item ? 'PATCH' : 'POST', path, body);
      // Back to the item's Edit button once the list is drawn again; a new
      // one's, for an add.
      ed.opener = null;
      ed.focus = focusKey('edit', kind, res.item && res.item.id);
      dialog.close();
      say(id, sectionOf(kind), item ? 'Saved.' : 'Added.');
      load(id);
    } catch (ex) {
      if (ex instanceof Locked) { lockDesk(ex); return; }
      if (ex.code === 'conflict' && ex.item) {
        // Three-way merge, as the site dialog does. Theirs is the item now; a
        // field only this dialog changed keeps its new value; a field both
        // changed shows theirs and is flagged, so nobody's edit disappears
        // without being seen.
        const theirs = itemToForm(kind, ex.item);
        const merged = { ...theirs };
        const clashes = [];
        for (const k of Object.keys(values)) {
          if (values[k] === ed.base[k]) continue;
          if (theirs[k] !== ed.base[k] && theirs[k] !== values[k]) { clashes.push(k); continue; }
          merged[k] = values[k];
        }
        ed.item = ex.item;
        ed.base = theirs;
        ed.stamp = ex.item.updated_at;
        fillForm(merged);
        clashes.forEach((k) => form.elements.namedItem(k).setAttribute('aria-invalid', 'true'));
        showErr(`Someone else saved this ${spec.noun} while you had it open. Their changes are now in the form` +
          (clashes.length
            ? `, and you both changed ${clashes.map(label).join(', ')}: the form shows their version of that, so check it. Your other changes are kept.`
            : ' and yours are kept on top.') +
          ' Save again when it looks right.');
        load(id);
        return;
      }
      if (ex.status === 404 && item) {
        showErr(`This ${spec.noun} is not on the desk any more: someone removed it. Cancel to see the list as it is now.`);
        load(id);
        return;
      }
      showErr(ex.message, ex.field);
    } finally {
      save.disabled = false;
    }
  });
  document.getElementById('dt-cancel').addEventListener('click', () => dialog.close());
  // A tap on the dimmed page outside the form closes it, as a sheet should.
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    const box = ed.id && grid.querySelector(`[data-dts="${CSS.escape(ed.id)}"]`);
    const back = ed.opener && ed.opener.isConnected ? ed.opener
      : box && ((ed.focus && box.querySelector(ed.focus)) || box.querySelector(focusKey('add', sectionOf(ed.kind))));
    // paint() keeps it there when the list is drawn again after a save.
    if (back) back.focus();
    ed.focus = null;
  });

  // ---- clicks inside this part of a row ----
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-dact]');
    const box = b && b.closest('[data-dts]');
    if (!box) return;
    const id = box.dataset.dts;
    const e = cache.get(id);
    const act = b.dataset.dact;
    const kind = b.dataset.kind;
    const find = () => e && e.data && (e.data[kind] || []).find((it) => it.id === b.dataset.item);
    if (act === 'retry') load(id);
    else if (!e || !e.data) return;
    else if (act === 'add') openEditor(id, kind, null, b);
    else if (act === 'edit') { const it = find(); if (it) openEditor(id, kind, it, b); }
    else if (act === 'remove') remove(b, id, kind, b.dataset.item);
    else if (act === 'history') { e.histOpen = !e.histOpen; paint(id); }
    else if (act === 'all') {
      e.histAll = true;
      paint(id);
      const list = box.querySelector('.dthist');
      const first = list && list.children[HISTORY_FIRST];
      if (first) { first.tabIndex = -1; first.focus(); }
    }
  });

  // Coming back to the tab reads the open row's details again, as app.js
  // reads the list, unless the dialog is open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || dialog.open) return;
    const card = grid.querySelector('.site[data-open]');
    if (card && cache.has(card.dataset.id)) load(card.dataset.id);
  });

  window.deskDetails = Object.freeze({
    // This part of a site's row, as it stands. An open row that has never
    // been read starts reading now.
    html(s, open) {
      if (open && !cache.has(s.id)) load(s.id);
      const e = cache.get(s.id);
      return `<div class="dts" data-dts="${esc(s.id)}" data-state="${state(e)}">${inner(s.id, e)}</div>`;
    },
    // The row has just opened: read it again, showing what was there meanwhile.
    opened(id) { load(id); },
    // Logged off or locked: nothing of it stays in the page.
    forget() {
      cache.clear();
      if (dialog.open) dialog.close();
    },
  });
})();
