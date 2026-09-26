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
const FILTER_KEYS = ['stage', 'platform', 'staging', 'domain', 'seo'];

// Where a site is on its way to Astro, worked out from its answers so there
// is nothing more to keep up to date. Live: the live site runs on Astro.
// Staging only: an Astro staging build is up, but the live site is not on it
// yet (a staging address counts unless "Astro staging" says no). Pending:
// everything else, waiting in the queue to be staged.
const STAGES = {
  pending: { title: 'Pending', about: 'Waiting to be staged: no Astro staging build yet.' },
  staging: { title: 'Staging only', about: 'An Astro staging build is up; the live site is not on it yet.' },
  live: { title: 'Live', about: 'The live site runs on Astro.' },
};
function stageOf(s) {
  if (s.live_platform === 'astro') return 'live';
  if (s.astro_staging === true || (s.astro_staging !== false && s.staging_domain)) return 'staging';
  return 'pending';
}

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const note = $('note');

let sites = [];
let loaded = false;
const filters = { q: '', stage: '', platform: '', staging: '', domain: '', seo: '' };
let sort = 'name';

// ---- storage: a convenience, never a requirement ----
// Private windows throw on localStorage. The key itself is not kept here: the
// Worker's login cookie is (see src/session.js).
function readStore(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStore(k, v) {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* not fatal */ }
}

// ---- the API ----
class Locked extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
// The browser sends the login cookie by itself. x-desk marks the request as
// coming from this page, which the Worker requires before it accepts a change.
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
    e.field = data.field;
    e.code = data.code;
    e.site = data.site;   // on a 409, the row as it now stands
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
  if (filters.stage && stageOf(s) !== filters.stage) return false;
  if (filters.platform) {
    const p = s.live_platform == null ? 'unset' : s.live_platform;
    if (p !== filters.platform) return false;
  }
  for (const [field, f] of Object.entries(FLAGS)) {
    const want = filters[f.filter];
    if (want && flagState(s[field]) !== want) return false;
  }
  if (filters.q) {
    const hay = [s.name, s.live_domain, s.staging_domain, s.github_repo, s.environment, s.notes].join(' ').toLowerCase();
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

// A row that names something rather than links to it.
function textRow(label, value) {
  return `<div class="arow"><dt>${label}</dt><dd>${value
    ? `<span class="val mono">${esc(value)}</span>` : '<span class="none">Not set</span>'}</dd><dd></dd></div>`;
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
      </dl>
    </div>
    <div>
      <p class="sect">Where it is built</p>
      <dl class="addr">
        ${addrRow('Chat', s.chat_url ? s.chat_url.replace(/^https:\/\//, '') : '', s.chat_url || '', s.name)}
        ${addrRow('GitHub repo', s.github_repo, s.github_repo ? repoUrl(s.github_repo) : '', s.name)}
        ${textRow('Environment', s.environment)}
      </dl>
    </div>
    <div>
      <p class="sect">Where it stands</p>
      <div class="ctrls">${ctrls}</div>
    </div>
    ${glRowHtml(s)}
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

// The Environment box suggests every name already on the desk, so the same
// environment is spelled the same way each time.
function fillEnvironments() {
  const names = [...new Set(sites.map((s) => s.environment).filter(Boolean))].sort();
  $('envs').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function openId() {
  const c = grid.querySelector('.site[data-open]');
  return c ? c.dataset.id : null;
}

function renderStats() {
  const count = (fn) => sites.filter(fn).length;
  const n = {
    all: sites.length,
    pending: count((s) => stageOf(s) === 'pending'),
    staging: count((s) => stageOf(s) === 'staging'),
    live: count((s) => stageOf(s) === 'live'),
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
    grid.innerHTML = Object.entries(STAGES).map(([key, st]) => {
      const inStage = list.filter((s) => stageOf(s) === key);
      // With a filter set, a stage with nothing in it is left out; with none
      // set, all three show, so an empty one reads as news too.
      if (!inStage.length && anyFilter()) return '';
      const hid = 'st-' + key;
      return `<section class="stage" aria-labelledby="${hid}">
        <h3 class="stageh" id="${hid}">${esc(st.title)} <span class="stagen">${inStage.length}</span></h3>
        <p class="stagep">${esc(st.about)}</p>
        ${inStage.length ? inStage.map((s) => cardHtml(s, s.id === open)).join('') : '<p class="stagenone">Nothing here now.</p>'}
      </section>`;
    }).join('');
    wireMarks(grid.querySelectorAll('.site'));
  }
  fillEnvironments();
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
// An edit sends only what was changed in the dialog, measured against `base`
// (the form as it opened), and names `baseStamp` (the row's updated_at then).
// If a teammate saved in the meantime the desk refuses it with a 409, and the
// dialog merges instead of overwriting: see the conflict branch below.
let base = null;
let baseStamp = null;

// A site in the same shape formValues() returns, so the two compare directly.
function siteToForm(site) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = site ? site[el.name] : null;
    out[el.name] = el.name in FLAGS
      ? (v === true || v === false ? v : null)
      : (v == null || v === '' ? null : String(v));
  }
  return out;
}
function fillForm(values) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = values[el.name];
    el.value = v === true ? '1' : v === false ? '0' : v == null ? '' : v;
  }
}
const fieldLabel = (name) => form.elements.namedItem(name).closest('label').querySelector('span').textContent;

function openEditor(site) {
  editing = site ? site.id : null;
  $('ed-title').textContent = site ? 'Edit ' + site.name : 'Add a site';
  form.reset();
  $('ederr').hidden = true;
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  base = siteToForm(site);
  baseStamp = site ? site.updated_at : null;
  if (site) fillForm(base);
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
  let body = values;
  if (editing) {
    body = {};
    for (const k of Object.keys(values)) if (values[k] !== base[k]) body[k] = values[k];
    if (!Object.keys(body).length) { editor.close(); return; }   // nothing was changed
    body.expected_updated_at = baseStamp;
  }
  const save = $('ed-save');
  save.disabled = true;
  try {
    const { site } = editing
      ? await api('PATCH', '/api/sites/' + encodeURIComponent(editing), body)
      : await api('POST', '/api/sites', body);
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
    if (ex.code === 'conflict' && ex.site) {
      // Three-way merge. Theirs is the row now; a field only this dialog
      // changed keeps its new value; a field both changed shows theirs and is
      // flagged, so nobody's edit disappears without being seen.
      const theirs = siteToForm(ex.site);
      const merged = { ...theirs };
      const clashes = [];
      for (const k of Object.keys(values)) {
        if (values[k] === base[k]) continue;
        if (theirs[k] !== base[k] && theirs[k] !== values[k]) { clashes.push(k); continue; }
        merged[k] = values[k];
      }
      const i = sites.findIndex((s) => s.id === ex.site.id);
      if (i !== -1) { sites[i] = ex.site; redrawCard(ex.site.id); }
      base = theirs;
      baseStamp = ex.site.updated_at;
      fillForm(merged);
      clashes.forEach((k) => form.elements.namedItem(k).setAttribute('aria-invalid', 'true'));
      err.textContent = 'Someone else saved this site while you had it open. Their changes are now in the form' +
        (clashes.length
          ? `, and you both changed ${clashes.map(fieldLabel).join(', ')}: the form shows their version of that, so check it. Your other changes are kept.`
          : ' and yours are kept on top.') +
        ' Save again when it looks right.';
      err.hidden = false;
      return;
    }
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

// ---- going live ----
// Go live points a site's live domain at its staging Worker (gate 13). The
// Worker does the work and keeps the record; this part of the page asks,
// shows each step, and decides nothing the Worker does not decide again.
// Every value in an answer is plain text that may come from a third party (a
// page title, a record's comment, a Cloudflare message), so each one goes
// through esc() and none is ever drawn as markup.
const glDialog = $('golive');
const glForm = $('glform');
const GL_STORE = 'webdesk.golive';     // sessionStorage: the site being opened, across the Access login
const GL_POLL = 5000;                  // the live check runs again this often
const GL_POLL_FOR = 10 * 60 * 1000;    // for this long
const GL_OLD = 7 * 86400000;           // a switch older than this needs the old-host ack to roll back
const GL_ID = /^[0-9a-f-]{36}$/;
const DESK_CODES = ['locked', 'stale-session', 'bad-key', 'no-key-configured'];
const PLAN_CHANGED = 'The plan changed since you checked. Read it again.';
const NO_ANSWER = 'The connection dropped before the desk answered. This is where it stands now.';
const OLD_HOST = { id: 'old-host', label: 'The old host is still ours: its address has not been switched off or given up (gate 20)' };
// A check's status in words as well as colour.
const GL_PILLS = { pass: ['Pass', 'pill-ok'], fail: ['Fails', 'pill-bad'], warn: ['Warning', 'pill-open'], wait: ['Waiting', 'pill-grey'] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The dialog's state. `seq` goes up with each request the dialog starts and
// each time it opens or closes, so an answer that arrives after the dialog
// has moved on is dropped rather than drawn over what is there now.
const gl = { id: null, seq: 0, view: null, opts: {}, working: false };

const listed = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || '');
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const hostnames = (g) => (g && Array.isArray(g.hosts) ? g.hosts.map((h) => h.hostname) : []);
const dayMonth = (d) => d.getDate() + ' ' + MONTHS[d.getMonth()] +
  (d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear());

// "today at 14:32", "yesterday at 09:05", "25 Sep", "25 Sep 2025".
function whenAt(iso) {
  const d = new Date(iso || NaN);
  if (isNaN(d)) return 'at a time the desk did not record';
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (d >= midnight) return 'today at ' + d.toTimeString().slice(0, 5);
  if (d >= midnight - 86400000) return 'yesterday at ' + d.toTimeString().slice(0, 5);
  return dayMonth(d);
}
// A log line's time: "14:32" today, "25 Sep 14:32" before.
function clock(iso) {
  const d = new Date(iso || NaN);
  if (isNaN(d)) return '';
  const hm = d.toTimeString().slice(0, 5);
  return d >= new Date().setHours(0, 0, 0, 0) ? hm : dayMonth(d) + ' ' + hm;
}
function daysAgo(iso) {
  const n = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return !(n >= 1) ? 'less than a day ago' : n === 1 ? '1 day ago' : n + ' days ago';
}

// Every planned host made it onto the staging Worker. The list's summary
// says so; the full row lists what was attached.
function allAttached(g) {
  if (typeof g.all_attached === 'boolean') return g.all_attached;
  const on = new Set((g.attached || []).map((a) => a.hostname));
  return hostnames(g).length > 0 && hostnames(g).every((h) => on.has(h));
}

// What a go-live allows: the state table, as goliveAllows() in
// src/golive-store.js has it. Only picks the buttons to show; the Worker
// checks again on every request.
function glCan(g) {
  const state = g ? g.state : null;
  const stale = !!(g && g.stale);
  return {
    go: !g || state === 'rolled-back' || (state === 'switch-failed' && g.restored === 1),
    rollback: ['checking', 'live', 'rollback-failed'].includes(state) ||
      (state === 'switch-failed' && g.restored !== 1) || stale,
    check: state === 'checking' || state === 'live' || (state === 'switching' && stale && allAttached(g)),
  };
}
const glBusy = (g) => !!g && !g.stale && (g.state === 'switching' || g.state === 'rolling-back');
const glNeedsOldHost = (g) => gl.needOldHost || (!!g.switched_at && Date.now() - Date.parse(g.switched_at) > GL_OLD);

// The row's "Go live" section: where the site's go-live stands, and the
// buttons that state allows.
function glRowHtml(s) {
  const g = s.golive || null;
  const can = glCan(g);
  const by = (who) => (who ? ' by ' + who : '');
  const btn = (act, word, cls = '') =>
    `<button class="btn${cls}" type="button" data-golive="${act}">${word}<span class="sr"> ${esc(s.name)}</span></button>`;
  const lines = [];   // [text, bad]
  const btns = [];
  if (g && g.stale) {
    lines.push([`This stopped part-way (last step ${whenAt(g.updated_at)}). The site may be down on ${g.main_host}.`, true]);
    if (can.check) btns.push(btn('check', 'Check now'));
    btns.push(btn('rollback', 'Roll back…', ' danger'));
  } else if (g && g.state === 'switching') {
    lines.push([`Switching now (started ${whenAt(g.started_at)}${by(g.started_by)}).`]);
  } else if (g && g.state === 'rolling-back') {
    lines.push(['Rolling back now…']);
  } else if (g && (g.state === 'checking' || g.state === 'live')) {
    lines.push([g.state === 'live'
      ? `Live on Astro since ${whenAt(g.switched_at)}.${g.started_by ? ' Switched by ' + g.started_by + '.' : ''}`
      : `Switched ${whenAt(g.switched_at)}${by(g.started_by)}. Waiting for HTTPS and public DNS.`]);
    if (g.has_error) lines.push([g.error_kind, true]);
    btns.push(btn('check', 'Check now'), btn('rollback', 'Roll back…', ' danger'));
  } else if (can.rollback) {
    lines.push([g.state === 'rollback-failed' ? 'The rollback did not finish.' : 'The switch failed and not everything was put back.', true]);
    if (g.has_error) lines.push([g.error_kind + ' Open Roll back to read what went wrong.', true]);
    btns.push(btn('rollback', 'Roll back…', ' danger'));
  } else if (g && g.state === 'unreadable') {
    lines.push([g.error_kind || 'The desk cannot read this go-live record.', true]);
  } else if (!can.go) {
    lines.push([`This go-live is in a state the desk does not know: ${g.state}.`, true]);
  } else {
    const need = [!s.live_domain && 'a live domain', !s.staging_domain && 'a staging domain'].filter(Boolean);
    lines.push([need.length
      ? `Going live from the desk needs ${listed(need)}. Add ${need.length > 1 ? 'them' : 'it'} with Edit details.`
      : `Points ${s.live_domain} at the staging Worker. The desk checks everything first, saves today's DNS records so they can be put back, and asks you to confirm.`]);
    if (g && g.state === 'rolled-back') lines.push([`Rolled back ${whenAt(g.rolled_back_at)}${by(g.rolled_back_by)}.`]);
    if (g && g.state === 'switch-failed') {
      lines.push([`The last switch failed ${whenAt(g.updated_at)} and was put back.`]);
    }
    if (!need.length) btns.push(btn('go', 'Go live…', ' open'));
  }
  return `<div class="glrow"><p class="sect">Go live</p>
      ${lines.map(([t, bad]) => `<p class="glnow"${bad ? ' data-bad' : ''}>${esc(t)}</p>`).join('')}
      ${btns.length ? `<div class="btns glbtns">${btns.join('')}</div>` : ''}
    </div>`;
}

// ---- the go-live calls ----
// Cloudflare Access stands in front of /api/golive, so an answer can be its
// own rather than the desk's: a redirect to its login page (seen here as an
// opaque redirect, because the fetch does not follow it) or a 401/403 that is
// not the desk's JSON. Both mean "sign in with Access". The desk's own
// refusals are JSON with a code.
class GoLiveError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; this.code = data.code; }
}
async function glApi(method, path, body) {
  const opts = { method, headers: { 'x-desk': '1' }, redirect: 'manual' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, opts); } catch {
    throw new GoLiveError('Could not reach the desk. Check the connection and try again.', 0, { code: 'network' });
  }
  if (res.type === 'opaqueredirect') throw new GoLiveError('', res.status, { code: 'signin' });
  const data = await res.json().catch(() => null);
  const ours = !!data && typeof data === 'object' && typeof data.error === 'string';
  if (res.ok && data && typeof data === 'object') return data;
  if (!ours && (res.status === 401 || res.status === 403)) throw new GoLiveError('', res.status, { code: 'signin' });
  if (ours && DESK_CODES.includes(data.code)) throw new Locked(data.error, data.code);
  throw new GoLiveError(ours ? data.error : 'The desk answered ' + res.status + '.', res.status, ours ? data : {});
}
const glPath = (action) => '/api/golive/' + encodeURIComponent(gl.id) + (action ? '/' + action : '');

// The refusals that are a state of the dialog, not an error in it: the desk
// key, the Access login, and a Worker that is not set up for going live.
// True when the dialog now shows one of them.
function glRefused(e) {
  if (e instanceof Locked) {
    glPending = gl.id ? { id: gl.id, mode: gl.mode } : null;   // back to it after unlocking
    glIdle();
    glDialog.close();
    lock(e);
    return true;
  }
  const d = e.data || {};
  if (e.code === 'signin') glShow('signin');
  else if (e.code === 'access-invalid') glShow('signin', { why: e.message });
  else if (e.code === 'golive-not-set-up') glShow('not-set-up', { missing: d.missing });
  else if (e.code === 'not-allowed') glShow('not-allowed', { email: d.email, why: e.message });
  else if (e.code === 'access-not-protecting') glShow('access-not-protecting');
  else return false;
  return true;
}

// Replaces the row with the one an answer carries, so the list shows the
// go-live's state as soon as the dialog does.
function glApplySite(site) {
  const i = site && site.id ? sites.findIndex((s) => s.id === site.id) : -1;
  if (i === -1) return;
  if (!('golive' in site)) site.golive = sites[i].golive;
  sites[i] = site;
  redrawCard(site.id);
}

// ---- drawing the dialog ----
const glBtn = (act, word = 'Close', cls = '') => `<button class="btn${cls}" type="button" data-act="${act}">${word}</button>`;
const glSection = (title, inner) => `<section class="glsec"><p class="sect">${esc(title)}</p>${inner}</section>`;
const glValues = (list) => `<ul class="glvals">${list.map((t) => `<li class="glv">${esc(t)}</li>`).join('')}</ul>`;

// "A acme.com → 192.0.2.10 (DNS only, TTL auto)", from the record's own
// fields.
function recordText(r) {
  const ttl = !r.ttl || r.ttl === 1 ? 'TTL auto' : 'TTL ' + r.ttl;
  return `${r.type} ${r.name} → ${r.content} (${r.proxied ? 'proxied' : 'DNS only'}, ${ttl})`;
}

function checkList(checks) {
  return `<ul class="gllist">${checks.map((c) => {
    const [word, cls] = GL_PILLS[c.status] || [c.status, 'pill-grey'];
    const items = Array.isArray(c.items) && c.items.length ? glValues(c.items) : '';
    return `<li class="glck"><span class="pill ${cls}">${esc(word)}</span><div class="glckt">
      <p class="glckl">${esc(c.label)}</p>${c.detail ? `<p class="glckd">${esc(c.detail)}</p>` : ''}${items}</div></li>`;
  }).join('')}</ul>`;
}

function planHtml(p) {
  const hosts = Array.isArray(p.hosts) ? p.hosts : [];
  const records = Array.isArray(p.delete_records) ? p.delete_records : [];
  const moves = Array.isArray(p.saved_domains) ? p.saved_domains : [];
  const row = (label, inner) => `<div class="glprow"><dt>${esc(label)}</dt><dd>${inner}</dd></div>`;
  const rows = [
    row('Worker', `<span class="glv">${esc(p.worker)}</span>` +
      (p.staging_host ? `<span class="glhint">It serves ${esc(p.staging_host)} today.</span>` : '')),
    row('Addresses', `<ul class="glvals">${hosts.map((h) => `<li><span class="glv">${esc(h.hostname)}</span>
      <span class="glhint">${h.role === 'main' ? 'The main address.' : 'Redirects to ' + esc(p.main) + '.'}</span></li>`).join('')}</ul>`),
    row('DNS records it deletes', records.length
      ? glValues(records.map(recordText)) + '<span class="glhint">Saved first, so Roll back can put them back exactly.</span>'
      : '<span class="glhint">None.</span>'),
    moves.length && row('Moves off another Worker',
      glValues(moves.map((d) => `${d.hostname} from ${d.service}`))),
    row('Redirect', p.redirect
      ? `<span class="glv">301 from ${esc(p.redirect.from)} to ${esc(p.redirect.to)}</span>`
      : '<span class="glhint">None.</span>'),
  ];
  return glSection('The plan', `<dl class="glplan">${rows.filter(Boolean).join('')}</dl>`);
}

// The other half of an apex/www pair, when the live domain has one.
function glPair(p) {
  const red = (p.hosts || []).find((h) => h.role === 'redirect');
  if (red) return { main: p.main, pair: red.hostname };
  const zone = p.zone && p.zone.name;
  const pair = !zone || !p.main ? null : p.main === zone ? 'www.' + zone : p.main === 'www.' + zone ? zone : null;
  return pair ? { main: p.main, pair } : null;
}

const glAcks = (acks, legend) => `<fieldset class="glacks"><legend class="sect">${esc(legend)}</legend>
  ${acks.map((a) => `<label class="glcheck"><input type="checkbox" name="ack" value="${esc(a.id)}"><span>${esc(a.label)}</span></label>`).join('')}
  </fieldset>`;
const glConfirm = (words) => `<label class="field"><span>${words}</span>
  <input id="gl-confirm" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></label>`;
const glTyped = () => { const el = $('gl-confirm'); return el ? el.value.trim().toLowerCase() : ''; };
const glTicked = () => [...glForm.querySelectorAll('input[name="ack"]:checked')].map((el) => el.value);

function logHtml(log) {
  const all = Array.isArray(log) ? log : [];
  // The log keeps every go-live this site has had; this one starts at its switch.
  const run = all.slice(Math.max(0, all.map((e) => e.action).lastIndexOf('switch-started')));
  if (!run.length) return '';
  return glSection('What the desk did', `<ol class="gllist gllog">${run.map((e) =>
    `<li><time class="gltime" datetime="${esc(e.at)}">${esc(clock(e.at))}</time><span class="gltxt">${esc(e.text)}</span></li>`).join('')}</ol>`);
}

function notesHtml(notes) {
  return Array.isArray(notes) && notes.length ? glSection('Notes', `<ul class="gllist">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`) : '';
}

// The wrangler warning, as the check put it when this browser ran the check,
// or in the same words from the row's own fields.
function pushWarning(g) {
  const w = gl.check && (gl.check.checks || []).find((c) => c.id === 'wrangler');
  if (w && w.detail) return w.detail;
  const s = byId(gl.id);
  const repo = s && s.github_repo ? s.github_repo : 'the repo';
  let text = `A Workers Builds deploy replaces ${g.worker}'s Custom Domains with the list in the repo's wrangler config. ` +
    `If ${repo}'s wrangler.jsonc has a routes key, add ${listed(hostnames(g))} to it with custom_domain: true and push that BEFORE anything else is deployed. ` +
    'After a Roll back, take them out again.';
  for (const d of g.saved_domains || []) {
    text += ` Also disconnect Workers Builds on ${d.service}, or remove ${d.hostname} from ${d.service}'s wrangler config, or ${d.service}'s next build takes ${d.hostname} back.`;
  }
  return text;
}

// The gate 13 RECORD block for sites/<domain>.md, in the procedure's own
// field names. The SSL mode comes from the go-live record (or, on a record
// from before it was kept, from the check this browser ran), and the MX/TXT
// line from the last live check.
function gate13(g) {
  if (g.ssl_mode) return gate13Lines(g, SSL_WORDS[g.ssl_mode] || g.ssl_mode);
  const ssl = gl.check && (gl.check.checks || []).find((c) => c.id === 'ssl');
  const sslMode = !ssl ? 'not read in this browser session (see the SSL/TLS check)'
    : (/^SSL\/TLS mode is (.+?)\. /.exec(ssl.detail || '') || [])[1] || ssl.detail;
  return gate13Lines(g, sslMode);
}
const SSL_WORDS = {
  off: 'Off', flexible: 'Flexible', full: 'Full', strict: 'Full (strict)', origin_pull: 'Strict (SSL-Only Origin Pull)',
};
function gate13Lines(g, sslMode) {
  const mx = gl.verify && gl.verify.checks.find((c) => c.id === 'mx-txt');
  const mxText = !mx ? 'not checked yet' : mx.status === 'pass' ? 'unchanged'
    : [mx.detail, ...(Array.isArray(mx.items) ? mx.items : [])].join(' ');
  const records = (g.saved_records || []).map((r) =>
    `  → resources.previous_apex_record: ${r.type} ${r.content} (${r.proxied ? 'proxied' : 'DNS only'})    <- rollback`);
  const pair = g.redirect ? g.redirect.from : null;
  return [
    `### [13] ${g.switched_at || g.started_at} · PROOF · awaiting-approval`,
    `  → resources.custom_domains: [${hostnames(g).join(', ')}]`,
    `  → resources.worker: ${g.worker}`,
    ...(records.length ? records : ['  → resources.previous_apex_record: none']),
    ...(g.saved_domains || []).map((d) => `  → resources.previous_custom_domains: ${d.hostname} on ${d.service}`),
    `  → canonical: ${g.main_host}` + (!pair ? '' : g.redirect_rule ? `   (${pair} 301s to it)` : `   (${pair} does not redirect: the rule was not added)`),
    `  → ssl_mode: ${sslMode}`,
    `  → client MX + TXT: ${mxText}`,
    `  → checked by: ${g.started_by || 'unknown'} via the Website Desk; public DNS: dns.google + cloudflare-dns.com`,
  ].join('\n');
}

// ---- the dialog's steps ----
const GL_VIEWS = {
  loading: () => ({ say: 'Reading where this go-live stands…', btns: glBtn('close', 'Cancel') }),
  checking: () => ({
    say: 'Checking…',
    body: '<p class="glp">The desk reads the zone, the Workers, the staging site and public DNS. It changes nothing yet.</p>',
    btns: glBtn('close', 'Cancel'),
  }),
  signin: ({ why }) => ({
    say: "Going live changes the client's DNS, so it needs your own Cloudflare Access login as well as the desk key.",
    body: why ? `<p class="glp" data-bad>${esc(why)}</p>` : '',
    btns: glBtn('close', 'Cancel') + (gl.id ? glBtn('signin', 'Sign in with Cloudflare Access', ' open') : ''),
  }),
  'not-set-up': ({ missing }) => ({
    say: 'Going live is not set up on this Worker yet.', bad: true,
    body: (Array.isArray(missing) && missing.length
      ? `<p class="glp">It needs these settings:</p>${glValues(missing)}` : '') +
      "<p class=\"glp\">See 'Going live from the desk' in the README.</p>",
    btns: glBtn('close'),
  }),
  'not-allowed': ({ email, why }) => ({
    say: email ? `${email} is not on the list of people who can go live.`
      : why || 'Your Cloudflare Access login is not on the list of people who can go live.',
    bad: true,
    body: '<p class="glp">Whoever looks after the desk can add you to GOLIVE_EMAILS.</p>',
    btns: glBtn('close'),
  }),
  'access-not-protecting': () => ({
    say: 'Cloudflare Access is not in front of /api/golive yet, so the desk refuses to change DNS. See the README.', bad: true,
    btns: glBtn('close'),
  }),
  error: ({ why, retry }) => ({ say: why, bad: true, btns: glBtn('close') + (retry ? glBtn('retry', 'Try again', ' open') : '') }),
  working: ({ text }) => ({
    say: text,
    body: '<p class="glp">The desk records each step as it goes. If the connection drops, open Go live on this site again to see where it got to.</p>',
  }),
  checks: viewChecks,
  rollback: viewRollback,
  state: viewState,
};

function viewChecks({ note, err }) {
  const c = gl.check;
  const checks = Array.isArray(c.checks) ? c.checks : [];
  const p = c.plan || null;
  const fails = checks.filter((k) => k.status === 'fail').length;
  const warns = checks.filter((k) => k.status === 'warn').length;
  const say = c.ready
    ? `Ready to go live. Read ${warns ? 'the ' + plural(warns, 'warning') + ' and ' : ''}the plan, then confirm below.`
    : fails ? `${plural(fails, 'check')} ${fails === 1 ? 'fails' : 'fail'}, so the desk will not go live yet. Fix what ${fails === 1 ? 'it says' : 'they say'}, then check again.`
      : 'The desk is not ready to go live. Check again.';
  const pair = gl.pair && `<label class="glcheck"><input type="checkbox" id="gl-pair"${gl.includePair ? ' checked' : ''}>
    <span>Also move <span class="mono">${esc(gl.pair.pair)}</span> and redirect it to <span class="mono">${esc(gl.pair.main)}</span>
    <span class="glhint">Changing this runs the check again.</span></span></label>`;
  const ready = c.ready && p;
  const body = [
    note && `<p class="glnote">${esc(note)}</p>`,
    err && `<p class="ederr" role="alert">${esc(err)}</p>`,
    glSection('Checks', checkList(checks)),
    p && planHtml(p),
    pair,
    ready && glAcks(Array.isArray(c.acks) ? c.acks : [], 'Before you go live'),
    ready && glConfirm(`Type <span class="mono">${esc(p.main)}</span> to point it at <span class="mono">${esc(p.worker)}</span>`),
  ];
  return {
    say, bad: !c.ready,
    body: body.filter(Boolean).join(''),
    btns: glBtn('close', 'Cancel') + glBtn('check', 'Check again') +
      (p ? '<button class="btn open" type="submit" id="gl-go" disabled>Go live</button>' : ''),
  };
}

function viewRollback({ err }) {
  const g = gl.detail.golive;
  const records = g.saved_records || [];
  const moves = g.saved_domains || [];
  const body = [
    err && `<p class="ederr" role="alert">${esc(err)}</p>`,
    glSection('DNS records to put back', records.length
      ? `<p class="glp">These records were saved ${esc(daysAgo(g.started_at || g.switched_at))}.</p>${glValues(records.map(recordText))}`
      : '<p class="glp">None: no DNS record was deleted.</p>'),
    glSection('Hostnames to detach from ' + g.worker, glValues(hostnames(g))),
    moves.length && glSection('Going back to their old Worker', glValues(moves.map((d) => `${d.hostname} to ${d.service}`))),
    g.redirect && glSection('Redirect to remove', glValues([`301 from ${g.redirect.from} to ${g.redirect.to}`])),
    notesHtml(g.notes),
    glNeedsOldHost(g) && glAcks([OLD_HOST], `Switched ${daysAgo(g.switched_at)}`),
    glConfirm(`Type <span class="mono">${esc(g.main_host)}</span> to confirm`),
  ];
  return {
    say: `Roll back puts back what was on ${listed(hostnames(g))} before the switch, one hostname at a time.`,
    body: body.filter(Boolean).join(''),
    btns: glBtn('close', 'Cancel') + '<button class="btn danger" type="submit" id="gl-undo" disabled>Roll back</button>',
  };
}

// The result of a switch or rollback, or wherever the go-live stands when
// the dialog is opened on it.
function viewState({ note }) {
  const { golive: g, log } = gl.detail;
  const s = byId(gl.id);
  const can = glCan(g);
  const by = (who) => (who ? ' by ' + who : '');
  const hosts = listed(hostnames(g));
  const bad = (t) => (t ? `<p class="glp" data-bad>${esc(t)}</p>` : '');
  const top = [note && `<p class="glnote">${esc(note)}</p>`];
  const end = [];
  let say;
  let failed = false;
  let btns = glBtn('close');
  if (!g) {
    say = 'This site has not gone live from the desk.';
    if (s && s.live_domain && s.staging_domain) btns += glBtn('check', 'Go live…', ' open');
  } else if (g.stale) {
    failed = true;
    say = `This stopped part-way (last step ${whenAt(g.updated_at)}). The site may be down on ${g.main_host}.`;
    btns += (can.check ? glBtn('verify', 'Check now') : '') + glBtn('rollback', 'Roll back…', ' danger');
  } else if (g.state === 'switching') {
    say = `Switching now (started ${whenAt(g.started_at)}${by(g.started_by)}). This follows it until it finishes.`;
  } else if (g.state === 'rolling-back') {
    say = 'Rolling back now… This follows it until it finishes.';
  } else if (g.state === 'checking' || g.state === 'live') {
    say = g.state === 'live'
      ? `Live on Astro since ${whenAt(g.switched_at)}. ${g.main_host} is served by ${g.worker}.`
      : `Switched ${hosts} to ${g.worker}. Waiting for HTTPS and public DNS.`;
    top.push(bad(g.error && 'The switch worked, but: ' + g.error));
    end.push(
      `<div class="glbox"><p class="sect">Before the next push</p><p class="glp">${esc(pushWarning(g))}</p></div>`,
      `<section class="glsec"><div class="glhead"><p class="sect">Gate 13 record</p>${glBtn('copy', 'Copy<span class="sr"> the gate 13 record</span>')}</div>
        <pre class="glrec" id="gl-rec"></pre><p class="glhint">Paste it into sites/${esc(g.zone_name)}.md.</p></section>`,
      `<section class="glsec"><div class="glhead"><p class="sect">Live check</p>
        <button class="btn" type="button" data-act="verify" id="gl-now">Check now</button></div>
        <div id="gl-verify"></div><p class="glpoll" id="gl-poll" role="status"></p></section>`);
    btns += glBtn('rollback', 'Roll back…', ' danger');
  } else if (g.state === 'switch-failed') {
    failed = true;
    say = 'The switch failed.';
    top.push(bad(g.error), `<p class="glp">${g.restored === 1
      ? 'Everything was put back as it was, so the old site is showing.'
      : 'Not everything was put back. Roll back to finish putting the old site back.'}</p>`);
    btns += g.restored === 1 ? glBtn('check', 'Go live…', ' open') : glBtn('rollback', 'Roll back…', ' danger');
  } else if (g.state === 'rolled-back') {
    say = `Rolled back ${whenAt(g.rolled_back_at)}${by(g.rolled_back_by)}. ${hosts} ${hostnames(g).length > 1 ? 'are' : 'is'} back as before.`;
    end.push(`<div class="glbox"><p class="sect">Before the next push</p><p class="glp">${esc(
      `If ${hosts} went into ${s && s.github_repo ? s.github_repo : 'the repo'}'s wrangler config for this go-live, take them out again and push, or the next deploy attaches them to ${g.worker} again.`)}</p></div>`);
  } else if (g.state === 'rollback-failed') {
    failed = true;
    say = 'The rollback did not finish.';
    top.push(bad(g.error));
    btns += glBtn('rollback', 'Roll back again…', ' danger');
  } else {
    failed = true;
    say = `This go-live is in a state the desk does not know: ${g.state}.`;
  }
  const body = [...top, g && notesHtml(g.notes), logHtml(log), ...end];
  return { say, bad: failed, body: body.filter(Boolean).join(''), btns };
}

// The live check's part of the result, repainted on each check without
// redrawing the rest (or moving the focus).
function glPaintVerify() {
  const box = $('gl-verify');
  if (!box) return;
  const v = gl.verify;
  box.innerHTML = v ? checkList(v.checks) : '';
  $('gl-rec').textContent = gate13(gl.detail.golive);
  $('gl-now').disabled = !!gl.verifying;
  const poll = $('gl-poll');
  poll.textContent = gl.verifying ? 'Checking the live site…'
    : gl.verifyErr ? 'Could not check: ' + gl.verifyErr + (gl.pollTimer ? ' Trying again in 5 seconds.' : '')
      : !v ? ''
        : v.done ? 'Every check passes.'
          : gl.pollTimer ? 'Not everything passes yet. Checking again in 5 seconds.'
            : 'Stopped checking after 10 minutes. Press Check now to check again.';
  if (gl.verifyErr) poll.setAttribute('data-bad', ''); else poll.removeAttribute('data-bad');
}

// Draws the current step. A control that had the focus keeps it if the step
// still has it.
function glDraw() {
  const a = document.activeElement;
  const key = a && glForm.contains(a) && a !== $('gl-title')
    ? (a.id ? '#' + a.id : a.dataset.act ? `[data-act="${a.dataset.act}"]` : null) : null;
  const v = GL_VIEWS[gl.view](gl.opts);
  const say = $('gl-say');
  say.textContent = v.say || '';
  if (v.bad) say.setAttribute('data-bad', ''); else say.removeAttribute('data-bad');
  $('gl-body').innerHTML = v.body || '';
  $('gl-btns').innerHTML = v.btns || '';
  if ($('gl-verify')) glPaintVerify();
  glSync();
  const back = key && glForm.querySelector(key);
  if (back) back.focus();
  else if (key) $('gl-title').focus();
}

// A new step: drawn from the top, with the focus on the title (or on the
// control that asked for it) so a screen reader starts from there.
function glShow(view, opts = {}) {
  gl.view = view;
  gl.opts = opts;
  glDraw();
  glDialog.scrollTop = 0;
  const f = opts.focus && glForm.querySelector(opts.focus);
  (f || $('gl-title')).focus();
}

// Go live and Roll back stay off until everything they need is there.
function glSync() {
  const go = $('gl-go');
  if (go) {
    const c = gl.check;
    const ticked = new Set(glTicked());
    go.disabled = !(c && c.ready && c.plan && (c.acks || []).every((a) => ticked.has(a.id)) && glTyped() === c.plan.main);
  }
  const undo = $('gl-undo');
  if (undo) {
    const g = gl.detail.golive;
    undo.disabled = !(glTyped() === g.main_host && (!glNeedsOldHost(g) || glTicked().includes(OLD_HOST.id)));
  }
}

// ---- the dialog's flow ----
function glBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }
// A switch or rollback is running: the tab asks before it closes, and the
// dialog stays open until the answer comes.
function glWorking(text) {
  gl.working = true;
  window.addEventListener('beforeunload', glBeforeUnload);
  glShow('working', { text });
  return ++gl.seq;
}
function glIdle() {
  gl.working = false;
  window.removeEventListener('beforeunload', glBeforeUnload);
}

function glOpen(id, mode, opener, error) {
  const s = id ? byId(id) : null;
  Object.assign(gl, {
    id: s ? id : null, mode, opener: opener || null, check: null, detail: null, pair: null, includePair: true,
    needOldHost: false, verify: null, verifyErr: null, verifying: false, pollUntil: 0, watchUntil: 0,
  });
  gl.seq++;
  $('gl-title').textContent = !s ? 'Go live' : mode === 'rollback' ? 'Roll back ' + s.name : 'Go live: ' + s.name;
  if (!glDialog.open) glDialog.showModal();
  if (error) glSigninFailed(error);
  else if (s) glBegin();
}

// What the person asked for, if the go-live's state still allows it;
// otherwise where it stands.
function glBegin() {
  const s = byId(gl.id);
  if ((gl.mode === 'go' || gl.mode === 'resume') && glCan(s && s.golive).go) glCheck();
  else glLoad({ next: gl.mode === 'rollback' ? 'rollback' : gl.mode === 'check' ? 'verify' : null });
}

async function glCheck({ note, focus } = {}) {
  const my = ++gl.seq;
  glShow('checking');
  let r;
  try { r = await glApi('POST', glPath('check'), { include_pair: gl.includePair }); } catch (e) {
    if (my !== gl.seq) return;
    if (!glRefused(e)) glShow('error', { why: e.message, retry: () => glCheck({ note }) });
    return;
  }
  if (my !== gl.seq) return;
  gl.check = r;
  if (r.plan) gl.pair = glPair(r.plan);
  glShow('checks', { note, focus });
}

// Reads the go-live as it stands and shows it. next: 'rollback' goes on to
// the Roll back step, 'recheck' to a fresh check, 'verify' to the live check,
// when the state allows.
async function glLoad({ note, next } = {}) {
  const my = ++gl.seq;
  glShow('loading');
  let d;
  try { d = await glApi('GET', glPath()); } catch (e) {
    if (my !== gl.seq) return;
    if (!glRefused(e)) glShow('error', { why: e.message, retry: () => glLoad({ note, next }) });
    return;
  }
  glApplySite(d.site);
  if (my !== gl.seq) return;
  gl.detail = { golive: d.golive || null, log: d.log || [] };
  const can = glCan(d.golive);
  if (next === 'rollback' && can.rollback) { gl.needOldHost = false; glShow('rollback'); return; }
  if (next === 'recheck' && can.go) { glCheck({ note }); return; }
  glShowState(next === 'rollback' && !note ? 'Roll back is not possible in this state.' : note);
  // Checking and live rows are checked by glShowState; a stale switch only
  // when asked.
  if (next === 'verify' && can.check && d.golive.stale) glCheckNow();
}

function glShowState(note) {
  const g = gl.detail.golive;
  clearTimeout(gl.pollTimer);
  clearTimeout(gl.watchTimer);
  gl.pollTimer = gl.watchTimer = null;
  gl.watchUntil = 0;
  glShow('state', { note });
  if (glBusy(g)) glWatch();
  else if (g && (g.state === 'checking' || g.state === 'live')) glCheckNow();
}

// Someone's switch or rollback is running (or this tab lost the answer to
// its own): read it again every 5 seconds until it finishes.
function glWatch() {
  gl.watchUntil = gl.watchUntil || Date.now() + GL_POLL_FOR;
  gl.watchTimer = setTimeout(async () => {
    const my = gl.seq;
    let d;
    try { d = await glApi('GET', glPath()); } catch (e) {
      if (my !== gl.seq || glRefused(e)) return;
      if (Date.now() < gl.watchUntil) glWatch();
      return;
    }
    if (my !== gl.seq) return;
    glApplySite(d.site);
    gl.detail = { golive: d.golive || null, log: d.log || [] };
    // A run gone quiet for two minutes is stale, and no longer busy, so a
    // watch always ends well inside its ten minutes.
    if (!glBusy(d.golive)) { glShowState(); return; }
    glDraw();
    if (Date.now() < gl.watchUntil) glWatch();
  }, GL_POLL);
}

// Check now: the live check, then again every 5 seconds until everything
// passes or 10 minutes have gone by.
function glCheckNow() {
  gl.pollUntil = Date.now() + GL_POLL_FOR;
  glVerify();
}
async function glVerify() {
  if (gl.verifying) return;
  clearTimeout(gl.pollTimer);
  gl.pollTimer = null;
  gl.verifying = true;
  gl.verifyErr = null;
  glPaintVerify();
  const my = gl.seq;
  let r, err;
  try { r = await glApi('POST', glPath('verify')); } catch (e) { err = e; }
  if (my !== gl.seq) return;
  gl.verifying = false;
  if (err) {
    if (err.code === 'not-switched') { glLoad({ note: err.message }); return; }
    if (glRefused(err)) return;
    gl.verifyErr = err.message;
    // A stale switch's Check now has no live-check list to show it in.
    if (!$('gl-verify')) { gl.opts.note = 'Could not check: ' + err.message; glDraw(); return; }
  } else {
    glApplySite(r.site);
    gl.verify = { checks: Array.isArray(r.checks) ? r.checks : [], done: !!r.done };
  }
  if (!(gl.verify && gl.verify.done) && Date.now() < gl.pollUntil) gl.pollTimer = setTimeout(glVerify, GL_POLL);
  const was = gl.detail.golive && gl.detail.golive.state;
  if (r && r.golive) gl.detail.golive = r.golive;
  // A stale switch that was checked moves on to checking; a check that
  // passes moves checking on to live. Either way the whole step changes.
  if (r && r.golive && r.golive.state !== was) glDraw(); else glPaintVerify();
}

async function glStart() {
  const c = gl.check;
  const body = { include_pair: gl.includePair, confirm: glTyped(), plan_hash: c.plan_hash, acks: glTicked() };
  const my = glWorking('Switching… Keep this tab open until it finishes.');
  let r, err;
  try { r = await glApi('POST', glPath('start'), body); } catch (e) { err = e; }
  glIdle();
  const d = (err ? err.data : r) || {};
  glApplySite(d.site);
  if (my !== gl.seq) return;
  if (!err || (err.code === 'switch-failed' && d.golive)) {
    gl.detail = { golive: d.golive, log: d.log || [] };
    glShowState();
  } else if (glRefused(err)) {
    // shown
  } else if (err.status === 400) {
    glShow('checks', { err: err.message });
  } else if (err.code === 'plan-changed' || err.code === 'check-first') {
    glLoad({ note: err.code === 'plan-changed' ? PLAN_CHANGED : err.message, next: 'recheck' });
  } else {
    // Busy, a lost connection, or an answer the page does not know: the row
    // says what happened.
    glLoad({ note: err.code === 'network' ? NO_ANSWER : d.reason || err.message });
  }
}

async function glRollback() {
  const body = { confirm: glTyped(), acks: glTicked() };
  const my = glWorking('Rolling back… Keep this tab open until it finishes.');
  let r, err;
  try { r = await glApi('POST', glPath('rollback'), body); } catch (e) { err = e; }
  glIdle();
  const d = (err ? err.data : r) || {};
  glApplySite(d.site);
  if (my !== gl.seq) return;
  if (!err || (err.code === 'rollback-failed' && d.golive)) {
    gl.detail = { golive: d.golive, log: d.log || [] };
    glShowState();
  } else if (glRefused(err)) {
    // shown
  } else if (err.status === 400) {
    // Past seven days while the dialog was open, the Worker asks for the
    // old-host ack the dialog did not show.
    if (err.code === 'acks-missing') gl.needOldHost = true;
    glShow('rollback', { err: err.message });
  } else {
    glLoad({ note: err.code === 'network' ? NO_ANSWER : d.reason || err.message });
  }
}

function glSignIn() {
  try {
    sessionStorage.setItem(GL_STORE, JSON.stringify({ id: gl.id, mode: gl.mode, at: Date.now() }));
  } catch { /* the address the Worker sends back carries the id as well */ }
  // A navigation, not a form: the page's CSP (form-action 'self') would block
  // the redirect to the Access login page.
  location.assign('/api/golive/signin?site=' + encodeURIComponent(gl.id));
}

// The Worker sends a refused Access login back as #golive-error=<code>.
function glSigninFailed(code) {
  const retry = gl.id ? glBegin : null;
  if (code === 'golive-not-set-up') glShow('not-set-up');
  else if (code === 'access-not-protecting') glShow('access-not-protecting');
  else if (code === 'not-allowed') glShow('not-allowed');
  else if (code === 'access-invalid' && gl.id) glShow('signin', { why: 'Cloudflare Access did not accept that login. Sign in again.' });
  else if (code === 'access-keys-unavailable') {
    glShow('error', { why: 'Could not fetch the Cloudflare Access signing keys, so the desk cannot check who you are. Try again in a minute.', retry });
  } else glShow('error', { why: `Signing in with Cloudflare Access did not work (${code}).`, retry });
}

// Back from the Access login: the Worker sent the browser to /#golive=<id>
// (or #golive-error=<code>). sessionStorage remembers the site and what was
// asked, in case the address lost them. Read once, then forgotten.
function glFromUrl() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(GL_STORE) || 'null');
    sessionStorage.removeItem(GL_STORE);
  } catch { /* storage blocked: the address is enough */ }
  if (!saved || typeof saved.id !== 'string' || !GL_ID.test(saved.id) || !(Date.now() - saved.at < 10 * 60 * 1000)) saved = null;
  if (saved && !['go', 'rollback', 'check', 'resume'].includes(saved.mode)) saved.mode = 'resume';
  let m = /^#golive=([0-9a-f-]{36})$/.exec(location.hash);
  if (m) return { id: m[1], mode: saved && saved.id === m[1] ? saved.mode : 'resume' };
  m = /^#golive-error=([a-z0-9-]{1,40})$/.exec(location.hash);
  if (m) return { id: saved && saved.id, mode: 'resume', error: m[1] };
  return saved && { id: saved.id, mode: saved.mode };
}
let glPending = glFromUrl();

// Once the list has loaded: open that row, then the dialog.
function glTakePending() {
  if (!glPending) return;
  const { id, mode, error } = glPending;
  glPending = null;
  if (/^#golive/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  const s = id && byId(id);
  let opener = null;
  if (s) {
    if (!matches(s)) clearFilters(false);
    renderGrid(id);
    const card = grid.querySelector(`.site[data-id="${CSS.escape(id)}"]`);
    if (card) { snapTo(card); opener = card.querySelector('[data-golive]') || card.querySelector('.nm'); }
  }
  if (s || error) glOpen(s ? id : null, mode, opener, error);
}

glForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const go = $('gl-go');
  const undo = $('gl-undo');
  if (gl.view === 'checks' && go && !go.disabled) glStart();
  else if (gl.view === 'rollback' && undo && !undo.disabled) glRollback();
});
glForm.addEventListener('input', glSync);
glForm.addEventListener('change', (e) => {
  if (e.target.id !== 'gl-pair') { glSync(); return; }
  gl.includePair = e.target.checked;
  glCheck({ focus: '#gl-pair' });
});
glForm.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'close') glDialog.close();
  else if (act === 'signin') glSignIn();
  else if (act === 'check') glCheck();
  else if (act === 'verify') glCheckNow();
  else if (act === 'rollback') glLoad({ next: 'rollback' });
  else if (act === 'retry' && gl.opts.retry) gl.opts.retry();
  else if (act === 'copy') copy(b, $('gl-rec').textContent, $('gl-rec'));
});
glDialog.addEventListener('cancel', (e) => { if (gl.working) e.preventDefault(); });
glDialog.addEventListener('click', (e) => { if (e.target === glDialog && !gl.working) glDialog.close(); });
glDialog.addEventListener('close', () => {
  // Escape pressed twice can close a dialog whatever the page says. A
  // switch is still running, so it comes straight back.
  if (gl.working) { glDialog.showModal(); return; }
  gl.seq++;
  clearTimeout(gl.pollTimer);
  clearTimeout(gl.watchTimer);
  gl.pollTimer = gl.watchTimer = null;
  gl.verifying = false;
  const card = gl.id && grid.querySelector(`.site[data-id="${CSS.escape(gl.id)}"]`);
  const back = gl.opener && gl.opener.isConnected ? gl.opener
    : card && (card.querySelector(`[data-golive="${gl.mode}"]`) || card.querySelector('[data-golive]') || card.querySelector('.nm'));
  if (back) back.focus();
});

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
  const g = t.closest('[data-golive]');
  if (g) { glOpen(id, g.dataset.golive, g); return; }
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
const GATE_MSG = {
  'no-key-configured': 'This desk has no key set yet, so nobody can open it. Set DASH_KEY on the Worker (see the README), then enter it here.',
  'bad-key': 'That is not the desk key. Check it and try again.',
  'stale-session': 'The desk key has changed since this browser logged in. Enter the new key.',
};
// `why` is the Locked error from the API, or nothing after Log off.
function lock(why) {
  loaded = false;
  sites = [];
  grid.innerHTML = '';
  $('tools').hidden = true;
  $('logoff').hidden = true;
  note.textContent = '';
  dock.hidden = true;
  renderStats();
  $('gatemsg').textContent = (why && GATE_MSG[why.code])
    || 'Enter the desk key to see the list. This browser stays logged in until you log off.';
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
  load();
});
$('logoff').addEventListener('click', async () => {
  try { await api('DELETE', '/api/session'); } catch (ex) {
    if (!(ex instanceof Locked)) { note.textContent = ex.message; return; }
  }
  lock(null);
});

// Before the login cookie, the key sat in localStorage. A browser that still
// has it logs in with it once, so nobody is asked again, and then drops it.
async function adoptSavedKey() {
  const old = readStore(KEY_STORE);
  if (!old) return;
  try {
    await api('POST', '/api/session', { key: old });
    writeStore(KEY_STORE, '');
  } catch (ex) {
    if (ex instanceof Locked) writeStore(KEY_STORE, '');   // a wrong key is no use; a network error might be
  }
}

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
    $('logoff').hidden = false;
    if (first || changed) renderGrid();
    glTakePending();
  } catch (e) {
    if (e instanceof Locked) { lock(e); return; }
    if (quiet) return;
    note.innerHTML = esc(e.message) + ' <button class="linkbtn" type="button" id="retry">Try again</button>';
    $('retry').addEventListener('click', () => load());
  }
}

// Coming back to the tab picks up what teammates changed meanwhile — unless
// something is being typed, which a redraw would throw away, or a go-live is
// open, which keeps its own row up to date.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && loaded && !editor.open && !glDialog.open) load({ quiet: true });
});

$('host').textContent = location.host || 'website desk';
const savedSort = readStore(SORT_STORE);
if (savedSort && SORTS[savedSort]) { sort = savedSort; $('f-sort').value = sort; }
adoptSavedKey().then(() => load());
