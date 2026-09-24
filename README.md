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
| Notes | Free text |

Any of these can also be **not set**. The desk says "not set" instead of guessing, so a missing answer shows up as work still to do.

The numbers at the top also work as filters. Tap **Need SEO / PPC** to see only those sites, and tap it again to see them all. The filters underneath answer the other questions, such as *WordPress sites with no Astro staging yet*.

Changes save as soon as you make them, and everyone sees the same list. When you come back to the tab, the desk loads anything teammates changed in the meantime.

The Edit dialog sends only the fields you changed. If a teammate saved the same site while your dialog was open, the desk refuses the save instead of overwriting their change. The dialog then shows their version with your changes on top. Any field you both changed is highlighted for you to check before saving again.

## How it is built

- **Cloudflare Worker** (`src/worker.js`) serves the page from `public/` and answers `/api/sites`.
- **A Durable Object with SQLite** (`DESK` binding, class `Desk`) holds the list: one table, `sites`, inside one object placed in eastern North America. The table is created the first time the object starts, so there is no migration step. It is not D1 because this Cloudflare account is at the Free plan's limit of 10 D1 databases, all used by client sites. A single object is also strongly consistent: every write goes through one place, one at a time.
- **`src/sites.js`** is the one place that defines a site record: its fields, what each one may hold, and how input is cleaned. For example, `https://www.Example.com/` becomes `www.example.com`, and a GitHub link becomes `owner/repo`.
- **The page** is plain HTML, CSS and JS in `public/`, with no framework and no build step.
- **Privacy**: the list sits behind a shared desk key (`DASH_KEY`). With no key set, nobody can get in: the desk refuses every request rather than showing the list openly. `public/_headers` sends `X-Robots-Tag: noindex` and a strict Content-Security-Policy. Workers Logs drop query strings.
- **HTTPS only**: the 10xid.com zone's "Always Use HTTPS" is off, and turning it on would change every client host on the zone. So this Worker enforces HTTPS itself. It sees every request (`run_worker_first: true`), redirects plain-HTTP pages to HTTPS, refuses plain-HTTP API calls, and sends HSTS for this host only.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars      # sets DASH_KEY=local-dev-key
npm run dev                         # http://127.0.0.1:8787, enter local-dev-key
npm test                            # unit tests for the field rules
```

Local runs keep their own copy of the data inside `.wrangler/`. They never touch the live list.

## Deploy (Cloudflare Workers)

The Worker `website-dashboard` runs on the Cloudflare account that holds the 10xid.com zone. Everything about where it lives is in `wrangler.jsonc`:

- **Custom domain:** `website.10xid.com`. Cloudflare created the DNS record and certificate. It overrides the proxied `*.10xid.com` wildcard for this one hostname.
- **workers.dev and preview URLs:** off. The desk has only one address.
- **Desk key:** stored as a Worker secret named `DASH_KEY`. It is not a build variable.

To redeploy after a change, run:

```sh
npx wrangler deploy
```

This needs a Cloudflare API token that can edit Workers on that account.

To let someone in, share the key. To lock everyone out, rotate it by setting a new value:

```sh
openssl rand -hex 24 | npx wrangler secret put DASH_KEY
```

## Backups and undo

A Durable Object's SQLite database keeps 30 days of point-in-time history on Cloudflare's side. There is no button for it on the desk. To undo a bad delete or edit, restore the object to a moment before it happened with `ctx.storage.getBookmarkForTime()` and `onNextSessionRestoreBookmark()`. This rolls back the whole list, not a single row.

For a copy you hold yourself, save the list:

```sh
curl -s https://website.10xid.com/api/sites -H "Authorization: Bearer $DASH_KEY" > desk-backup.json
```

## API

Every request needs `Authorization: Bearer <DASH_KEY>`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/sites` | – | `{ sites: [...] }` |
| POST | `/api/sites` | a site (`name` required) | `201 { site }` |
| PATCH | `/api/sites/:id` | only the fields to change, optionally `expected_updated_at` | `{ site }`, or `409 { code: "conflict", site }` if the row changed since that time |
| DELETE | `/api/sites/:id` | – | `{ deleted: id }` |

Field values:

- `live_platform`: `"astro"`, `"wordpress"`, `"other"`, `"none"` or `null`.
- `astro_staging`, `domain_ours` and `needs_seo_ppc`: `true`, `false` or `null`.
- Bad input returns `400 { error, field }`, naming the field that failed.

To add many sites at once, POST them one by one:

```sh
curl -X POST https://<desk>/api/sites \
  -H "Authorization: Bearer $DASH_KEY" -H 'content-type: application/json' \
  -d '{"name":"Client","live_domain":"client.com","live_platform":"wordpress","astro_staging":false,"domain_ours":true,"needs_seo_ppc":true}'
```
