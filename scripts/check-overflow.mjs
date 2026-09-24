#!/usr/bin/env node
// Fails the run (exit 1) if the desk scrolls sideways, in any state, at any
// width, or if any element's content spills out of its own box.
//
// What it measures is what ships: public/ served by the real Worker under
// `wrangler dev` — the same code path as production, not a copy — with its
// own throwaway database, filled with the awkward content people did not
// think of (unbroken 80-character names, 250-character URLs, a long repo, a
// notes field that is one pasted link). The desk has no build step, so
// public/ is the artifact.
//
//   npm run check:overflow                  local Worker + stress data
//   DESK_URL=https://website.10xid.com \
//   DESK_KEY=... npm run check:overflow     a deployed desk, read-only: it
//                                           measures what is there and writes
//                                           nothing
//
// Optional: CHROMIUM_PATH (a browser to use instead of Playwright's own),
// CHROMIUM_ARGS (extra launch flags), ALLOW_FALLBACK_FONTS=1 (measure even if
// the web fonts did not load — otherwise that fails, because fallback fonts
// have different widths and a pass measured with them proves nothing).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const WIDTHS = [320, 360, 390, 402, 430, 768, 1024, 1440, 3440];
const LIVE = process.env.DESK_URL ? process.env.DESK_URL.replace(/\/+$/, '') : null;
const KEY = LIVE ? process.env.DESK_KEY : 'overflow-check-key';
if (LIVE && !KEY) { console.error('DESK_URL needs DESK_KEY as well.'); process.exit(2); }

// The content nobody types in a demo. Every field at or near its limit, in
// the shapes that break layouts: one unbroken word, a URL, a path, CJK, and a
// site with nothing filled in at all.
const STRESS = [
  { name: 'Supercalifragilisticexpialidocious-Renovations-and-Custom-Millwork-Incorporated-Toronto',
    live_domain: 'averyveryveryverylongsubdomainlabelthatgoesonandonandon.example-long-domain-name-for-testing.com',
    staging_domain: 'staging.example.com/id/some/very/long/path/that/keeps/going/and/going/without/any/spaces/at/all',
    github_repo: 'a-very-long-organisation-name-here/an-extremely-long-repository-name-for-a-client-website-2026',
    live_platform: 'wordpress', astro_staging: false, domain_ours: false, needs_seo_ppc: true,
    notes: 'https://www.example.com/a/really/long/link/that/somebody/pasted/straight/into/the/notes/field/without/any/spaces/because/that/is/what/people/do/?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-2026-launch-campaign-for-the-client\n\nSecond paragraph after a blank line.' },
  { name: 'The Very Long Named International Association of Professional Landscape Architects & Designers of Ontario',
    live_domain: 'landscape-architects-and-designers-association-of-ontario.example.ca',
    live_platform: 'astro', astro_staging: true, domain_ours: true, needs_seo_ppc: false,
    notes: 'Ordinary notes. '.repeat(40).trim() },
  { name: '日本語のクライアント名前テスト株式会社ウェブサイトリニューアルプロジェクト',
    live_domain: 'xn--wgv71a119e.example.jp', live_platform: 'other' },
  { name: 'Nothing Filled In' },
  { name: 'Ok', live_domain: 'ok.example', live_platform: 'none', staging_domain: 'ok.staging.example',
    github_repo: 'o/k', astro_staging: true, domain_ours: true, needs_seo_ppc: true },
];
const LONGEST = STRESS[0].name;

// ---- the local Worker ----
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function startWorker() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'desk-overflow-'));
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1',
    '--persist-to', dir, '--var', `DASH_KEY:${KEY}`, '--var', 'HTTPS_ONLY:off'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/')).ok) return { base, stop }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error('wrangler dev did not start:\n' + log.slice(-2000));
}

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method, headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// ---- the measurement, run inside the page ----
// Page verdict, plus every element whose content is wider than its own box.
// "clipped" is deliberate truncation (overflow hidden + an ellipsis, shown in
// full elsewhere on the page); "spill" is everything else, and fails.
function measure() {
  const vw = document.documentElement.clientWidth;
  const describe = (n) => {
    const cls = [...n.classList].slice(0, 2).map((c) => '.' + c).join('');
    const parent = n.parentElement && n.parentElement.classList[0] ? n.parentElement.classList[0] + ' > ' : '';
    return parent + n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + cls;
  };
  const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const spill = [];
  const clipped = [];
  for (const n of document.querySelectorAll('body *')) {
    if (n.closest('.sr')) continue;                        // visually hidden on purpose
    if (n.matches('input, textarea')) continue;            // text boxes scroll their own text
    const r = n.getBoundingClientRect();
    if (!r.width) continue;                                // not rendered
    const cs = getComputedStyle(n);
    if (n.matches('select')) {
      // A native select clips its label without telling scrollWidth. Measure
      // the label against the room the select actually gives it.
      const ctx = (measure.c ||= document.createElement('canvas')).getContext('2d');
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const label = n.selectedOptions[0] ? n.selectedOptions[0].textContent : '';
      const room = n.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const over = Math.ceil(ctx.measureText(label).width - room);
      if (over > 1) spill.push({ el: describe(n), over, text: label, why: 'select label clipped' });
      continue;
    }
    const over = n.scrollWidth - n.clientWidth;
    if (over <= 1 || !n.clientWidth) continue;
    const entry = { el: describe(n), over, text: text(n) };
    const hides = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    if (hides && cs.textOverflow === 'ellipsis') clipped.push(entry);
    else spill.push({ ...entry, why: hides ? 'hidden without an ellipsis' : `overflow-x:${cs.overflowX}` });
  }
  // A family counts as loaded if any of its faces is. (fonts.check() is the
  // wrong test: it is false for any weight the current screen never drew.)
  const loaded = (fam) => [...document.fonts].some((f) => f.family.replace(/"/g, '') === fam && f.status === 'loaded');
  return {
    pageOver: document.documentElement.scrollWidth - vw,
    spill, clipped,
    fonts: loaded('Bricolage Grotesque') && loaded('Instrument Sans'),
  };
}

// ---- the states a person can put the page in ----
async function gotoDesk(page, base, withKey) {
  await page.goto(base + '/');
  await page.evaluate((k) => { try { if (k) localStorage.setItem('webdesk.key', k); else localStorage.clear(); } catch {} }, withKey ? KEY : null);
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('note').textContent) || !document.getElementById('gate').hidden);
}
const settle = (page) => page.waitForTimeout(450);   // the row's snap-scroll and the dock's slide

function statesFor(base, siteNames) {
  const S = [];
  S.push(['locked', async (p) => { await gotoDesk(p, base, false); await p.waitForSelector('#gate:not([hidden])'); }]);
  S.push(['404', async (p) => { await p.goto(base + '/no-such-page'); await p.evaluate(() => document.fonts.ready); }]);
  if (!siteNames.length) {
    S.push(['empty desk', async (p) => { await gotoDesk(p, base, true); await p.waitForSelector('.empty'); }]);
  } else {
    S.push(['list', async (p) => { await gotoDesk(p, base, true); await p.waitForSelector('.site'); }]);
    for (const name of siteNames) {
      S.push([`open: ${name.slice(0, 28)}`, async (p) => {
        await gotoDesk(p, base, true);
        await p.locator('.site', { hasText: name }).first().locator('.nm').click();
        await settle(p);
      }]);
    }
    S.push(['no match', async (p) => {
      await gotoDesk(p, base, true);
      await p.fill('#f-q', 'zzzz-no-such-site-zzzz');
      await p.waitForSelector('.empty');
    }]);
  }
  S.push(['longest filter labels', async (p) => {
    await gotoDesk(p, base, true);
    await p.selectOption('#f-sort', 'updated');
    await p.selectOption('#f-seo', 'no');
    await p.selectOption('#f-staging', 'unset');
    await p.selectOption('#f-platform', 'wordpress');
    await p.selectOption('#f-domain', 'no');
    await settle(p);
  }]);
  S.push(['add dialog', async (p) => { await gotoDesk(p, base, true); await p.click('#add'); await settle(p); }]);
  if (siteNames.length) {
    const target = siteNames.includes(LONGEST) ? LONGEST : siteNames[0];
    S.push(['edit dialog', async (p) => {
      await gotoDesk(p, base, true);
      const card = p.locator('.site', { hasText: target }).first();
      await card.locator('.nm').click();
      await card.locator('.btn.edit').click();
      await settle(p);
    }]);
    S.push(['delete armed', async (p) => {
      await gotoDesk(p, base, true);
      const card = p.locator('.site', { hasText: target }).first();
      await card.locator('.nm').click();
      await settle(p);
      await card.locator('.btn.del').click();   // first tap only arms it; nothing is deleted
    }]);
  }
  if (!LIVE) {
    // These two send writes, so they run against the local Worker only.
    S.push(['edit error', async (p) => {
      await gotoDesk(p, base, true);
      const card = p.locator('.site', { hasText: LONGEST }).first();
      await card.locator('.nm').click();
      await card.locator('.btn.edit').click();
      await p.fill('input[name=github_repo]', 'not a repo');
      await p.click('#ed-save');
      await p.waitForSelector('#ederr:not([hidden])');
    }]);
    S.push(['edit conflict', async (p) => {
      await gotoDesk(p, base, true);
      const card = p.locator('.site', { hasText: LONGEST }).first();
      await card.locator('.nm').click();
      await card.locator('.btn.edit').click();
      const { sites } = await api(base, 'GET', '/api/sites');
      const row = sites.find((s) => s.name === LONGEST);
      await api(base, 'PATCH', '/api/sites/' + row.id, { notes: row.notes + ' (teammate)', name: row.name + '-2' });
      await p.fill('input[name=name]', LONGEST + '-3');
      await p.fill('textarea[name=notes]', 'mine');
      await p.click('#ed-save');
      await p.waitForSelector('#ederr:not([hidden])');
      // put the row back, so later widths start from the same data
      const now = (await api(base, 'GET', '/api/sites')).sites.find((s) => s.id === row.id);
      await api(base, 'PATCH', '/api/sites/' + row.id, { name: row.name, notes: row.notes, expected_updated_at: now.updated_at });
    }]);
  }
  return S;
}

// ---- run ----
let worker = null;
let failed = false;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: (process.env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean),
});
try {
  let base = LIVE;
  if (!LIVE) {
    worker = await startWorker();
    base = worker.base;
    for (const s of STRESS) await api(base, 'POST', '/api/sites', s);
  }
  const siteNames = (await api(base, 'GET', '/api/sites')).sites.map((s) => s.name);
  console.log(`Measuring ${LIVE || 'the local Worker with stress data'}: ${siteNames.length} site(s), ${WIDTHS.length} widths.\n`);

  const states = statesFor(base, siteNames);
  const clippedSeen = new Map();
  let fontsMissing = false;
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    for (const [name, enter] of states) {
      await enter(page);
      // Measure the layout at rest. A transition caught mid-way (the row's
      // chevron turning, the dock sliding in) has a passing bounding box that
      // is not a layout fault.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      const r = await page.evaluate(measure);
      if (!r.fonts) fontsMissing = true;
      r.clipped.forEach((c) => clippedSeen.set(c.el, c));
      const bad = r.pageOver > 1 || r.spill.length;
      if (bad) failed = true;
      const verdict = r.pageOver > 1 ? `WANDERS by ${r.pageOver}px` : r.spill.length ? 'spills' : 'ok';
      if (bad || process.env.VERBOSE) {
        console.log(`${String(width).padStart(5)}  ${name.padEnd(40)} ${verdict}`);
        for (const s of r.spill.slice(0, 6)) console.log(`         ${s.el} over by ${s.over}px (${s.why}) "${s.text}"`);
      }
    }
    await ctx.close();
    console.log(`${String(width).padStart(5)}  measured ${states.length} states`);
  }
  if (clippedSeen.size) {
    console.log('\nDeliberately truncated with an ellipsis (shown in full elsewhere; not a failure):');
    for (const c of clippedSeen.values()) console.log(`   ${c.el}`);
  }
  if (fontsMissing) {
    console.log('\nThe web fonts did not load, so the widths above are fallback-font widths.');
    if (!process.env.ALLOW_FALLBACK_FONTS) failed = true;
  }
  console.log(failed ? '\nFAIL: the desk overflows (see above).' : '\nPASS: nothing scrolls sideways and nothing spills, in any state, at any width.');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  if (worker) worker.stop();
}
process.exit(failed ? 1 : 0);
