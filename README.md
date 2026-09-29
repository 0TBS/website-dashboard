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

Each site also keeps its details, each with Add, Edit and Remove:

| Section | Holds |
| --- | --- |
| Services & accounts | Every account or resource the site uses: its GoDaddy and Cloudflare accounts, its Cloudflare Worker and zone, Backblaze bucket, database, Tag Manager, Analytics, Search Console, Google Ads, Business Profile, reCAPTCHA, Resend, Cal.com, Stripe, WordPress admin and other hosting. Each has its ID or name, a link to its dashboard, which account owns it, and notes. |
| Contacts | The client's people: name, role, email, phone and notes. |
| Domains | Every domain the site uses, and what for (live, staging, images, redirects, old domains), with its registrar, whether its DNS is on Cloudflare, and when it renews. |
| Job info | One row per URL with work to do, and a tick for each job it needs: Clone, Database / Backblaze B2, SEO / PPC, Live. |
| Social media | The site's TikTok, LinkedIn, Facebook, X and Instagram accounts: the profile link, the handle, which account owns it, and notes. Add asks for the platform first. A link must be on that platform's own domain, so a TikTok link to instagram.com is refused. |
| Client form | For a site made from the client form: whether it asked to notify the rep, notify the client, and do a competitor analysis. |
| History | Every change to the site and its details: when, who (when the desk knows), which field, and what it was before. |

**Never put a password or API key in the desk.** Everyone with the desk key could read it. Write where the login lives instead, such as "1Password → Acme → Cloudflare".

A site's row can also **Go live**: point its live domain at its staging Worker. The desk checks everything first, saves today's DNS records so the switch can be rolled back, and asks you to confirm. See [Going live from the desk](#going-live-from-the-desk).

## The client form

**Client form** in the header opens `/client-form`: a new client in one go, from the sketch the team works from. It uses the desk's own login, so only someone with the desk key can fill it in or send it.

| Part | Becomes |
| --- | --- |
| Contact information: name, email, phone number, business | The site (named after the business), and its first contact, with the role *Main contact*. Name, email and business are required. |
| Delegate information: name, email, phone number, job position | More contacts, the job position as their role. **+ Add delegate** adds a row; an empty row is skipped. |
| Live website URL | The site's live domain. |
| Services & accounts: a service, and its login info | Services: GoDaddy, Cloudflare, Backblaze B2 and every other kind the desk knows. Login info goes in the service's Account and says where the login lives. A line that looks like a password (`password: …`, `pw=…`) is refused. |
| Job info: a URL, with Clone, Database / Backblaze B2, SEO / PPC and Live ticks | The site's job list. **+ Add URL** adds a row. The first row takes the live website URL unless something else is typed there. Any URL ticked for SEO / PPC sets the site's SEO / PPC to *Needed*. |
| Notify rep (me), Notify client, Competitor analysis | Saved with the site, under Client form. The desk does not send any email yet. |

**A client already on the desk cannot get a second form.** As the business name, live website URL and contact email are typed, the form checks the desk, and if the client is there it says which site and turns Save off. A client counts as already there when a site has the same live website (with or without `www.`, whatever the path), or lists that domain under its Domains, or has the same name (whatever the case), or has a contact with the same email. The Worker checks again when the form is sent, under the desk's lock, so two forms for one client sent at once cannot both land.

Everything from one form is saved in one transaction: all of it, or, if anything is refused, none of it. The form then links to the new site on the desk (`/#site=<id>`, which opens that row).

## How it is built

- **Cloudflare Worker** (`src/worker.js`) serves the page from `public/` and answers `/api/sites`, `/api/client-form` and `/api/golive/*`.
- **Postgres on Neon** holds everything: Neon project `website-desk` (`small-bird-63386345`) in AWS US East, database `desk`, on the Branding org's free plan. The Worker reaches it with `pg` over a TCP socket, at the address in the `DATABASE_URL` secret. The tables:

  | Table | Holds |
  | --- | --- |
  | `sites` | One row per site: the fields in the table above. |
  | `site_services`, `site_contacts`, `site_domains`, `site_jobs` | A site's details, any number of each. They go when the site is deleted. |
  | `client_forms` | For a site made from the client form, its three ticks. It goes when the site is deleted. |
  | `site_tiktok`, `site_linkedin`, `site_facebook`, `site_x`, `site_instagram` | One table per social media platform: `handle`, `url` (the profile link, once per site), `account` and `notes`. They go when the site is deleted. A new platform needs a new table, so it is a new schema step plus one line in `src/details.js`. |
  | `history` | One row per field changed, and one per row added or removed. The database writes it itself, with a trigger, so no change can skip it. It is kept when the site is deleted. |
  | `golive`, `golive_log`, `golive_checks` | Going live: where each site's go-live stands, every step it took, and the last check. |
  | `schema_migrations`, `desk_meta` | Which schema steps have run, and when the old data was copied in. |

- **Ids** are numbers a person can read: `0001`, `0002`, `0003`, in the order rows were made, each table counting on its own (sites, services, contacts, domains, and each social media table). Past `9999` they carry on as `10000`. A number is never handed out twice, even after a delete. Each table has its own counter, a Postgres sequence named after it (`sites_number`, `site_services_number` and so on). Schema step 4 renumbered every row made before this, and moved everything that names them (a site's details, its go-live record and log, the history) along with it. History rows about a site deleted before that step keep that site's old id.
- **The schema** is in `src/schema.js` as numbered steps. The Worker runs any it has not run yet the first time it reaches the database, so a deploy needs nothing run by hand. A change to the shape is a new step at the end. A step already on the live database is never edited.
- **One write at a time** (`src/db.js`): each call is one transaction. Every write takes the same Postgres advisory lock first, so writes still run one after another, as they did in the Durable Object. Going live relies on this: a step reads the row, decides, and writes, and nothing lands in between. Reads take no lock.
- **`src/sites.js`** is the one place that defines a site record: its fields, what each one may hold, and how input is cleaned. For example, `https://www.Example.com/` becomes `www.example.com`, and a GitHub link becomes `owner/repo`. **`src/details.js`** does the same for services, contacts and domains, and holds the list of service kinds. Adding a kind is one line there.
- **`src/client-form.js`** says what the client form may hold, and cleans it with the rules of `sites.js` and `details.js`, so a contact from the form is the same as one added on the desk.
- **`src/store.js`** is every read and write the Worker makes.
- **Going live**: `src/golive.js` holds the checks, the switch, the put-back and the live check; `src/golive-routes.js` answers `/api/golive/*`; `src/golive-store.js` is the SQL for the go-live tables. `src/cloudflare.js` is a small client for the Cloudflare API, `src/access.js` checks the Cloudflare Access login with Web Crypto (no library), and `src/budget.js` counts the calls each request makes. None of them needs the Workers runtime, so `npm test` runs whole switches and rollbacks under plain Node against a fake Cloudflare (`test/fake-cloudflare.js`) and a real Postgres running inside the test process (PGlite, `test/pglite.js`).
- **The old Durable Object** (`DESK` binding, class `Desk`) held the list until September 2026. The first time the new Worker reached Neon, it copied the object's four tables across in one transaction, keeping every id, time and log number, and recorded that in `desk_meta`. The object now only hands over its data. Its data is left as it was, so the previous Worker version can still be rolled back to. It will be deleted in a later release.
- **The page** is plain HTML, CSS and JS in `public/`, with no framework and no build step.
- **Privacy**: the list sits behind a shared desk key (`DASH_KEY`). With no key set, nobody can get in: the desk refuses every request rather than showing the list openly. `public/_headers` sends `X-Robots-Tag: noindex` and a strict Content-Security-Policy. Workers Logs drop query strings.
- **Staying logged in** (`src/session.js`): the key is typed once. The Worker checks it and sets a login cookie in its place, and the browser stays logged in until someone presses **Log off**. The cookie is `HttpOnly`, so no script can read it, and `SameSite=Strict`. It holds a value made from the key, never the key itself. It lasts 400 days, the longest any browser allows, and every visit restarts that clock. The Worker sets it, not the page, so Safari does not clear it after seven days the way it clears `localStorage`. A browser that saved the key the old way, in `localStorage`, logs in with it once and then deletes it.
- **Changes need the desk's own page**: a logged-in browser sends its cookie even on requests that another `*.10xid.com` page starts. So a change sent with the cookie must also carry an `x-desk: 1` header. Only the desk's page adds it, and another site cannot add it without the Worker's permission, which the Worker never gives.
- **HTTPS only**: the 10xid.com zone's "Always Use HTTPS" is off, and turning it on would change every client host on the zone. So this Worker enforces HTTPS itself. It sees every request (`run_worker_first: true`), redirects plain-HTTP pages to HTTPS, refuses plain-HTTP API calls, and sends HSTS for this host only.

## Run it locally

Local runs need a Postgres of their own. Never point them at the live Neon database.

```sh
npm install
createdb desk_dev                   # any local Postgres 14 or later
cp .dev.vars.example .dev.vars      # sets DASH_KEY=local-dev-key and DATABASE_URL
npm run dev                         # http://127.0.0.1:8787, enter local-dev-key
npm test                            # unit tests: field rules, login, going live, the database
```

`npm test` needs no Postgres: it runs one inside the test process. One test proves that writes from many connections at once still run one at a time. It needs a real server, so it is skipped unless `TEST_DATABASE_URL` points at a throwaway database. That test wipes the database it is given.

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
- **Database:** the Neon connection string, pooled (the `-pooler` host), stored as a Worker secret named `DATABASE_URL`. To change it, copy the new one from the Neon console (project `website-desk`, Connect, Pooled connection) and run `npx wrangler secret put DATABASE_URL`.
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
5. **Switches**, recording each step in the database as it happens. It deletes the old A, AAAA and CNAME records on the hosts (they were saved first), or detaches the hosts from the other Worker. It attaches each host to the staging Worker as a Custom Domain, main first, adds a 301 Single Redirect from the other host to the main one when both move, and sets **Live site runs on** to Astro.
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

**Undoing one change:** the `history` table has the value every field held before each change, and every row that was removed. Look it up on the site's History, or in the Neon console's SQL editor:

```sql
SELECT at, who, item, action, field, old_value, new_value FROM history
WHERE site_id = '<site id>' ORDER BY id DESC;
```

**Undoing everything since a moment:** Neon keeps **6 hours** of point-in-time history on the free plan (the Durable Object kept 30 days). Within that window, restore the branch to a moment before the mistake from the Neon console (Branches → main → Restore). This rolls back every table, the go-live record included. So never restore to a time before a go-live that is still switched: the records its Roll back needs would go with it. For a longer window, Neon's paid plans keep up to 30 days.

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
| GET | `/api/sites/:id/details` | – | `{ services, contacts, domains, jobs, tiktok, linkedin, facebook, x, instagram, client_form, history, choices }`; `client_form` is `null` for a site not made from the form, `history` is the latest 200 changes, newest first, and `choices` lists the service kinds, domain uses, job ticks and social media platforms |
| POST | `/api/sites/:id/:kind` | the new item | `201 { item }` |
| PATCH | `/api/sites/:id/:kind/:itemId` | only the fields to change, optionally `expected_updated_at` | `{ item }`, or `409 { code: "conflict", item }` if it changed since that time |
| DELETE | `/api/sites/:id/:kind/:itemId` | – | `{ deleted: itemId }` |

| GET | `/api/client-form` | – | `{ choices }`: the service kinds, job ticks, options and row limits the form offers |
| GET | `/api/client-form/check?business=&live_url=&email=` | – | `{ exists: null }`, or `{ exists: { error, code: "client-exists", field, site: { id, name } } }` |
| POST | `/api/client-form` | the form (below) | `201 { site }`; `409 { code: "client-exists", field, site }`; `400 { error, field }`, the field named as a path such as `delegates.1.email` or `jobs.0.url` |

`:kind` is `services`, `contacts`, `domains`, `jobs`, or one of the social media platforms: `tiktok`, `linkedin`, `facebook`, `x`, `instagram`.
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
- A service: `kind` (required; one of `godaddy`, `cloudflare`, `cloudflare_worker`, `cloudflare_zone`, `backblaze_bucket`, `database`, `gtm`, `ga4`, `search_console`, `google_ads`, `business_profile`, `recaptcha`, `resend`, `calcom`, `stripe`, `wordpress`, `hosting`, `other`), `identifier`, `url` (an http or https link), `account` and `notes`.
- A contact: `name` (required), `role`, `email`, `phone` and `notes`.
- A domain: `hostname` (required; a domain without a path, once per site), `role` (required; `live`, `staging`, `image`, `redirect`, `old` or `other`), `registrar`, `dns_on_cloudflare` (`true`, `false` or `null`), `renews_on` (`YYYY-MM-DD`) and `notes`.
- A job: `url` (required; an address such as `acme.com/shop`, once per site), `clone`, `database_b2`, `seo_ppc` and `live` (`true`, `false` or `null`), and `notes`.
- The client form: `business` (required), `live_url`, `contact: { name, email, phone }` (name and email required), `delegates: [{ name, email, phone, position }]` (up to 20), `services: [{ kind, login }]` (up to 30), `jobs: [{ url, clone, database_b2, seo_ppc, live }]` (up to 50), and `notify_rep`, `notify_client`, `competitor_analysis` (`true` or `false`). Rows left empty are skipped.
- A social media link (`tiktok`, `linkedin`, `facebook`, `x` or `instagram`): `url` (required; on that platform's own domain, such as `tiktok.com`, or `x.com` or `twitter.com` for X; stored as https; once per site), `handle` (one word, the `@` is dropped), `account` and `notes`.
- Bad input returns `400 { error, field }`, naming the field that failed.
- If the database cannot be reached, every request that needs it answers `503 { code: "database-unavailable" }`. After five minutes with no visits, Neon's free plan pauses the database. The next request wakes it, which takes up to a second or two.

Going live needs more than the key. Every `/api/golive/*` request except `signin` also needs a Cloudflare Access token (`Cf-Access-Jwt-Assertion`, which Access adds) whose email is on `GOLIVE_EMAILS`. Otherwise it answers `503 golive-not-set-up { missing }`, `401 access-not-protecting`, `403 access-invalid`, `403 not-allowed` or `503 access-keys-unavailable`. `include_pair` is `true` unless it says `false`. `confirm` is the live domain as typed. `acks` lists the ids of the acknowledgements ticked (`gate12`, `wrangler`, and `friday` or `old-host` when asked).

To add many sites at once, POST them one by one:

```sh
curl -X POST https://<desk>/api/sites \
  -H "Authorization: Bearer $DASH_KEY" -H 'content-type: application/json' \
  -d '{"name":"Client","live_domain":"client.com","live_platform":"wordpress","astro_staging":false,"domain_ours":true,"needs_seo_ppc":true}'
```
