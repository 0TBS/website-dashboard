# The Website Desk

One page listing every client website, with where each one stands. It is built in the same style as the 10XiD Preview Desk (preview.10xid.com/desk/).

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

## How it is built

- **Cloudflare Worker** (`src/worker.js`) serves the page from `public/` and answers `/api/sites`.
- **D1 database** (`DB` binding) holds the list: one table, `sites`. The Worker creates the table the first time it is used, so there is no migration step.
- **`src/sites.js`** is the one place that defines a site record: its fields, what each one may hold, and how input is cleaned. For example, `https://www.Example.com/` becomes `www.example.com`, and a GitHub link becomes `owner/repo`.
- **The page** is plain HTML, CSS and JS in `public/`, with no framework and no build step.
- **Privacy**: the list sits behind a shared desk key (`DASH_KEY`). With no key set, nobody can get in: the desk refuses every request rather than showing the list openly. `public/_headers` sends `X-Robots-Tag: noindex` and a strict Content-Security-Policy.

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars      # sets DASH_KEY=local-dev-key
npm run dev                         # http://127.0.0.1:8787, enter local-dev-key
npm test                            # unit tests for the field rules
```

Local runs use a local copy of D1 inside `.wrangler/`. It never touches the real database.

## Deploy (Cloudflare Workers)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**, choose `0TBS/website-dashboard` and keep the deploy command `npx wrangler deploy`. On the first deploy, Wrangler creates the `website-dashboard` D1 database and binds it.
2. Set the desk key as a secret. Use a long random value, for example from `openssl rand -hex 24`:
   ```sh
   npx wrangler secret put DASH_KEY
   ```
3. Optionally, attach a custom hostname under **Settings → Domains & Routes**.
4. Open the desk, enter the key once per browser, and add sites.

To let someone in, share the key. To lock everyone out, rotate it: run `wrangler secret put DASH_KEY` again with a new value.

## API

Every request needs `Authorization: Bearer <DASH_KEY>`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/sites` | – | `{ sites: [...] }` |
| POST | `/api/sites` | a site (`name` required) | `201 { site }` |
| PATCH | `/api/sites/:id` | only the fields to change | `{ site }` |
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
