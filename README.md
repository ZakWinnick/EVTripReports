# EV Trip Reports

Static site for evtripreports.com, built with Astro and hosted on Cloudflare Pages.

## How it's built

- Guide content lives in D1 (table `routes`, schema in `schema-routes.sql`). Publishing a new guide or an update is a row write: `functions/guides/[[path]].js` renders the D1 version on each request with the same renderer the build uses (`src/lib/render-guide.js`), and `functions/index.js` updates the home page cards. No deploy needed.
- The JSON in `src/data/routes/` is the built-in fallback, served when D1 has no row or isn't reachable.
- Route guides are generated from that JSON at build time. One file per route. Every station fact carries a `status` (`verified`, `conflict`, `unverified`, `unpublished`) and a `source` key that points into the file's `sources` map.
- `src/data/routes.json` lists all routes and whether each is live.
- `functions/api/intake.js` handles plan requests. It writes to a D1 database bound as `DB` (schema in `schema.sql`). Without the binding it returns 503 and the form tells visitors requests aren't open yet.

## Cloudflare Pages settings

- Framework preset: Astro
- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`. Other branches get preview URLs.

## Turning on plan requests

1. Create a D1 database (Workers & Pages > D1), e.g. `evtripreports`.
2. Run `schema.sql` in its console.
3. In the Pages project: Settings > Bindings > add D1 database, variable name `DB`.
4. Redeploy.

## Email notifications (Fastmail)

Plan requests and the Monday station check are emailed through Fastmail's JMAP API from and to admin@evtripreports.com. Create a Fastmail API token with Email and Email submission access, then add it as a secret named `FASTMAIL_TOKEN` in both places:

- Pages project `evtripreports`: Settings > Variables and secrets (type Secret).
- Worker `evtripreports-station-check`: Settings > Variables and Secrets (type Secret).

Optional overrides: `NOTIFY_TO` and `NOTIFY_FROM`. Without the token, requests are still saved to D1; they just aren't emailed.

## Turnstile on the plan form

The intake form can require a Cloudflare Turnstile check. Add these on the Pages project (Settings > Variables and secrets). Do not commit the values.

- `TURNSTILE_SITE_KEY`: site key. The form asks `GET /api/intake` for it and renders the widget only when it is set.
- `TURNSTILE_SECRET`: secret key. When it is set, `POST /api/intake` requires a passing siteverify result (`success`, action `plan_request`, and a hostname in the allow list). A failed or unreachable siteverify is rejected.
- `TURNSTILE_HOSTNAMES`: optional comma-separated hostnames. If unset, the only allowed hostname is `evtripreports.com`.

Both the site key and the secret have to be set for the check to run. If `TURNSTILE_SECRET` is unset, the form still accepts requests and still needs the D1 binding. Preview hostnames are rejected until they are added to `TURNSTILE_HOSTNAMES`.

## Paid checkout

Plan prices and Stripe Payment Links live in `src/data/plans.js`. Each tier's pay button uses that tier's `stripeUrl`. The intake form is saved first, then the browser opens the matching link. Stripe is configured to return to `https://evtripreports.com/plans?paid=1`, where the page shows a payment-received message. Replace a link in `plans.js` if you create a new Payment Link. Keep the success URL on `/plans?paid=1`.

Intake stores each request with status `new` and, when `FASTMAIL_TOKEN` is set, emails that request to the owner (`NOTIFY_TO`). The customer is not a recipient. Intake does not generate a plan and does not email a plan. Customer pages state the delivery time only: within 48 hours for route and detailed plans, within 3 business days for multi-day and family plans.

## Plan review

`functions/api/admin/plans/[[path]].js` is the owner review API. It does not email the customer, and it does not send a plan.

Set `ADMIN_TOKEN` as a Pages secret. Every request needs `Authorization: Bearer <ADMIN_TOKEN>` or the `x-admin-token` header. If the token or the D1 binding is missing, the API returns 503.

- `GET /api/admin/plans` lists requests whose status is `new` or `review`.
- `GET /api/admin/plans/:id` returns that request and its drafts.
- `POST /api/admin/plans/:id/draft` saves a draft. Body: `format` (`markdown` or `html`), `body`, and `sources` (a list of `{ "label", "url" }`). The request status becomes `review`.
- `POST /api/admin/plans/:id/decision` with `{ "status": "approved" }` or `{ "status": "rejected-for-redo" }`. Approval requires a saved draft. The latest draft then gets a long random access code. Rejection clears any access code.

Drafts live in `plan_drafts`. The statement is `schema-plan-drafts.sql`. Paste it into the D1 console for the database bound as `DB`, after `schema.sql`. Do not run it against production from a deploy or from CI.

## Data rules

See `/methodology` on the site. Short version: network locators are the authority, the DOE database finds every site, driver reports are dated and linked, aggregators are never cited, and anything unconfirmed is labeled.

The DOE station search is `developer.nlr.gov`. `nearest.json` needs `latitude` and `longitude`. A `location` parameter returns 422.

Tesla access comes from the locator, not from the DOE port type. `functionType=nacs` means the site is open to other EVs. `functionType=supercharger` alone means Tesla only. Flag each Tesla site that way. Prices move during the day, so a price check needs the clock time it was read. If the page did not show a price, say that. Do not invent a time.

## Unknown guide URLs

`functions/guides/[[path]].js` handles every `/guides/*` request. A live D1 row is rendered into the guide shell. A slug with no D1 row is served only when `dist/guides/<slug>/index.html` exists and its HTML is that guide. Every other path under `/guides/` returns `dist/404.html` with status 404. It does not fall through to the homepage.

## Local

```
npm install
npm run dev
```

## Station-check Worker

`workers/station-check/` is a separate Cloudflare Worker that runs every Monday.

- `SITE_URL` is `https://evtripreports.com`. `ROUTES_WEEKLY` lists every published route.
- Reads each route from `/data/<slug>.json` on the live site.
- Searches the DOE (NLR) station API for DC fast sites around each stop (`searches` in the route JSON: name, lat, lng, radius in miles) and compares them with the guide (`afdcIds`) and with last week's snapshot.
- Saves a change list to D1 (`check_runs`) and emails it when email is configured. It never edits the site.
- Item types: Not in guide, Coming (planned), Status, Access, Changed, Missing.

Setup: run `workers/station-check/schema.sql` in the D1 console, create the Worker from this repo with root directory `workers/station-check`, then add secrets `NLR_API_KEY` and `RUN_TOKEN`. Manual run: `https://<worker>/run?token=<RUN_TOKEN>`. Latest reports: `/latest?token=<RUN_TOKEN>`.

## Publishing

- Content (guides, station facts, new routes): write the route JSON to D1 `routes` with status `live`. Live on the next request. Until that row exists, the built JSON is what visitors get.
- Code (templates, Functions, the Worker): merge to `main`; Cloudflare deploys it.

## Loading guides into D1

Do this in the Cloudflare dashboard for the D1 database already bound to the Pages project as `DB`. That is the same database plan requests use. Do not create a second database, and do not run these statements from a deploy script against production.

1. Open Workers & Pages, then D1, then the database bound as `DB`. Open the console.
2. Paste `schema-routes.sql` and run it. It only creates `routes` when the table is missing. Plan-request tables in `schema.sql` stay as they are.
3. On your machine, from this repo, run `node scripts/export-routes-sql.mjs > routes.sql`. That file is generated locally. It is not committed.
4. Paste `routes.sql` into the same D1 console and run it. D1 rejects a single statement over 100KB. The export script skips a route and prints a SKIP line if that happens.
5. Insert every published route in that one run. `functions/index.js` replaces the whole homepage card list when the table has any rows. A partial load hides the guides that are only in the build.
6. A row is what the site serves only when `status` is `live` and `json` is set. The export writes `live` when `src/data/routes.json` says `live` (or the older `live-ready` label) and every primary's stalls, power, and access are `verified`. A disclosed conflict on a backup or other site does not block that. Unverified, unpublished, or conflicting stalls, power, or access on a primary stays `verifying`. The build does the same: only routes that pass that gate get `/guides/<slug>/` and `/data/<slug>.json`. `verifying` stays a coming-soon card with no link, and that URL 404s.
7. Confirm a guide on the preview URL, then an unknown path such as `/guides/not-a-route/`. The guide should be the D1 copy. The unknown path should be the 404 page with status 404.

The JSON in `src/data/routes/` stays in git. It is the fallback when D1 has no row, and it is what the Monday station check reads until `functions/data/[file].js` finds a live row.
