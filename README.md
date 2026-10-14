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

## Data rules

See `/methodology` on the site. Short version: network locators are the authority, the DOE database finds every site, driver reports are dated and linked, aggregators are never cited, and anything unconfirmed is labeled.

## Local

```
npm install
npm run dev
```

## Station-check Worker

`workers/station-check/` is a separate Cloudflare Worker that runs every Monday.

- Reads each route from `/data/<slug>.json` on the live site.
- Searches the DOE (NLR) station API for DC fast sites around each stop (`searches` in the route JSON: name, lat, lng, radius in miles) and compares them with the guide (`afdcIds`) and with last week's snapshot.
- Saves a change list to D1 (`check_runs`) and emails it when email is configured. It never edits the site.
- Item types: Not in guide, Coming (planned), Status, Access, Changed, Missing.

Setup: run `workers/station-check/schema.sql` in the D1 console, create the Worker from this repo with root directory `workers/station-check`, then add secrets `NLR_API_KEY` and `RUN_TOKEN`. Manual run: `https://<worker>/run?token=<RUN_TOKEN>`. Latest reports: `/latest?token=<RUN_TOKEN>`.

## Publishing

- Content (guides, station facts, new routes): write the route JSON to D1 `routes` with status `live`. Live on the next request.
- Code (templates, Functions, the Worker): merge to `main`; Cloudflare deploys it.
