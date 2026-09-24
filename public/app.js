// The Website Desk. One list of client sites, kept in the Worker's database,
// read and changed through /api/sites. Everything on the page is drawn from
// `sites` below; nothing is kept only in the page.
'use strict';

const KEY_STORE = 'webdesk.key';
const SORT_STORE = 'webdesk.sort';

const PLATFORMS = {
  astro: 'Astro', wordpress: 'WordPress', other: 'Other', none: 'Not live',
};
// The three yes/no questions: what each answer is called on the row, on the
// control that changes it, and which colour it gets. null is "not set".
const FLAGS = {
  astro_staging: {
    label: 'Astro staging', filter: 'staging',
    yes: 'Astro staging', no: 'No Astro staging', unset: 'Staging not set',
    yesCls: 'f-ok', noCls: 'f-no', opts: ['Yes', 'No'],
  },
  domain_ours: {
    label: 'Domain', filter: 'domain',
    yes: 'Our domain', no: "Client's domain", unset: 'Domain not set',
    yesCls: 'f-ours', noCls: 'f-no', opts: ['Ours', "Client's"],
  },
  needs_seo_ppc: {
    label: 'SEO / PPC optimization', filter: 'seo',
    yes: 'Needs SEO / PPC', no: 'SEO / PPC not needed', unset: 'SEO / PPC not set',
    yesCls: 'f-todo', noCls: 'f-no', opts: ['Needed', 'Not needed'],
  },
};
const FILTER_KEYS = ['platform', 'staging', 'domain', 'seo'];

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const note = $('note');

let sites = [];
let loaded = false;
const filters = { q: '', platform: '', staging: '', domain: '', seo: '' };
let sort = 'name';

// ---- storage: a convenience, never a requirement ----
// Private windows throw on localStorage; the key is then kept for this visit.
let memKey = '';
function readStore(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStore(k, v) {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* not fatal */ }
}
const deskKey = () => memKey || readStore(KEY_STORE) || '';

// ---- the API ----
class Locked extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
async function api(method, path, body) {
  const opts = { method, headers: { authorization: 'Bearer ' + deskKey() } };
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
    e.field = data.field;
    throw e;
  }
  return data;
}

// ---- small helpers ----
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byId = (id) => sites.find((s) => s.id === id);
const siteUrl = (addr) => 'https://' + addr;
const repoUrl = (repo) => 'https://github.com/' + repo;

function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}
// A steady colour per client, from the name, so a monogram is recognisable
// from one visit to the next.
function hue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1 && new Date().toDateString() === d.toDateString()) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return days + ' days ago';
  return d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function flagState(v) { return v === true ? 'yes' : v === false ? 'no' : 'unset'; }

// ---- filtering and sorting ----
function matches(s) {
  if (filters.platform) {
    const p = s.live_platform == null ? 'unset' : s.live_platform;
    if (p !== filters.platform) return false;
  }
  for (const [field, f] of Object.entries(FLAGS)) {
    const want = filters[f.filter];
    if (want && flagState(s[field]) !== want) return false;
  }
  if (filters.q) {
    const hay = [s.name, s.live_domain, s.staging_domain, s.github_repo, s.notes].join(' ').toLowerCase();
    if (!filters.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const SORTS = {
  name: { cmp: byName, words: 'A to Z' },
  'name-desc': { cmp: (a, b) => byName(b, a), words: 'Z to A' },
  updated: { cmp: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || byName(a, b), words: 'most recently changed first' },
  created: { cmp: (a, b) => (b.created_at || '').localeCompare(a.created_at || '') || byName(a, b), words: 'most recently added first' },
};

const anyFilter = () => !!filters.q || FILTER_KEYS.some((k) => filters[k]);

// ---- drawing ----
function lamp(platform) {
  const cls = platform == null ? 'p-unset' : 'p-' + platform;
  const word = platform == null ? 'Platform not set' : PLATFORMS[platform];
  return `<span class="lamp ${cls}"><span class="lampdot" aria-hidden="true"></span>${esc(word)}</span>`;
}

function flagPills(s) {
  return Object.entries(FLAGS).map(([field, f]) => {
    const st = flagState(s[field]);
    const cls = st === 'yes' ? f.yesCls : st === 'no' ? f.noCls : 'f-unset';
    return `<li class="flag ${cls}">${esc(f[st])}</li>`;
  }).join('');
}

function copyBtn(value, what) {
  return `<button class="btn copy" type="button" data-copy="${esc(value)}">Copy<span class="sr"> ${esc(what)}</span></button>`;
}
function openBtn(href, what) {
  return `<a class="btn open" href="${esc(href)}" target="_blank" rel="noopener">Open<span class="sr"> ${esc(what)} in a new tab</span></a>`;
}

function addrRow(label, value, href, name) {
  if (!value) {
    return `<div class="arow"><dt>${label}</dt><dd><span class="none">Not set</span></dd><dd></dd></div>`;
  }
  const what = `the ${name} ${label.toLowerCase()}`;
  return `<div class="arow"><dt>${label}</dt>
    <dd><a class="val mono" href="${esc(href)}" target="_blank" rel="noopener">${esc(value)}</a></dd>
    <dd class="btns">${copyBtn(href, what)}${openBtn(href, what)}</dd></div>`;
}

function segment(site, field, label, options, current, unsetWord) {
  const lid = `l-${site.id}-${field}`;
  const buttons = options.map(([value, word]) => {
    const on = current === value;
    return `<button type="button" data-field="${field}" data-value="${esc(JSON.stringify(value))}" aria-pressed="${on}">${esc(word)}</button>`;
  }).join('');
  const unset = current == null ? `<span class="unset">${unsetWord}</span>` : '';
  return `<div class="ctrl"><p class="clbl" id="${lid}">${esc(label)}${unset}</p>
    <div class="seg" role="group" aria-labelledby="${lid}">${buttons}</div></div>`;
}

function cardHtml(s, open) {
  const bodyId = 'b-' + s.id;
  const live = s.live_domain ? siteUrl(s.live_domain) : '';
  const acts = live
    ? `<span class="actlbl" aria-hidden="true">Live site</span>
       <span class="btns">${copyBtn(live, `the ${s.name} live address`)}${openBtn(live, `the ${s.name} live site`)}</span>`
    : `<span class="actlbl" aria-hidden="true">Live site</span><span class="noaddr">No live domain</span>`;

  const ctrls = [
    segment(s, 'live_platform', 'Live site runs on',
      Object.entries(PLATFORMS), s.live_platform, 'not set'),
    ...Object.entries(FLAGS).map(([field, f]) =>
      segment(s, field, f.label, [[true, f.opts[0]], [false, f.opts[1]]], s[field], 'not set')),
  ].join('');

  const stamp = `Changed ${when(s.updated_at)}` +
    (s.created_at && when(s.created_at) !== when(s.updated_at) ? ` · added ${when(s.created_at)}` : '');

  return `<article class="site" data-id="${esc(s.id)}"${open ? ' data-open' : ''}>
  <h3 class="hd">
    <button class="nm" type="button" aria-expanded="${open}" aria-controls="${bodyId}">
      <span class="mark" aria-hidden="true"><span class="mono">${esc(initials(s.name))}</span></span>
      <span class="nmcol">
        <span class="nmtxt">${esc(s.name)}</span>
        <span class="nmrole">${lamp(s.live_platform)}${s.live_domain ? `<span class="roletxt">${esc(s.live_domain)}</span>` : ''}</span>
      </span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="sr"> — show addresses and status</span>
    </button>
  </h3>
  <div class="acts">${acts}</div>
  <ul class="flags" aria-label="Status">${flagPills(s)}</ul>
  <div class="body" id="${bodyId}"${open ? '' : ' hidden'}>
    <div>
      <p class="sect">Addresses</p>
      <dl class="addr">
        ${addrRow('Live site', s.live_domain, live, s.name)}
        ${addrRow('Staging', s.staging_domain, s.staging_domain ? siteUrl(s.staging_domain) : '', s.name)}
        ${addrRow('GitHub repo', s.github_repo, s.github_repo ? repoUrl(s.github_repo) : '', s.name)}
      </dl>
    </div>
    <div>
      <p class="sect">Where it stands</p>
      <div class="ctrls">${ctrls}</div>
    </div>
    ${s.notes ? `<div><p class="sect">Notes</p><p class="notes">${esc(s.notes)}</p></div>` : ''}
    <div class="bfoot">
      <span class="stamp">${esc(stamp)} <span class="saved" role="status"></span></span>
      <span class="btns">
        <button class="btn edit" type="button">Edit details<span class="sr"> of ${esc(s.name)}</span></button>
        <button class="btn danger del" type="button">Delete<span class="sr"> ${esc(s.name)}</span></button>
      </span>
    </div>
  </div>
</article>`;
}

// The monogram's colour is set here rather than in the markup, so the page
// needs no inline styles. Favicons are fetched from the client's own live
// site, never through a third-party service; one that fails, or is a 1px
// placeholder, leaves the monogram showing. Each is tried once per visit:
// the list is redrawn on every filter change, and a site with no favicon
// should not be asked again each time.
const icons = new Map();   // favicon url -> Promise<boolean>
function iconOk(url) {
  if (!icons.has(url)) {
    icons.set(url, new Promise((done) => {
      const probe = new Image();
      probe.referrerPolicy = 'no-referrer';
      probe.addEventListener('load', () => done(probe.naturalWidth >= 8));
      probe.addEventListener('error', () => done(false));
      probe.src = url;
    }));
  }
  return icons.get(url);
}
function wireMarks(cards) {
  cards.forEach((card) => {
    const s = byId(card.dataset.id);
    if (!s) return;
    const mark = card.querySelector('.mark');
    mark.style.setProperty('--mark', `hsl(${hue(s.name)} 42% 42%)`);
    if (!s.live_domain) return;
    const url = 'https://' + s.live_domain.split('/')[0] + '/favicon.ico';
    iconOk(url).then((ok) => {
      if (!ok || !mark.isConnected) return;
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = url;
      mark.appendChild(img);
      mark.setAttribute('data-icon', '');
    });
  });
}

function openId() {
  const c = grid.querySelector('.site[data-open]');
  return c ? c.dataset.id : null;
}

function renderStats() {
  const count = (fn) => sites.filter(fn).length;
  const n = {
    all: sites.length,
    astro: count((s) => s.live_platform === 'astro'),
    wordpress: count((s) => s.live_platform === 'wordpress'),
    staging: count((s) => s.astro_staging === true),
    ours: count((s) => s.domain_ours === true),
    seo: count((s) => s.needs_seo_ppc === true),
  };
  document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = loaded ? n[el.dataset.count] : '–'; });
  document.querySelectorAll('.stat').forEach((btn) => {
    const set = JSON.parse(btn.dataset.set);
    const on = !filters.q && FILTER_KEYS.every((k) => (set[k] || '') === filters[k]);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function renderNote(shown) {
  if (!loaded) return;
  const total = sites.length;
  const noun = (n) => n + (n === 1 ? ' site' : ' sites');
  if (!total) { note.textContent = 'No sites on the desk yet.'; return; }
  if (anyFilter()) {
    note.innerHTML = `${esc(shown)} of ${esc(noun(total))} match, ${esc(SORTS[sort].words)}.` +
      ' <button class="linkbtn" type="button" data-clear>Show all</button>';
  } else {
    note.textContent = `${noun(total)}, ${SORTS[sort].words}.`;
  }
}

function renderGrid(keepOpen) {
  const open = keepOpen === undefined ? openId() : keepOpen;
  const list = sites.filter(matches).sort(SORTS[sort].cmp);
  if (!sites.length) {
    grid.innerHTML = `<div class="empty"><h3 class="emptyh">No client sites yet</h3>
      <p class="emptyp">Add the first one and it will appear here for everyone with the desk key.</p>
      <button class="addbtn" type="button" data-add>+ Add a site</button></div>`;
  } else if (!list.length) {
    grid.innerHTML = `<div class="empty"><h3 class="emptyh">Nothing matches</h3>
      <p class="emptyp">No site fits every filter that is set.</p>
      <button class="btn" type="button" data-clear>Show all sites</button></div>`;
  } else {
    grid.innerHTML = list.map((s) => cardHtml(s, s.id === open)).join('');
    wireMarks(grid.querySelectorAll('.site'));
  }
  document.querySelectorAll('.fsel select').forEach((sel) => {
    if (sel.id !== 'f-sort' && sel.value) sel.setAttribute('data-active', ''); else sel.removeAttribute('data-active');
  });
  renderStats();
  renderNote(list.length);
  paintDock();
}

// Redraws one card where it stands. A change made inside a card never moves
// it or hides it, even if it no longer fits the filter or the sort: a row
// jumping away under the finger is worse than a list that is briefly out of
// order. The next filter or sort puts everything in its place.
function redrawCard(id, focus) {
  const old = grid.querySelector(`.site[data-id="${CSS.escape(id)}"]`);
  const s = byId(id);
  if (!old || !s) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = cardHtml(s, old.hasAttribute('data-open'));
  const card = tpl.content.firstElementChild;
  old.replaceWith(card);
  wireMarks([card]);
  if (focus) {
    const el = card.querySelector(focus);
    if (el) el.focus();
  }
  renderStats();
  paintDock();
  return card;
}

// ---- open one row at a time, and bring it to rest in the same place ----
const SNAP_GAP = 12;
const still = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function snapTo(card) {
  // Two frames: the row above has just closed, so measure after layout.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const top = card.getBoundingClientRect().top + window.pageYOffset - SNAP_GAP;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.max(0, Math.min(top, max)), behavior: still && still.matches ? 'auto' : 'smooth' });
  }));
}
function setOpen(card, on) {
  if (on) card.setAttribute('data-open', ''); else card.removeAttribute('data-open');
  card.querySelector('.nm').setAttribute('aria-expanded', on ? 'true' : 'false');
  card.querySelector('.body').hidden = !on;
}
function toggle(card) {
  const opening = !card.hasAttribute('data-open');
  grid.querySelectorAll('.site[data-open]').forEach((c) => setOpen(c, false));
  if (opening) { setOpen(card, true); snapTo(card); }
  paintDock();
}

// ---- copy ----
function flashBtn(btn, word, done) {
  if (!btn._label) btn._label = btn.innerHTML;
  btn.textContent = word;
  if (done) btn.setAttribute('data-done', ''); else btn.removeAttribute('data-done');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.innerHTML = btn._label; btn.removeAttribute('data-done'); }, 1600);
}
function copy(btn, text, fallbackEl) {
  const select = () => {
    if (!fallbackEl) { flashBtn(btn, 'Press and hold'); return; }
    const r = document.createRange(); r.selectNodeContents(fallbackEl);
    const g = getSelection(); g.removeAllRanges(); g.addRange(r);
    flashBtn(btn, 'Selected');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flashBtn(btn, 'Copied', true), select);
  } else select();
}

// ---- the bar at the bottom: the open row's address, within reach ----
const dock = $('dock');
let dockUrl = '';
function paintDock() {
  const card = grid.querySelector('.site[data-open]');
  const s = card && byId(card.dataset.id);
  const addr = s && (s.live_domain || s.staging_domain);
  if (!addr) { dock.hidden = true; return; }
  dockUrl = siteUrl(addr);
  $('dock-name').textContent = s.name + (s.live_domain ? ' · live site' : ' · staging');
  $('dock-url').textContent = dockUrl;
  $('dock-open').setAttribute('href', dockUrl);
  dock.hidden = false;
}
$('dock-copy').addEventListener('click', (e) => copy(e.currentTarget, dockUrl, $('dock-url')));

// ---- saving one answer ----
function say(card, text, bad) {
  const el = card && card.querySelector('.saved');
  if (!el) return;
  el.textContent = text;
  if (bad) el.setAttribute('data-bad', ''); else el.removeAttribute('data-bad');
  clearTimeout(el._t);
  if (!bad) el._t = setTimeout(() => { el.textContent = ''; }, 2000);
}

async function saveField(id, field, value) {
  const s = byId(id);
  if (!s || s[field] === value) return;
  const before = s[field];
  const focus = `.seg button[data-field="${field}"][data-value="${CSS.escape(JSON.stringify(value))}"]`;
  s[field] = value;                       // show it now; put it back if the save fails
  let card = redrawCard(id, focus);
  if (card) card.querySelectorAll('.seg button').forEach((b) => { b.disabled = true; });
  say(card, 'Saving…');
  try {
    const { site } = await api('PATCH', '/api/sites/' + encodeURIComponent(id), { [field]: value });
    Object.assign(s, site);
    card = redrawCard(id, focus);
    say(card, 'Saved');
  } catch (e) {
    s[field] = before;
    card = redrawCard(id, focus);
    if (e instanceof Locked) { lock(e); return; }
    say(card, 'Not saved: ' + e.message, true);
  }
}

// ---- delete: two taps, no pop-up ----
async function del(btn, id) {
  if (!btn.hasAttribute('data-armed')) {
    btn.setAttribute('data-armed', '');
    btn.textContent = 'Tap again to delete';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.removeAttribute('data-armed'); btn.textContent = 'Delete'; }, 4000);
    return;
  }
  clearTimeout(btn._t);
  btn.disabled = true;
  try {
    await api('DELETE', '/api/sites/' + encodeURIComponent(id));
    sites = sites.filter((s) => s.id !== id);
    renderGrid(null);
  } catch (e) {
    if (e instanceof Locked) { lock(e); return; }
    btn.disabled = false;
    btn.removeAttribute('data-armed');
    btn.textContent = 'Delete';
    say(btn.closest('.site'), 'Not deleted: ' + e.message, true);
  }
}

// ---- add / edit ----
const editor = $('editor');
const form = $('edform');
let editing = null;   // the id being edited, or null when adding

function openEditor(site) {
  editing = site ? site.id : null;
  $('ed-title').textContent = site ? 'Edit ' + site.name : 'Add a site';
  form.reset();
  $('ederr').hidden = true;
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  if (site) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = site[el.name];
      el.value = v === true ? '1' : v === false ? '0' : v == null ? '' : v;
    }
  }
  editor.showModal();
  form.elements.namedItem('name').focus();
}

function formValues() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.value.trim();
    if (el.name in FLAGS) out[el.name] = v === '1' ? true : v === '0' ? false : null;
    else out[el.name] = v || null;
  }
  return out;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('ederr');
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const values = formValues();
  if (!values.name) {
    err.textContent = 'Client name is required.';
    err.hidden = false;
    form.elements.namedItem('name').setAttribute('aria-invalid', 'true');
    form.elements.namedItem('name').focus();
    return;
  }
  const save = $('ed-save');
  save.disabled = true;
  try {
    const { site } = editing
      ? await api('PATCH', '/api/sites/' + encodeURIComponent(editing), values)
      : await api('POST', '/api/sites', values);
    const i = sites.findIndex((s) => s.id === site.id);
    if (i === -1) sites.push(site); else sites[i] = site;
    editor.close();
    if (editing) {
      redrawCard(site.id);
    } else {
      // A new site should be seen, so filters that would hide it are cleared.
      if (!matches(site)) clearFilters(false);
      renderGrid(site.id);
      const card = grid.querySelector(`.site[data-id="${CSS.escape(site.id)}"]`);
      if (card) snapTo(card);
    }
  } catch (ex) {
    if (ex instanceof Locked) { editor.close(); lock(ex); return; }
    err.textContent = ex.message;
    err.hidden = false;
    const bad = ex.field && form.elements.namedItem(ex.field);
    if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
  } finally {
    save.disabled = false;
  }
});
$('ed-cancel').addEventListener('click', () => editor.close());
// A tap on the dimmed page outside the form closes it, as a sheet should.
editor.addEventListener('click', (e) => { if (e.target === editor) editor.close(); });
$('add').addEventListener('click', () => openEditor(null));

// ---- clicks inside the list, handled once for every row ----
function clearFilters(redraw = true) {
  filters.q = '';
  FILTER_KEYS.forEach((k) => { filters[k] = ''; });
  $('f-q').value = '';
  FILTER_KEYS.forEach((k) => { $('f-' + k).value = ''; });
  if (redraw) renderGrid();
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-clear]')) { clearFilters(); return; }
  if (t.closest('[data-add]')) { openEditor(null); return; }
  const card = t.closest('.site');
  if (!card) return;
  const id = card.dataset.id;
  const nm = t.closest('.nm');
  if (nm) { toggle(card); return; }
  const cp = t.closest('.btn.copy');
  if (cp) { copy(cp, cp.dataset.copy, null); return; }
  const seg = t.closest('.seg button');
  if (seg) { saveField(id, seg.dataset.field, JSON.parse(seg.dataset.value)); return; }
  if (t.closest('.btn.edit')) { openEditor(byId(id)); return; }
  const d = t.closest('.btn.del');
  if (d) { del(d, id); }
});

// ---- filters, search, sort, and the numbers at the top ----
FILTER_KEYS.forEach((k) => {
  $('f-' + k).addEventListener('change', (e) => { filters[k] = e.target.value; renderGrid(); });
});
let qTimer;
$('f-q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { filters.q = e.target.value.trim(); renderGrid(); }, 120);
});
$('f-sort').addEventListener('change', (e) => {
  sort = e.target.value;
  writeStore(SORT_STORE, sort);
  renderGrid();
});
document.querySelectorAll('.stat').forEach((btn) => {
  btn.addEventListener('click', () => {
    const set = JSON.parse(btn.dataset.set);
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    clearFilters(false);
    if (!wasOn) FILTER_KEYS.forEach((k) => { if (set[k]) { filters[k] = set[k]; $('f-' + k).value = set[k]; } });
    renderGrid();
  });
});

// ---- the key ----
const gate = $('gate');
// `why` is the Locked error from the API, or nothing when the key was just
// forgotten on purpose.
function lock(why) {
  loaded = false;
  sites = [];
  grid.innerHTML = '';
  $('tools').hidden = true;
  note.textContent = '';
  dock.hidden = true;
  renderStats();
  $('gatemsg').textContent =
    why && why.code === 'no-key-configured'
      ? 'This desk has no key set yet, so nobody can open it. Set DASH_KEY on the Worker (see the README), then enter it here.'
      : why && deskKey()
        ? why.message + ' Enter the desk key again.'
        : 'Enter the desk key to see the list. This browser will remember it.';
  gate.hidden = false;
  $('gatekey').focus();
}
$('gateform').addEventListener('submit', (e) => {
  e.preventDefault();
  const k = $('gatekey').value.trim();
  if (!k) return;
  memKey = k;
  writeStore(KEY_STORE, k);
  $('gatekey').value = '';
  load();
});
$('lock').addEventListener('click', () => {
  memKey = '';
  writeStore(KEY_STORE, '');
  lock(null);
});

// ---- loading ----
async function load({ quiet = false } = {}) {
  if (!quiet) note.textContent = 'Loading the list…';
  try {
    const data = await api('GET', '/api/sites');
    const changed = JSON.stringify(data.sites) !== JSON.stringify(sites);
    sites = data.sites;
    const first = !loaded;
    loaded = true;
    gate.hidden = true;
    $('tools').hidden = false;
    if (first || changed) renderGrid();
  } catch (e) {
    if (e instanceof Locked) { lock(e); return; }
    if (quiet) return;
    note.innerHTML = esc(e.message) + ' <button class="linkbtn" type="button" id="retry">Try again</button>';
    $('retry').addEventListener('click', () => load());
  }
}

// Coming back to the tab picks up what teammates changed meanwhile — unless
// something is being typed, which a redraw would throw away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && loaded && !editor.open) load({ quiet: true });
});

$('host').textContent = location.host || 'website desk';
const savedSort = readStore(SORT_STORE);
if (savedSort && SORTS[savedSort]) { sort = savedSort; $('f-sort').value = sort; }
load();
