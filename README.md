# EV Trip Reports

Static site for evtripreports.com, built with Astro and hosted on Cloudflare Pages.

## How it's built

- Route guides are generated from JSON in `src/data/routes/`. One file per route. Every station fact carries a `status` (`verified`, `conflict`, `unverified`, `unpublished`) and a `source` key that points into the file's `sources` map.
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

- `TURNSTILE_SITE_KEY` — site key. The form asks `GET /api/intake` for it and renders the widget only when it is set.
- `TURNSTILE_SECRET` — secret key. When it is set, `POST /api/intake` requires a passing siteverify result (`success`, action `plan_request`, and a hostname in the allow list). A failed or unreachable siteverify is rejected.
- `TURNSTILE_HOSTNAMES` — optional comma-separated hostnames. If unset, the only allowed hostname is `evtripreports.com`.

Both the site key and the secret have to be set for the check to run. If `TURNSTILE_SECRET` is unset, the form still accepts requests and still needs the D1 binding. Preview hostnames are rejected until they are added to `TURNSTILE_HOSTNAMES`.

## Paid checkout

Plan prices and Stripe Payment Links live in `src/data/plans.js`. Each tier's pay button uses that tier's `stripeUrl`. The intake form is saved first, then the browser opens the matching link. Stripe is configured to return to `https://evtripreports.com/plans?paid=1`, where the page shows a payment-received message. Replace a link in `plans.js` if you create a new Payment Link. Keep the success URL on `/plans?paid=1`.

## Data rules

See `/methodology` on the site. Short version: network locators are the authority, the DOE database finds every site, driver reports are dated and linked, aggregators are never cited, and anything unconfirmed is labeled.

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
