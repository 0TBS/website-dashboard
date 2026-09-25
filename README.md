# The Website Desk

One page listing every client website, with where each one stands. It is built in the same style as the 10XiD Preview Desk (preview.10xid.com/desk/).

**Live at https://website.10xid.com**

For each site the desk shows, and lets anyone with the key change:

| Field | Answers |
| --- | --- |
| Live site runs on | Astro · WordPress · Other · Not live yet |
| Astro staging | Yes · No |
| Domain | Ours · The client's |
| SEO / PPC optimization | Needed · Not needed |
| Live domain, staging domain, GitHub repo | Shown with Copy and Open buttons |
| Chat | The Claude chat the site is built in: a claude.ai link, with Copy and Open |
| Environment | The Claude Code environment that chat runs in, such as `backblaze/CF` |
| Notes | Free text |

Any of these can also be **not set**. The desk says "not set" instead of guessing, so a missing answer shows up as work still to do.

The list is grouped by stage, worked out from those answers so there is nothing extra to keep up to date:

| Stage | Means |
| --- | --- |
| **Pending** | In the queue to be staged: no Astro staging build yet. |
| **Staging only** | An Astro staging build is up, but the live site is not on it yet. A staging domain counts unless *Astro staging* says No. |
| **Live** | The live site runs on Astro. |

The numbers at the top also work as filters. Tap **Pending** to see only those sites, and tap it again to see them all. The filters underneath answer the other questions, such as *WordPress sites with no Astro staging yet*.

Changes save as soon as you make them, and everyone sees the same list. When you come back to the tab, the desk loads anything teammates changed in the meantime.

The Edit dialog sends only the fields you changed. If a teammate saved the same site while your dialog was open, the desk refuses the save instead of overwriting their change. The dialog then shows their version with your changes on top. Any field you both changed is highlighted for you to check before saving again.

A site's row can also **Go live**: point its live domain at its staging Worker. The desk checks everything first, saves today's DNS records so the switch can be rolled back, and asks you to confirm. See [Going live from the desk](#going-live-from-the-desk).

## How it is built

- **Cloudflare Worker** (`src/worker.js`) serves the page from `public/` and answers `/api/sites` and `/api/golive/*`.
- **A Durable Object with SQLite** (`DESK` binding, class `Desk`) holds the list in one table, `sites`, and the go-live record in three more (`golive`, `golive_log`, `golive_checks`), inside one object placed in eastern North America. The tables are created the first time the object starts, so there is no migration step. It is not D1 because this Cloudflare account is at the Free plan's limit of 10 D1 databases, all used by client sites. A single object is also strongly consistent: every write goes through one place, one at a time.
- **`src/sites.js`** is the one place that defines a site record: its fields, what each one may hold, and how input is cleaned. For example, `https://www.Example.com/` becomes `www.example.com`, and a GitHub link becomes `owner/repo`.
- **Going live**: `src/golive.js` holds the checks, the switch, the put-back and the live check; `src/golive-routes.js` answers `/api/golive/*`; `src/golive-store.js` is the SQL for the go-live tables. `src/cloudflare.js` is a small client for the Cloudflare API, `src/access.js` checks the Cloudflare Access login with Web Crypto (no library), and `src/budget.js` counts the calls each request makes. None of them needs the Workers runtime, so `npm test` runs whole switches and rollbacks under plain Node against a fake Cloudflare (`test/fake-cloudflare.js`).
- **The page** is plain HTML, CSS and JS in `public/`, with no framework and no build step.
- **Privacy**: the list sits behind a shared desk key (`DASH_KEY`). With no key set, nobody can get in: the desk refuses every request rather than showing the list openly. `public/_headers` sends `X-Robots-Tag: noindex` and a strict Content-Security-Policy. Workers Logs drop query strings.
- **Staying logged in** (`src/session.js`): the key is typed once. The Worker checks it and sets a login cookie in its place, and the browser stays logged in until someone presses **Log off**. The cookie is `HttpOnly`, so no script can read it, and `SameSite=Strict`. It holds a value made from the key, never the key itself. It lasts 400 days, the longest any browser allows, and every visit restarts that clock. The Worker sets it, not the page, so Safari does not clear it after seven days the way it clears `localStorage`. A browser that saved the key the old way, in `localStorage`, logs in with it once and then deletes it.
- **Changes need the desk's own page**: a logged-in browser sends its cookie even on requests that another `*.10xid.com` page starts. So a change sent with the cookie must also carry an `x-desk: 1` header. Only the desk's page adds it, and another site cannot add it without the Worker's permission, which the Worker never gives.
- **HTTPS only**: the 10xid.com zone's "Always Use HTTPS" is off, and turning it on would change every client host on the zone. So this Worker enforces HTTPS itself. It sees every request (`run_worker_first: true`), redirects plain-HTTP pages to HTTPS, refuses plain-HTTP API calls, and sends HSTS for this host only.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars      # sets DASH_KEY=local-dev-key
npm run dev                         # http://127.0.0.1:8787, enter local-dev-key
npm test                            # unit tests: field rules, login, going live
```

Local runs keep their own copy of the data inside `.wrangler/`. They never touch the live list.

## Layout check: nothing scrolls sideways

```sh
npm run check:overflow     # exits 1 on any sideways scroll or spill
npm run check              # unit tests, then the layout check
```

This starts the real Worker with a throwaway database and fills it with awkward content: an unbroken 90-character name, a 100-character domain, a long staging path and repo, and notes that are one pasted URL. It opens every screen state: locked, the list, each row opened, no results, the longest filter labels, the add and edit dialogs, an edit error, an edit conflict, an armed delete, and the 404 page. It also opens every Go live step (sign in, not set up, not allowed, checks that fail and checks that pass, switching, a switch that worked and one that failed, Roll back with the old-host acknowledgement, rolled back) and the row's Go live section while checking, live, stopped part-way and failed, answering `/api/golive/*` with canned JSON through Playwright so nothing is written. It measures each state at 320, 360, 390, 402, 430, 768, 1024, 1440 and 3440px wide. Up to 430px it measures as a phone (touch, a coarse pointer, the viewport tag honoured).

It fails if the page is wider than the window, or if any element's content spills out of its own box. When it fails, it names the element. Text cut short with an ellipsis on purpose is listed but does not fail, because the full text is shown elsewhere on the page. The check also fails if the web fonts did not load, because fallback fonts have different widths. Set `ALLOW_FALLBACK_FONTS=1` to measure anyway.

To measure the live desk without writing anything, set `DESK_URL=https://website.10xid.com` and `DESK_KEY=...`. Playwright is pinned to 1.56.1. On a machine without its browser, run `npx playwright install chromium` once, or set `CHROMIUM_PATH` to an existing Chromium.

The layout rules the check enforces:

- Every grid column that holds text is `minmax(0,1fr)`, never an implicit `auto` or a bare `1fr`.
- Every flex or grid child that holds text has `min-width:0`.
- Headings and body text use `overflow-wrap:anywhere`.
- Nothing is hidden with `overflow-x:hidden` to make an overflow go away.
- On a touch screen every text box and menu is at least 16px. iPhone Safari zooms the page in when a smaller one is tapped and leaves it zoomed, and the page then wanders sideways as it scrolls.

## Deploy (Cloudflare Workers)

The Worker `website-dashboard` runs on the Cloudflare account that holds the 10xid.com zone. Everything about where it lives is in `wrangler.jsonc`:

- **Custom domain:** `website.10xid.com`. Cloudflare created the DNS record and certificate. It overrides the proxied `*.10xid.com` wildcard for this one hostname.
- **workers.dev and preview URLs:** off. The desk has only one address.
- **Desk key:** stored as a Worker secret named `DASH_KEY`. It is not a build variable.
- **Going live:** five more Worker secrets, a Cloudflare API token and a Cloudflare Access application. See [Setting it up](#setting-it-up).

To redeploy after a change, run:

```sh
npx wrangler deploy
```

This needs a Cloudflare API token that can edit Workers on that account.

To let someone in, share the key. To lock everyone out, rotate it by setting a new value. That also logs out every browser that is logged in, and each one is asked for the new key:

```sh
openssl rand -hex 24 | npx wrangler secret put DASH_KEY
```

## Going live from the desk

**Go live** on a site's row points its live domain at its staging Worker. It is gate 13 (`wp-17-point-domain-at-new-site`) done by the desk. The desk key is shared by the team, so going live also needs the person's own Cloudflare Access login, and their email on the Worker's `GOLIVE_EMAILS` list. An Access service token has no email, so a script can never go live.

It handles both ways a client domain is set up on the account: DNS records that point at the old host (WordPress or other), or a Custom Domain on another Worker (a live `<name>` Worker next to `staging-<name>`). In the second case the desk moves the Custom Domain to the staging Worker, and Roll back moves it back.

### What Go live does, in order

1. **Checks** everything it can (below) and shows every result, with the plan: the Worker that takes the domain, each hostname and its role, the DNS records it will delete (in full: they are the rollback), any Custom Domain it moves off another Worker, and the redirect it adds. When the live domain is the apex or `www`, the other one moves too and gets a 301 to it. Untick **Also move www.acme.com** to leave it where it is.
2. Asks for the **acknowledgements**: *Gate 12 is approved in sites/&lt;domain&gt;.md*, *I have checked &lt;repo&gt;’s wrangler config (routes and custom domains)* (see below), and on a Friday, *It is Friday and this cannot wait*.
3. Asks you to **type the live domain**: "Type acme.com to point it at staging-acme". **Go live** stays off until no check fails (warnings never block), every box is ticked and the name matches.
4. **Reads Cloudflare again** just before switching. A start needs a check from the last ten minutes, for the same choice of hostnames. If a record, a Custom Domain or a host the switch acts on has changed since, the desk refuses and shows the new plan to read again.
5. **Switches**, recording each step in the Durable Object as it happens. It deletes the old A, AAAA and CNAME records on the hosts (they were saved first), or detaches the hosts from the other Worker. It attaches each host to the staging Worker as a Custom Domain, main first, adds a 301 Single Redirect from the other host to the main one when both move, and sets **Live site runs on** to Astro.
6. **Checks the live site** every 5 seconds for 10 minutes, and again whenever you press **Check now**. It passes when the live address serves a page over HTTPS with no noindex, the page comes from the same build as staging (the same `/_astro/` files), a second page answers, the other host answers with a 301 to the same path on the live one, every host is still on the staging Worker, public DNS (dns.google and cloudflare-dns.com) no longer gives the old address, and MX and TXT are as they were. The row then says **Live**. A later check that fails does not undo that; it shows what failed. A 5xx in the first two minutes counts as waiting, while Cloudflare puts the certificate in place.
7. Shows the **gate 13 record**, ready to paste into `sites/<domain>.md`.

### The checks

When an early check makes the rest meaningless, the desk stops there. A check that gets an error from Cloudflare fails and quotes it; a 401 or 403 adds that the API token may be missing a permission (see [Setting it up](#setting-it-up)).

| Check | Stops Go live when | Warns when |
| --- | --- | --- |
| Live and staging addresses | either is missing or not a bare hostname; they are the same; either is the desk's own address; staging is a path on a shared preview host (give the site its own Worker first, gate 9) | – |
| Zone on Cloudflare | the live domain is not a zone on the account (gate 6); the zone is not active, is paused or is not a full setup; it is the desk's own zone | – |
| Staging Worker | staging is not a Worker Custom Domain; it is on more than one Worker or on the desk; it is a zone's apex or `www`; its Worker already serves another zone's apex or `www` | – |
| Hostnames to move | a host is already on the staging Worker or on the desk; another site has an unfinished or live go-live on it; the host left behind is a CNAME alias of the live domain | the other host is left behind and keeps showing the old site |
| DNS records to delete | a record there is managed by another Cloudflare product; the switch needs too many calls (below) | – |
| Mail | an MX points at a host that moves, or at a name that CNAMEs to one | other names CNAME to a host that moves and will follow it; the SPF record allows `a` and an apex A or AAAA is going |
| MX and TXT records | – (saved, to compare after the switch) | – |
| Worker routes | a Worker route covers a host: it would run in front of the Custom Domain | – |
| SSL/TLS mode | – | it is not Full (the desk never changes it) |
| Redirect rules | another rule sends the live domain somewhere; with a redirect to add, the zone already has its plan's most rules (Free 10, Pro 25, Business 50, Enterprise 300) | another rule names the other host and may answer first |
| Wrangler config | – | always (below) |
| Staging address | – | always: staging stays on its Worker, a second copy of the site unless it has noindex (gate 10) |
| Staging page | `https://<staging>/` does not answer 200 with HTML (behind Access or a login, the desk cannot check it) | – |
| Search engines | staging says noindex, in an `X-Robots-Tag` header or a robots meta tag | – |
| Canonical address | the canonical link names a host other than the live domain | there is none |
| Files from the old site | the home page loads `/wp-content/`, `/wp-includes/` or a file from a host that moves | – |
| robots.txt | the rules for `User-agent: *` say `Disallow: /` | it could not be read |
| Nameservers | public DNS gives other nameservers than the ones Cloudflare assigned | a resolver did not answer |
| Secrets | – | a host moves from another Worker that has secret names the staging Worker lacks |
| Friday | – | it is Friday in Toronto |

### Before the next push: the wrangler config

A Workers Builds deploy replaces a Worker's Custom Domains with the list in its repo's wrangler config. If the repo's `wrangler.jsonc` has a `routes` key, add the hosts to it with `custom_domain: true` and push that before anything else is deployed. Otherwise the next build takes the site down on them. After a Roll back, take them out again. When the hosts came from another Worker, also disconnect Workers Builds on that Worker, or take the hosts out of its wrangler config, or its next build takes them back. This is why the check always warns and the acknowledgement is always asked. The live check fails if a host has dropped off the staging Worker.

### When it fails, and Roll back

If the switch fails before every host is attached, the desk puts everything back at once, with 60 seconds of its own and the Cloudflare calls the switch kept back for it. The row then says whether everything was put back; if not, **Roll back** finishes it. A failure after every host is attached (only the redirect is left by then) undoes nothing: the site works, the result says what failed, and Roll back is there.

**Roll back**, and the automatic put-back, remove the desk's redirect rule, then work **one host at a time**: detach it from the staging Worker, wait until the DNS record Cloudflare made for it has gone, then put the saved records back exactly, or move the host back to its old Worker. A run cut off part-way leaves at most one host half done. It looks at what is there rather than trusting what it wrote down, so running it again finishes the job and changes nothing that is already back. A last read of the zone decides whether it worked. After a Roll back that worked, **Live site runs on** goes back to what it was, if it still says Astro.

- A host that is now on some other Worker (neither the staging Worker nor its old one) is left alone, old records and all. Someone moved it on purpose, and the result says so.
- More than **7 days** after the switch, Roll back also asks you to tick *The old host is still ours: its address has not been switched off or given up (gate 20)*. The saved records point at the old host. Once it is switched off, putting them back would point the site at nothing.
- Cloudflare keeps the certificate it made for a Custom Domain after the detach. It does no harm; delete it under SSL/TLS › Edge Certificates if you want it gone.

Roll back is offered once a site is switched, after a failed switch that was not all put back, after a rollback that did not finish, and on a run that stopped part-way (no step for two minutes). A site whose go-live still needs someone cannot be deleted from the desk.

### What the desk never touches

- MX and TXT records, and every record except the A, AAAA and CNAME records named exactly as the hosts it moves.
- The zone's SSL/TLS mode. It reports it only.
- The old host itself. The desk only changes DNS; switching the old site off is gate 20.
- The staging hostname, which stays on its Worker.
- Worker routes, other redirect rules and the repo's wrangler config. It adds and removes only its own redirect rule (`desk-<site id>`), one rule at a time, never the whole list.
- The desk's own zone (10xid.com) and its own Worker.

### Never unattended

Nothing runs on a schedule, an alarm or a background retry. Every switch and every Roll back is a person pressing the button and watching. The run happens inside that request: at most 90 seconds for a switch and 60 for a put-back. Keep the tab open until it finishes. If the tab closes, the Worker carries on for up to 30 seconds. A run cut off shows on the row as stopped part-way two minutes after its last step, with Roll back, and Check now when every host made it across.

### The Free plan's limits

Workers Free allows 50 outbound calls ("subrequests") and 10 ms of CPU per request. The desk counts every call a request makes (the Access keys, the Cloudflare API, the pages, public DNS) against 46, a few short of 50 so a miscount never breaks a run. Before each step of a switch it checks that the calls a full put-back would need are still left, and stops and puts back if they are not. A switch that could not fit with a full put-back in one request is refused at the check: *This switch needs more Cloudflare calls than one request allows (too many records). Ask a developer to do it by hand.* Moving the apex and `www` with the redirect fits five A, AAAA or CNAME records between them when the apex is the live domain (four when `www` is). A single hostname fits eight at the apex, seven on a subdomain. A typical WordPress host (two A and two AAAA records on the apex, a CNAME on `www`) fits.

For the CPU, the pages are read only in the check, never in the switch: at most 1 MB of the home page, scanned once. The Access keys are imported once and kept for ten minutes.

### Setting it up

Until all five settings below are there, every go-live request answers `503 golive-not-set-up`, naming the missing ones. The rest of the desk works as before.

**1. A Cloudflare API token.** A custom token on the account that holds the client zones and their Workers:

| Permission | Used to |
| --- | --- |
| Account › Workers Scripts › Edit | list, attach and detach Custom Domains; read secret names |
| Zone › Workers Routes › Edit | attach a Custom Domain in the zone; read its Worker routes |
| Zone › DNS › Edit | read, delete and put back records |
| Zone › Zone › Read | find the zone, its plan and its nameservers |
| Zone › Zone Settings › Read | read the SSL/TLS mode |
| Zone › Single Redirect › Edit | add and remove the redirect rule |

Account resources: that account. Zone resources: include all zones from that account, then exclude 10xid.com. The desk never changes DNS in its own zone, and this way the token cannot either.

**2. A Cloudflare Access application** in front of the go-live endpoints only:

- Zero Trust › Access controls › Applications › Add an application › Self-hosted.
- Two destinations on `website.10xid.com`: path `api/golive` and path `api/golive/*`. A wildcard path does not cover its parent, so both are needed.
- An Allow policy naming the people by email.
- Copy the application's Audience (AUD) tag, under Configure › Additional settings. The team domain, `<team>.cloudflareaccess.com`, is under Zero Trust › Settings.

The Worker checks the Access token on every go-live request (its signature against the team's keys, the AUD tag, the issuer and the expiry), then the email against `GOLIVE_EMAILS`. Access decides who can sign in; the list decides who can go live. To test that Access is in front:

```sh
curl -sI https://website.10xid.com/api/golive/me    # expect 302 to https://<team>.cloudflareaccess.com/...
```

A `401` from the desk instead means Access is not in front yet, and the desk refuses to go live.

**3. Five secrets.** Secrets, not variables in `wrangler.jsonc`, so a `wrangler deploy` never replaces them. The two Cloudflare ones are not called `CF_API_TOKEN` and `CF_ACCOUNT_ID` because wrangler reads those names from a developer's shell as its own deploy credentials, and the desk's token must never be taken for that one or the other way round:

```sh
npx wrangler secret put GOLIVE_API_TOKEN      # the token above
npx wrangler secret put GOLIVE_ACCOUNT_ID     # the account that holds the client zones and their Workers
npx wrangler secret put ACCESS_TEAM_DOMAIN    # <team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD            # the application's AUD tag
npx wrangler secret put GOLIVE_EMAILS         # who may go live: emails, separated by commas or spaces
```

`wrangler dev` has no Access in front, so locally the go-live endpoints answer `access-not-protecting` (or `golive-not-set-up` without the five settings in `.dev.vars`). `npm test` covers going live against fakes.

## Backups and undo

A Durable Object's SQLite database keeps 30 days of point-in-time history on Cloudflare's side. There is no button for it on the desk. To undo a bad delete or edit, restore the object to a moment before it happened with `ctx.storage.getBookmarkForTime()` and `onNextSessionRestoreBookmark()`. This rolls back the whole list, not a single row. It rolls back the go-live record too, so never restore to a time before a go-live that is still switched: the records its Roll back needs would go with it.

For a copy you hold yourself, save the list:

```sh
curl -s https://website.10xid.com/api/sites -H "Authorization: Bearer $DASH_KEY" > desk-backup.json
```

## API

Scripts send `Authorization: Bearer <DASH_KEY>` with every request. The page uses the login cookie instead.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/session` | `{ "key": "..." }` | `{ loggedIn: true }` and the login cookie, or `401 { code: "bad-key" }` |
| DELETE | `/api/session` | – | `{ loggedIn: false }` and the cookie cleared (Log off) |
| GET | `/api/sites` | – | `{ sites: [...] }` |
| POST | `/api/sites` | a site (`name` required) | `201 { site }` |
| PATCH | `/api/sites/:id` | only the fields to change, optionally `expected_updated_at` | `{ site }`, or `409 { code: "conflict", site }` if the row changed since that time |
| DELETE | `/api/sites/:id` | – | `{ deleted: id }`, or `409 { code: "golive-active" }` while the site's go-live still needs someone |
| GET | `/api/golive/signin?site=<id>` | – | Where Access sends you back after its login; needs no desk key. `302` to `/#golive=<id>` (`/` if the id is not a site id), or to `/#golive-error=<code>` |
| GET | `/api/golive/me` | – | `{ email }` |
| GET | `/api/golive/:id` | – | `{ site, golive, log, last_check }` |
| POST | `/api/golive/:id/check` | `{ include_pair }` | `{ checks, plan, plan_hash, ready, acks }`, saved for the start |
| POST | `/api/golive/:id/start` | `{ include_pair, confirm, plan_hash, acks }` | `{ site, golive, log }`; `400` `confirm-mismatch` or `acks-missing`; `409` `check-first`, `plan-changed` (with the new plan and checks, when the plan or any Cloudflare check's result changed), `too-many-calls` or `busy`; `502 switch-failed`; `500 not-recorded` if every host moved but the desk could not write that down |
| POST | `/api/golive/:id/verify` | – | `{ site, golive, checks, done }`, or `409 not-switched` |
| POST | `/api/golive/:id/rollback` | `{ confirm, acks }` | `{ site, golive, log }`; `400` `confirm-mismatch` or `acks-missing`; `409` `busy`, `nothing-to-undo` or `unreadable`; `502 rollback-failed` |

Field values:

- `live_platform`: `"astro"`, `"wordpress"`, `"other"`, `"none"` or `null`.
- `astro_staging`, `domain_ours` and `needs_seo_ppc`: `true`, `false` or `null`.
- `chat_url`: a `claude.ai` link (`claude.ai/code/session_…` is fine; it is stored with `https://`), or `null`. Links anywhere else are refused.
- `environment`: one line of up to 80 characters, or `null`.
- `golive` (read only): where the site's go-live stands, or `null` if it never went live from the desk. It says whether there was an error (`has_error`) and what kind (`error_kind`), never its words: those can quote a saved record, so only `/api/golive/:id`, behind Access, has them.
- Bad input returns `400 { error, field }`, naming the field that failed.

Going live needs more than the key. Every `/api/golive/*` request except `signin` also needs a Cloudflare Access token (`Cf-Access-Jwt-Assertion`, which Access adds) whose email is on `GOLIVE_EMAILS`. Otherwise it answers `503 golive-not-set-up { missing }`, `401 access-not-protecting`, `403 access-invalid`, `403 not-allowed` or `503 access-keys-unavailable`. `include_pair` is `true` unless it says `false`. `confirm` is the live domain as typed. `acks` lists the ids of the acknowledgements ticked (`gate12`, `wrangler`, and `friday` or `old-host` when asked).

To add many sites at once, POST them one by one:

```sh
curl -X POST https://<desk>/api/sites \
  -H "Authorization: Bearer $DASH_KEY" -H 'content-type: application/json' \
  -d '{"name":"Client","live_domain":"client.com","live_platform":"wordpress","astro_staging":false,"domain_ours":true,"needs_seo_ppc":true}'
```
