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
import { goliveSummary } from '../src/golive-store.js';

// Widths up to this one are measured as a touch-screen phone.
const PHONE = 430;
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
    chat_url: 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUv',
    environment: 'backblaze-theteslawrapshop-media-and-a-much-longer-environment-name-for-testing',
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
    github_repo: 'o/k', chat_url: 'claude.ai/code/session_01Ok', environment: 'backblaze/CF', astro_staging: true, domain_ours: true, needs_seo_ppc: true },
];
const LONGEST = STRESS[0].name;

// ---- going live, answered with canned JSON ----
// The Go live dialog and the row's Go live section show what Cloudflare,
// the staging site and public DNS said, which a layout check cannot (and
// must not) set up. So these states answer /api/golive/** here, with JSON
// shaped as src/golive-routes.js answers, and add a go-live summary to one
// row of the real GET /api/sites answer. No go-live request reaches the
// Worker, so these states write nothing, locally or on a deployed desk.
// The content is as awkward as the rows': hostnames of 100 characters, the
// longest Worker name Cloudflare allows, and Cloudflare's own long errors.
const GL_ZONE = 'supercalifragilisticexpialidocious-renovations-and-millwork.toronto-custom-homes-and-cottages.ca';
const GL_MAIN = 'www.' + GL_ZONE;   // 100 characters
const GL_STAGING = 'staging.' + GL_ZONE;
const GL_WORKER = 'staging-supercalifragilisticexpialidocious-renovations-millwork';   // 63, the most allowed
const GL_OLD_WORKER = 'supercalifragilisticexpialidocious-renovations-and-millwork-web';
const GL_ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';
const GL_EMAIL = 'alexandra.konstantinopoulou-vandenberghe@supercalifragilistic-renovations.example.com';
const GL_CNAME = 'client-website-production-origin-load-balancer-1234567890.ca-central-1.elb.amazonaws.example-hosting.com';
const GL_ATTACH_ERROR = `Hostname '${GL_MAIN}' already has externally managed DNS records (A, CNAME, etc). Either delete them, `
  + "try a different hostname, or use the option 'override_existing_dns_record' to override. [code: 100117]";
const GL_RULE_ERROR = 'exceeded the maximum number of rules in the phase http_request_dynamic_redirect: 10 out of 10 '
  + `(/zones/${GL_ZONE_ID}/rulesets/phases/http_request_dynamic_redirect/entrypoint) [code: 20217]`;
const GL_MX_TXT = [
  { type: 'MX', name: GL_ZONE, content: 'mx-primary.mail-protection.outlook-hosted-exchange-for-small-business.example.net', priority: 0 },
  { type: 'MX', name: GL_ZONE, content: 'alt1.aspmx.l.google.example.com', priority: 10 },
  { type: 'TXT', name: GL_ZONE, content: 'v=spf1 a mx include:_spf.google.com include:spf.protection.outlook.com ip4:192.0.2.10 ~all', priority: null },
  { type: 'TXT', name: GL_ZONE, content: 'google-site-verification=rXOxyZounnZasA8Z7oaD3c14JdjS9aKSWvsR1EbUSIQ', priority: null },
];
const GL_HOSTS = [{ hostname: GL_MAIN, role: 'main' }, { hostname: GL_ZONE, role: 'redirect' }];
// Both hosts on the staging Worker, with the record Cloudflare made for each.
const GL_ATTACHED = GL_HOSTS.map((h, i) => ({
  id: 'f1e2d3c4b5a6978899aabbccddeeff00112233' + i, hostname: h.hostname, dns_id: GL_ZONE_ID.slice(0, -1) + (5 + i),
}));
const GL_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// A DNS record as Cloudflare lists it, and as golive.js writes one out.
function glRecord(n, type, name, content, proxied, ttl) {
  return {
    id: GL_ZONE_ID.slice(0, -1) + n, type, name, content, proxied, ttl, comment: null, tags: [], settings: {},
    meta: {}, proxiable: true, created_on: '2019-03-14T09:26:53.589793Z', modified_on: '2024-11-02T17:41:08.123456Z',
  };
}
const recordText = (r) => `${r.type} ${r.name} → ${r.content} (${r.proxied ? 'proxied' : 'DNS only'}, ${r.ttl === 1 ? 'TTL auto' : 'TTL ' + r.ttl})`;
const mxTxtText = (x) => (x.type === 'MX' ? `MX ${x.priority} ${x.content}` : `TXT ${x.content}`);
const ck = (id, label, status, detail, items) => (items ? { id, label, status, detail, items } : { id, label, status, detail });

// A plan. `moved`: the apex is a Custom Domain on another Worker today, so
// only www has records to delete and the apex moves Worker to Worker.
function glPlan(id, moved) {
  const www = glRecord(1, 'CNAME', GL_MAIN, GL_CNAME, true, 1);
  const apex = [
    glRecord(2, 'A', GL_ZONE, '192.0.2.10', false, 3600),
    glRecord(3, 'A', GL_ZONE, '198.51.100.200', false, 3600),
    glRecord(4, 'AAAA', GL_ZONE, '2001:0db8:85a3:0000:0000:8a2e:0370:7334', false, 3600),
  ];
  return {
    site_id: id, zone: { id: GL_ZONE_ID, name: GL_ZONE, plan: 'pro' }, worker: GL_WORKER, staging_host: GL_STAGING,
    main: GL_MAIN, hosts: GL_HOSTS,
    delete_records: moved ? [www] : [www, ...apex],
    saved_domains: moved ? [{ id: 'a4b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9', hostname: GL_ZONE, service: GL_OLD_WORKER }] : [],
    redirect: { from: GL_ZONE, to: GL_MAIN, ref: 'desk-' + id },
    mx_txt: GL_MX_TXT,
  };
}

const glAcks = (repo) => [
  { id: 'gate12', label: `Gate 12 is approved in sites/${GL_ZONE}.md` },
  { id: 'wrangler', label: `I have checked ${repo || 'the repo'}’s wrangler config (routes and custom domains)` },
  { id: 'friday', label: 'It is Friday and this cannot wait' },
];

function wranglerDetail(repo, moved) {
  return `A Workers Builds deploy replaces ${GL_WORKER}'s Custom Domains with the list in the repo's wrangler config. `
    + `If ${repo || 'the repo'}'s wrangler.jsonc has a routes key, add ${GL_MAIN} and ${GL_ZONE} to it with custom_domain: true `
    + 'and push that BEFORE anything else is deployed. After a Roll back, take them out again.'
    + (moved ? ` Also disconnect Workers Builds on ${GL_OLD_WORKER}, or remove ${GL_ZONE} from ${GL_OLD_WORKER}'s wrangler config, `
      + `or ${GL_OLD_WORKER}'s next build takes ${GL_ZONE} back.` : '');
}

// POST /api/golive/:id/check. Ready: every check passes or warns, with
// every acknowledgement a Friday asks for. Not ready: most of them fail,
// with Cloudflare's errors and lists of items.
function glCheckAnswer(site, ready) {
  const plan = glPlan(site.id, !ready);
  const moves = `Moves ${GL_MAIN} and ${GL_ZONE} to ${GL_WORKER}; ${GL_ZONE} redirects to ${GL_MAIN}.`;
  const common = [
    ck('addresses', 'Live and staging addresses', 'pass', `${GL_MAIN} goes live from ${GL_STAGING}.`),
    ck('zone', 'Zone on Cloudflare', 'pass', `${GL_ZONE} is active on our account (pro plan).`),
    ck('worker', 'Staging Worker', 'pass', `${GL_STAGING} runs on the Worker ${GL_WORKER}.`),
  ];
  const mxTxt = ck('mx-txt', 'MX and TXT records', 'pass',
    '2 MX records and 2 TXT records. The desk never touches them and checks them again afterwards.', GL_MX_TXT.map(mxTxtText));
  const tail = [
    ck('wrangler', 'Wrangler config', 'warn', wranglerDetail(site.github_repo, !ready)),
    ck('staging-stays', 'Staging address', 'warn',
      `${GL_STAGING} stays on ${GL_WORKER} and, without noindex, is a second copy of the live site. Detach it, or keep it deliberately (gate 10).`),
    ck('staging', 'Staging page', 'pass', `https://${GL_STAGING}/ answers with a page.`),
  ];
  const checks = ready ? [
    ...common,
    ck('hosts', 'Hostnames to move', 'pass', moves),
    ck('records', 'DNS records to delete', 'pass', 'Deletes 4 records, saved first so Roll back can put them back exactly.',
      plan.delete_records.map(recordText)),
    ck('mail', 'Mail', 'warn', `These names point at ${GL_ZONE} and will follow it to the new site: mail.${GL_ZONE}, ftp.${GL_ZONE} and cpanel.${GL_ZONE}. `
      + "If they are used for mail, FTP or cPanel, point them at the server's own address first. "
      + `SPF allows mail from ${GL_ZONE}'s own address (a). After the switch that address is Cloudflare's, so mail sent from `
      + '192.0.2.10 and 198.51.100.200 would fail SPF. Add ip4:198.51.100.200 to the SPF record first.',
    [`mail.${GL_ZONE} → ${GL_ZONE}`, `ftp.${GL_ZONE} → ${GL_ZONE}`, `cpanel.${GL_ZONE} → ${GL_ZONE}`]),
    mxTxt,
    ck('routes', 'Worker routes', 'pass', `No Worker route covers ${GL_MAIN} or ${GL_ZONE}.`),
    ck('ssl', 'SSL/TLS mode', 'warn',
      `SSL/TLS mode is Strict (SSL-Only Origin Pull). Gate 13 keeps it Full for img.${GL_ZONE}; the desk does not change it.`),
    ck('redirects', 'Redirect rules', 'warn', "Redirect rule 'Old WordPress campaign landing pages from the autumn 2024 flyer to the new site' "
      + `also matches ${GL_ZONE} and may answer before the desk's rule. Will add a 301 from ${GL_ZONE} to ${GL_MAIN}.`),
    ...tail,
    ck('noindex', 'Search engines', 'pass', 'Staging lets search engines index it.'),
    ck('canonical', 'Canonical address', 'warn',
      `Staging's home page names no canonical address. Set site: 'https://${GL_MAIN}' in the Astro config so every page names one.`),
    ck('old-files', 'Files from the old site', 'pass', 'Checked the home page; gate 19 checks every page.'),
    ck('robots', 'robots.txt', 'pass', "Staging's robots.txt lets crawlers in."),
    ck('nameservers', 'Nameservers', 'pass',
      `dns.google and cloudflare-dns.com both give ${GL_ZONE} the nameservers Cloudflare assigned (adaline.ns.cloudflare.com, maximilian.ns.cloudflare.com).`),
    ck('friday', 'Friday', 'warn', 'It is Friday. Gate 13 says not on a Friday.'),
  ] : [
    ...common,
    ck('hosts', 'Hostnames to move', 'pass', moves, [`${GL_ZONE} moves from ${GL_OLD_WORKER} to ${GL_WORKER}`]),
    ck('records', 'DNS records to delete', 'pass', 'Deletes 1 record, saved first so Roll back can put them back exactly.',
      [recordText(plan.delete_records[0]), `No record to delete on ${GL_ZONE}: it is a Custom Domain on another Worker.`]),
    ck('mail', 'Mail', 'fail', `Mail for ${GL_ZONE} is delivered to ${GL_MAIN}, which moves onto the Worker. `
      + "Moving it would stop the client's email. Point the MX at the mail server's own name (with its own DNS-only A record) first.",
    [`MX ${GL_ZONE} → ${GL_MAIN}`]),
    mxTxt,
    ck('routes', 'Worker routes', 'fail', `Worker route *${GL_ZONE}/* (Worker ${GL_OLD_WORKER}) runs in front of a Custom Domain, `
      + `so ${GL_MAIN} would keep showing that Worker. Remove the route first.`, [`*${GL_ZONE}/* → ${GL_OLD_WORKER}`]),
    ck('ssl', 'SSL/TLS mode', 'warn', 'Could not read the SSL/TLS mode. Cloudflare said: Authentication error '
      + `(/zones/${GL_ZONE_ID}/settings/ssl) [code: 10000]. The API token may be missing a permission; see the README.`),
    ck('redirects', 'Redirect rules', 'fail', `Cloudflare said: ${GL_RULE_ERROR}.`),
    ...tail,
    ck('noindex', 'Search engines', 'fail', 'Staging still tells search engines not to index it, and the live site would inherit that. '
      + `Delete the X-Robots-Tag block in public/_headers (in ${site.github_repo || 'the repo'}), push, wait for the build, then check again.`),
    ck('canonical', 'Canonical address', 'fail', `Staging's pages name ${GL_STAGING} as their canonical address. `
      + `Set site: 'https://${GL_MAIN}' in the Astro config first, or search engines will index ${GL_STAGING} instead of ${GL_MAIN}.`),
    ck('old-files', 'Files from the old site', 'fail', 'Staging\'s home page loads 5 files from the old site (WordPress paths, '
      + `or ${GL_MAIN} or ${GL_ZONE}), which break when the old site goes. Point them at the new site's own files first.`, [
      `https://${GL_MAIN}/wp-content/uploads/2019/03/kitchen-renovation-hero-image-final-final-v3-exported-from-photoshop-2560x1440.jpg`,
      `https://${GL_MAIN}/wp-content/themes/custom-millwork-child-theme-2019/assets/css/main.min.css?ver=5.8.3`,
      `https://${GL_ZONE}/wp-includes/js/jquery/jquery.min.js?ver=3.6.0`,
      `https://${GL_ZONE}/wp-content/uploads/2021/11/favicon-192x192.png`,
      `https://${GL_MAIN}/wp-content/plugins/elementor/assets/lib/font-awesome/webfonts/fa-solid-900.woff2`,
    ]),
    ck('robots', 'robots.txt', 'fail', "Staging's robots.txt blocks every crawler (Disallow: /). The live site would inherit it."),
    ck('nameservers', 'Nameservers', 'fail', `Public DNS says ${GL_ZONE}'s nameservers are ns1.old-registrar-parking-nameservers.example.net, `
      + 'ns2.old-registrar-parking-nameservers.example.net, not the ones Cloudflare assigned (adaline.ns.cloudflare.com, '
      + 'maximilian.ns.cloudflare.com). The desk would change records nobody reads.', [
      'dns.google: ns1.old-registrar-parking-nameservers.example.net, ns2.old-registrar-parking-nameservers.example.net',
      'cloudflare-dns.com: ns1.old-registrar-parking-nameservers.example.net, ns2.old-registrar-parking-nameservers.example.net',
    ]),
    ck('other-worker', 'Secrets', 'warn', `${GL_OLD_WORKER} has secrets RESEND_API_KEY, TURNSTILE_SECRET_KEY and `
      + `STRIPE_WEBHOOK_SIGNING_SECRET_FOR_BOOKINGS that ${GL_WORKER} does not. Add them to ${GL_WORKER} first, or the forms stop working.`),
  ];
  return { checks, plan, plan_hash: GL_HASH, ready, acks: glAcks(site.github_repo) };
}

// A go-live row as GET /api/golive/:id has it: every column, JSON parsed.
function glRow(id, moved, fields) {
  const plan = glPlan(id, moved);
  return {
    site_id: id, state: 'checking', zone_id: GL_ZONE_ID, zone_name: GL_ZONE, worker: GL_WORKER, staging_host: GL_STAGING,
    main_host: GL_MAIN, hosts: plan.hosts, saved_records: plan.delete_records, saved_domains: plan.saved_domains,
    redirect: plan.redirect, redirect_rule: null, attached: [], steps_done: [], mx_txt: GL_MX_TXT,
    previous_platform: 'wordpress', restored: null, checks: null, notes: null, error: null,
    acks: glAcks(null).slice(0, 2), started_by: GL_EMAIL, started_at: ago(3 * MINUTE), switched_at: null, verified_at: null,
    rolled_back_by: null, rolled_back_at: null, updated_at: ago(2 * MINUTE), stale: false, ...fields,
  };
}

// What each site carries in the list, made by the store's own function, so
// the row section always gets the shape the Worker sends.
const glSummary = (row) => goliveSummary(row, new Date().toISOString());

// The log of a run, oldest first: one entry per step, as the store keeps it.
function glLog(entries) {
  const start = Date.now() - entries.length * 4000;
  return entries.map(([action, text], i) => ({
    seq: 101 + i, at: new Date(start + i * 4000).toISOString(), who: GL_EMAIL, action, text, detail: null,
  }));
}
const switchStarted = (moved) => ['switch-started', `${GL_EMAIL} started switching ${GL_MAIN} and ${GL_ZONE} to ${GL_WORKER}. `
  + `Saved first, so Roll back can put them back: ${moved ? '1 DNS record and 1 Custom Domain on another Worker' : '4 DNS records'}.`];

// A switch that worked, but whose redirect rule Cloudflare refused.
function glSwitched(id) {
  const plan = glPlan(id, false);
  const row = glRow(id, false, {
    switched_at: ago(0), updated_at: ago(0), attached: GL_ATTACHED, error: GL_RULE_ERROR,
    steps_done: [...plan.delete_records.map((r) => 'deleted:' + r.id), ...GL_HOSTS.map((h) => 'attached:' + h.hostname)],
  });
  const log = glLog([
    switchStarted(false),
    ...plan.delete_records.map((r) => ['record-deleted', `Deleted ${recordText(r)}. It is saved, so Roll back can put it back.`]),
    ['domain-attached', `Attached ${GL_MAIN} to ${GL_WORKER}.`],
    ['domain-attached', `Attached ${GL_ZONE} to ${GL_WORKER}.`],
    ['worker-records', 'Noted the DNS record Cloudflare made for each host, so a Roll back can wait for it to go.'],
    ['redirect-failed', `Could not add the redirect from ${GL_ZONE} to ${GL_MAIN}. Cloudflare said: ${GL_RULE_ERROR}. `
      + `The site works on both addresses, but ${GL_ZONE} does not redirect yet.`],
    ['switched', `Switched ${GL_MAIN} and ${GL_ZONE} to ${GL_WORKER}. Waiting for HTTPS and public DNS. `
      + `The redirect from ${GL_ZONE} was not added, so it shows the site without redirecting.`],
  ]);
  return { row, log };
}

// A switch that failed and could not put everything back.
function glSwitchFailed(id) {
  const other = 'another-agency-staging-worker-for-the-2027-redesign-project';
  const www = glPlan(id, true).delete_records[0];
  const unput = `Could not put back ${recordText(www)}. `
    + 'Cloudflare said: An A, AAAA, or CNAME record with that host already exists. [code: 81053].';
  const error = `Could not attach ${GL_MAIN} to ${GL_WORKER}. Cloudflare said: ${GL_ATTACH_ERROR}. Not everything was put back: ${unput}`;
  const notes = [
    `${GL_ZONE} is now on ${other}, so the desk left it and did not put its old records back.`,
    `The Advanced Certificate Cloudflare made for ${GL_MAIN} stays on ${GL_ZONE} (Cloudflare does not delete it on detach). `
      + 'It is harmless.',
  ];
  const row = glRow(id, true, { state: 'switch-failed', restored: 0, error, notes, updated_at: ago(0) });
  const log = glLog([
    switchStarted(true),
    ['record-deleted', `Deleted ${recordText(www)}. It is saved, so Roll back can put it back.`],
    ['domain-detached', `Detached ${GL_ZONE} from ${GL_OLD_WORKER}.`],
    ['host-left', notes[0]],
    ['restore-problem', unput],
    ['switch-failed', `The switch failed, and the desk could not put everything back. ${error} Roll back to try again.`],
  ]);
  return { row, log };
}

// Live for twelve days: a Roll back asks whether the old host is still ours.
function glLiveLong(id) {
  const row = glRow(id, true, {
    state: 'live', started_at: ago(12 * DAY + MINUTE), switched_at: ago(12 * DAY), verified_at: ago(12 * DAY - 9 * MINUTE),
    updated_at: ago(3 * DAY), attached: GL_ATTACHED,
    redirect_rule: { ruleset_id: '2f2feab2026849078ba485f918791bdc', rule_id: '3a03d665bac047339bb530ecb439a90d', ref: 'desk-' + id },
    notes: [`The Advanced Certificate Cloudflare made for ${GL_MAIN} stays on ${GL_ZONE} after a Roll back `
      + '(Cloudflare does not delete it on detach). It is harmless.'],
  });
  const log = glLog([
    switchStarted(true),
    ['switched', `Switched ${GL_MAIN} and ${GL_ZONE} to ${GL_WORKER}. Waiting for HTTPS and public DNS.`],
    ['verified', `Verified: ${GL_MAIN} serves the new site from ${GL_WORKER}, and no check failed.`],
  ]);
  return { row, log };
}

// POST /api/golive/:id/verify on a fresh switch: waiting on some checks,
// failing others, so the page keeps polling.
function glVerifyChecks() {
  return [
    ck('https', 'HTTPS', 'wait', `${GL_MAIN} answers HTTP 526 while Cloudflare finishes setting it up. Waiting…`),
    ck('noindex', 'Search engines', 'pass', 'The live site lets search engines index it.'),
    ck('same-site', 'Same build as staging', 'fail', `${GL_MAIN} is not serving the staging build yet.`),
    ck('deep-page', 'A page past the home page', 'pass',
      '/services/kitchen-and-bathroom-renovations-custom-millwork-cabinetry-and-built-ins-across-the-greater-toronto-area/ '
      + `on ${GL_MAIN} answers.`),
    ck('redirect', 'Redirect', 'fail', `The redirect rule was not added: ${GL_RULE_ERROR}. ${GL_ZONE} shows the site without redirecting.`),
    ck('still-attached', 'Custom Domains', 'pass', `${GL_MAIN} and ${GL_ZONE} are attached to ${GL_WORKER}.`),
    ck('public-dns', 'Public DNS', 'wait',
      'Public DNS still returns the old address 192.0.2.10, 198.51.100.200 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334 (cached for up to 3600 s).'),
    ck('mx-txt', 'MX and TXT', 'fail', `MX or TXT at ${GL_ZONE} is not what it was before the switch.`, [
      'Gone: ' + mxTxtText(GL_MX_TXT[2]),
      'New: TXT v=spf1 include:_spf.mailchannels-relay-for-cloudflare-workers.example.net include:_spf.google.com ~all',
      'dns.google gives MX route1.mx.cloudflare.net, route2.mx.cloudflare.net, not alt1.aspmx.l.google.example.com, '
        + 'mx-primary.mail-protection.outlook-hosted-exchange-for-small-business.example.net.',
    ]),
  ];
}

// Installs the canned answers for one state. `golive` is the row the
// target site's summary is made from (null: never switched); `answers`
// maps 'METHOD action' to a function of the site that returns
// { status, json } or { status, headers }, or to HOLD for an answer that
// never comes. Anything else under /api/golive gets a 404, never the
// Worker.
const HOLD = Symbol('hold');
async function mockGoLive(page, target, { golive = null, answers = {} } = {}) {
  let site = target;
  await page.route((u) => u.pathname === '/api/sites', async (route) => {
    const res = await route.fetch();
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !Array.isArray(data.sites)) { await route.fulfill({ response: res }); return; }
    data.sites = data.sites.map((s) => {
      if (s.id !== target.id) return s;
      // Go live needs both addresses; a deployed desk's row may lack them.
      site = {
        ...s, live_domain: s.live_domain || GL_MAIN, staging_domain: s.staging_domain || GL_STAGING, golive: glSummary(golive),
      };
      return site;
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route((u) => u.pathname.startsWith('/api/golive/'), async (route) => {
    const req = route.request();
    const action = new URL(req.url()).pathname.split('/')[4] || '';
    const answer = answers[`${req.method()} ${action}`.trim()];
    if (answer === HOLD) return;
    const { status = 200, json, headers } = answer ? answer(site) : { status: 404, json: { error: 'No canned answer for this state.' } };
    await route.fulfill(json ? { status, json } : { status, headers });
  });
}
// The site as an answer carries it: with the summary of the row it answers.
const withRow = (site, row) => ({ ...site, golive: glSummary(row) });

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
  const touch = matchMedia('(pointer: coarse)').matches;
  for (const n of document.querySelectorAll('body *')) {
    if (n.closest('.sr')) continue;                        // visually hidden on purpose
    // On a touch screen iPhone Safari zooms the page in when a box under
    // 16px is tapped, and the page then pans sideways as it scrolls.
    if (touch && n.matches('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea')
      && n.getBoundingClientRect().width && parseFloat(getComputedStyle(n).fontSize) < 16) {
      spill.push({ el: describe(n), over: 0, text: getComputedStyle(n).fontSize, why: 'under 16px: a phone zooms in on tap' });
    }
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
  await page.context().clearCookies();
  await page.goto(base + '/');
  if (withKey) {
    await page.evaluate((k) => fetch('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }),
    }), KEY);
  }
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('note').textContent) || !document.getElementById('gate').hidden);
}
const settle = (page) => page.waitForTimeout(450);   // the row's snap-scroll and the dock's slide

// The Go live states, on one site's row: its dialog at every step a person
// can reach, and its row section in each state a go-live can be in. Every
// answer is canned (see mockGoLive); `target` is a row of the real list.
function goLiveStates(base, target) {
  const S = [];
  const card = (p) => p.locator(`.site[data-id="${target.id}"]`);
  const say = (p, text) => p.locator('#gl-say', { hasText: text }).waitFor();
  // Opens the row, then presses one of its Go live buttons.
  const press = async (p, act, mock) => {
    await mockGoLive(p, target, mock);
    await gotoDesk(p, base, true);
    await card(p).locator('.nm').click();
    await settle(p);
    await card(p).locator(`[data-golive="${act}"]`).click();
  };
  const refusal = (status, json) => ({ 'POST check': () => ({ status, json }) });
  const ready = (extra = {}) => ({ 'POST check': (s) => ({ json: glCheckAnswer(s, true) }), ...extra });
  // Ticks every acknowledgement and types the address, as a person would.
  const confirm = async (p, button) => {
    await p.locator('#gl-confirm').waitFor();
    for (const box of await p.locator('#gl-body input[name="ack"]').all()) await box.check();
    await p.fill('#gl-confirm', GL_MAIN);
    await p.locator(button + ':not([disabled])').waitFor();
  };

  S.push(['go live: sign in', async (p) => {
    // Cloudflare Access's own answer: a redirect to its login page.
    await press(p, 'go', { answers: { 'POST check': () => ({
      status: 302, headers: { location: 'https://tboxstudio.cloudflareaccess.com/cdn-cgi/access/login/website.10xid.com' },
    }) } });
    await p.locator('#gl-btns [data-act="signin"]').waitFor();
  }]);
  S.push(['go live: not set up', async (p) => {
    await press(p, 'go', { answers: refusal(503, {
      error: 'Going live is not set up on this Worker.', code: 'golive-not-set-up',
      missing: ['GOLIVE_API_TOKEN', 'GOLIVE_ACCOUNT_ID', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'GOLIVE_EMAILS'],
    }) });
    await p.locator('#gl-body .glvals').waitFor();
  }]);
  S.push(['go live: not allowed', async (p) => {
    await press(p, 'go', { answers: refusal(403, {
      error: GL_EMAIL + ' is not on the list of people who can go live.', code: 'not-allowed', email: GL_EMAIL,
    }) });
    await say(p, 'is not on the list');
  }]);
  S.push(['go live: checks fail', async (p) => {
    await press(p, 'go', { answers: { 'POST check': (s) => ({ json: glCheckAnswer(s, false) }) } });
    await p.locator('#gl-body .glck').first().waitFor();
  }]);
  S.push(['go live: checks ready', async (p) => {
    await press(p, 'go', { answers: ready() });
    await confirm(p, '#gl-go');
  }]);
  S.push(['go live: switching', async (p) => {
    await press(p, 'go', { answers: ready({ 'POST start': HOLD }) });
    await confirm(p, '#gl-go');
    await p.click('#gl-go');
    await say(p, 'Switching');
  }]);
  S.push(['go live: switched', async (p) => {
    const { row, log } = glSwitched(target.id);
    await press(p, 'go', { answers: ready({
      'POST start': (s) => ({ json: { site: withRow(s, row), golive: row, log } }),
      'POST verify': (s) => ({ json: { site: withRow(s, row), golive: row, checks: glVerifyChecks(), done: false } }),
    }) });
    await confirm(p, '#gl-go');
    await p.click('#gl-go');
    await p.locator('#gl-verify .glck').first().waitFor();
  }]);
  S.push(['go live: switch failed', async (p) => {
    const { row, log } = glSwitchFailed(target.id);
    await press(p, 'go', { answers: ready({
      'POST start': (s) => ({ status: 502, json: { error: row.error, code: 'switch-failed', site: withRow(s, row), golive: row, log } }),
    }) });
    await confirm(p, '#gl-go');
    await p.click('#gl-go');
    await say(p, 'The switch failed');
  }]);
  // Twelve days live, so Roll back asks about the old host (gate 20).
  const rollback = (extra = {}) => {
    const { row, log } = glLiveLong(target.id);
    const last = {
      site_id: target.id, plan_hash: GL_HASH, include_pair: true, ready: true, acks: glAcks(target.github_repo).slice(0, 2),
      checked_by: GL_EMAIL, checked_at: ago(12 * DAY + 5 * MINUTE),
    };
    return { golive: row, answers: { GET: (s) => ({ json: { site: s, golive: row, log, last_check: last } }), ...extra } };
  };
  S.push(['go live: roll back', async (p) => {
    await press(p, 'rollback', rollback());
    await confirm(p, '#gl-undo');
  }]);
  S.push(['go live: rolled back', async (p) => {
    const { row, log } = glLiveLong(target.id);
    const back = { ...row, state: 'rolled-back', rolled_back_by: GL_EMAIL, rolled_back_at: ago(0), updated_at: ago(0) };
    const more = glLog([
      ['rollback-started', `${GL_EMAIL} started rolling back ${GL_MAIN} and ${GL_ZONE}.`],
      ['redirect-removed', `Removed the redirect rule from ${GL_ZONE} to ${GL_MAIN}.`],
      ['domain-detached', `Detached ${GL_MAIN} from ${GL_WORKER}.`],
      ['record-restored', `Put back ${recordText(row.saved_records[0])}.`],
      ['domain-reattached', `Moved ${GL_ZONE} back to ${GL_OLD_WORKER}.`],
      ['rolled-back', `Rolled back ${GL_MAIN} and ${GL_ZONE}: the old site is back.`],
    ]);
    await press(p, 'rollback', rollback({
      'POST rollback': (s) => ({ json: { site: withRow(s, back), golive: back, log: [...log, ...more] } }),
    }));
    await confirm(p, '#gl-undo');
    await p.click('#gl-undo');
    await say(p, 'Rolled back');
  }]);

  // The row's section: switched and waiting, live, stopped part-way, failed.
  // Each is made when its state runs, so its times are as fresh at 3440px
  // as at 320px.
  const rows = {
    checking: () => glSwitched(target.id).row,
    live: () => glLiveLong(target.id).row,
    stale: () => ({
      ...glSwitched(target.id).row, state: 'switching', switched_at: null, error: null, updated_at: ago(9 * MINUTE), stale: true,
    }),
    failed: () => glSwitchFailed(target.id).row,
  };
  for (const [name, row] of Object.entries(rows)) {
    S.push([`go live row: ${name}`, async (p) => {
      await mockGoLive(p, target, { golive: row() });
      await gotoDesk(p, base, true);
      await card(p).locator('.nm').click();
      await card(p).locator('.glrow [data-golive="rollback"]').waitFor();   // every one of these can roll back
      await settle(p);
    }]);
  }
  return S;
}

// The row the Go live states use: one that can go live (live and staging
// addresses set), and of those the longest name.
function goLiveTarget(sites) {
  const can = (s) => (s.live_domain && s.staging_domain ? 1 : 0);
  return [...sites].sort((a, b) => can(b) - can(a) || b.name.length - a.name.length)[0];
}

function statesFor(base, sites) {
  const siteNames = sites.map((s) => s.name);
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
    await p.selectOption('#f-stage', 'staging');
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
  if (sites.length) S.push(...goLiveStates(base, goLiveTarget(sites)));
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
  const { sites } = await api(base, 'GET', '/api/sites');
  console.log(`Measuring ${LIVE || 'the local Worker with stress data'}: ${sites.length} site(s), ${WIDTHS.length} widths.\n`);

  const states = statesFor(base, sites);
  const clippedSeen = new Map();
  let fontsMissing = false;
  for (const width of WIDTHS) {
    // Phone widths are measured as a phone: touch, a coarse pointer and the
    // viewport meta tag honoured, which is where a page wanders sideways.
    const phone = width <= PHONE;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: phone, hasTouch: phone });
    const page = await ctx.newPage();
    // Leaving the page while a switch runs asks first (beforeunload); the
    // next state leaves it.
    page.on('dialog', (d) => d.accept().catch(() => {}));
    for (const [name, enter] of states) {
      // Each state installs its own canned answers, if any, from nothing.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
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
    console.log(`${String(width).padStart(5)}  measured ${states.length} states${phone ? ' (as a phone)' : ''}`);
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
