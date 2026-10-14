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
- Searches the DOE (NLR) station API for DC fast sites around each stop (`searches` in the route JSON) and compares them with the guide (`afdcIds`) and with last week's snapshot.
- Saves a change list to D1 (`check_runs`) and emails it when email is configured. It never edits the site.
- Item types: Not in guide, Coming (planned), Status, Access, Changed, Missing.

Setup: run `workers/station-check/schema.sql` in the D1 console, create the Worker from this repo with root directory `workers/station-check`, then add secrets `NLR_API_KEY` and `RUN_TOKEN`. Manual run: `https://<worker>/run?token=<RUN_TOKEN>`. Latest reports: `/latest?token=<RUN_TOKEN>`.
