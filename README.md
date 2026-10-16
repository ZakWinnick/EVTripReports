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

## Stripe payments

The Payment Links in `src/data/plans.js` are the checkout. The form is saved first, and `POST /api/intake` returns `{ ok, ref }` where `ref` is `etr-<plan_requests.id>`. The browser opens the Payment Link with `prefilled_email` and `client_reference_id=<ref>`, so the payment carries the order.

`POST /api/stripe-webhook` (`functions/api/stripe-webhook.js`) records paid Checkout sessions in `stripe_payments` (`schema-payments.sql`). It checks the Stripe signature (HMAC-SHA256, 5 minute tolerance) and is closed (503) until the Pages secret `STRIPE_WEBHOOK_SECRET` and `DB` are set. A payment matches its request by `client_reference_id`, then by the newest unpaid request with the same checkout email, else it is stored unmatched. `amount_ok` flags a payment whose amount is not the price of the request's tier. A full refund (`charge.refunded` with `refunded: true`) sets the status to `refunded`. It never changes `plan_requests`, never approves a plan, and never emails a customer. With `FASTMAIL_TOKEN` it emails the owner a Paid notice.

Setup, owner steps: apply `schema-payments.sql` in the D1 console. In Stripe, Developers > Webhooks, add an endpoint for `https://evtripreports.com/api/stripe-webhook` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `charge.refunded`. Copy the endpoint's signing secret (`whsec_...`) into the Pages secret `STRIPE_WEBHOOK_SECRET`.

The admin API shows payment state. `GET /api/admin/plans` and `GET /api/admin/plans/:id` include `payment`: `{ state: "paid" | "refunded" | "unpaid", amountCents, amountMatchesTier, matchedBy }`, or `null` when `stripe_payments` does not exist yet. The approval response includes the same `payment`. Approval is not blocked by it. Check it before a plan is sent.

## From a paid order to a draft

The order arrives at `POST /api/intake` and is stored as `new`. That request does not build a plan. Build the draft locally, then review it in the admin API. Approval is what creates the private link.

1. Check the order and save it as JSON: `node scripts/order-to-route.mjs --request request.json --out order.json`, where `request.json` is the request from `GET /api/admin/plans/:id`. It maps the start and end to a corridor (`--list` shows them all), says which way the trip runs, and writes the order only when nothing blocks the build. A reverse trip (`Needs manual build: reverse direction`), a port that is `Not sure` (`Needs customer question`), and a trip outside our corridors (`Needs manual check`) exit with status 2. The admin queue shows the same flags in `queueLabel` and `flags`. `scripts/build-plan.mjs` also refuses those orders with an error, so it never writes a forward-only or zero-stop plan for them. Plans run in the corridor's direction only. The intake form refuses a trip we cannot plan (422) before any row is saved, and `/plans/` lists the live corridors. The form's start battery is stored as a `[Start battery: N%]` first line of `notes`, and the departure time is stored on `depart` as `YYYY-MM-DDTHH:MM`. No schema change. Or write the order by hand. The builder reads `slug`, `vehicle` (or `car`), `adapter` (or `port`), `memberships`, `startBattery`, `depart`, `tier`, and `notes`. Tier is `$19`, `$39`, or `$79`, or the form labels `Route plan`, `Detailed plan`, and `Multi-day or family`.
2. Build the plan body from that order and the verified route file:

```
node scripts/build-plan.mjs --order order.json --route src/data/routes/<slug>.json --out plan.json
```

`scripts/build-plan.mjs` is pure. Same order and same route always produce the same JSON. It does not open a database, and it does not send email. `node scripts/dry-run-order.mjs` runs a built-in fake order, prints a summary, and writes `scripts/out/dry-run-plan.json`. That file is local output. It is not a plan on the site.

3. The JSON file is the `plan_drafts.body` document. `/plan/<token>` parses that JSON. Post it to the admin API as `format: "markdown"` (the column allows `markdown` or `html`, not `json`) with `sources` taken from the plan's `sources` map (`label` and `url`). `draftRecord()` in the script returns that POST body.

What the draft contains:

- A primary is a station whose stalls, power, and access are `verified`, each with a source link and a checked-on date. A station this car cannot use is not a primary. Tesla only stays Tesla only. An open Tesla site is used only when the order has a NACS port or a NACS adapter.
- Unknowns are the words `Not yet verified`, stored as objects with `status`, not as a bare string. The plan's `dataChecked` field is the earliest to latest `checkedOn` date in the draft.
- Each Tesla site that is used is flagged `tesla-only` or `open` (Tesla only, or open to all EVs). Tesla-only sites this car cannot use are named on every tier.
- Stall counts and kW. The draft does not label a site fast or slow.
- A verified backup is included when the route has a second station this car can use. If it does not, the stop has no backup named `Backup`. The stop carries the note `No verified backup at <place> yet.` On the $39 and $79 plans, that note adds `Charge to a higher level at the previous stop.` only when the stop immediately before it is a charging stop. A stop with that note, or with an unverified exit, is flagged and is not described as a verified stop.
- The summary says `N verified stops` only when every stop has a verified exit and a verified backup. Otherwise it says how many stops and how many have a verified backup.
- Food, restroom, and overnight notes are included only when the route data has them, and only on the $39 and $79 plans. A note is filed by its `type` or `category` when that field is set, and a warning or charger note (heat, offline, broken, queued) goes under cautions, not food or restrooms. A restroom note about a different station is not attached to the primary. A driver report stays labeled as a driver report.
- Order notes are included once. The plan states which stops have a sourced restroom note and which do not. A pet line is included only when the order mentions a pet, and it names the stops that have a sourced pet note.
- Membership pricing is noted only when the route has a sourced member price. Otherwise the membership line says `Price not published`.
- $39 and $79 estimate a charging strategy from the order's start battery, a stated range, a 10% reserve, and a 15% arrival target. They add charging stops or charge higher until each stop and the destination arrive at 15% or more, and they do not plan a charge above the charge limit (90% unless the order sets one). A target that cannot be met is flagged. They pick the smallest set of charging stops, prefer the highest verified kW, then a matching membership. Arrival, departure, charge time, and clock time include time plugged in. Every estimate starts with `Estimate:`. Assumptions are listed once on the plan and are not copied into the notes. $19 does not include those estimates. It does include one line that says what this tier does not estimate.
- Mileage uses an `originLegs` entry when the order's start matches one: miles, source, URL, and checked-on date. An estimated leg is labeled as an estimate and is not stored as verified. It reduces the starting battery and shifts the clock. If the named start is not the route's first point and no leg is on file, the plan says mileage starts at that first point and the first-stop numbers are optimistic.
- Departure times use `America/Los_Angeles` on California routes (`la-` and `sf-` slugs), or `timeZone` on the order or the route when that is set.
- $19 is the stops list, plus one line listing Tesla-only sites this car cannot use, and the estimate line.
- $39 adds the charging strategy, timing, backups, and the amenity notes the data actually has. Food and restroom lines are only notes that are about food or restrooms. A charger review moves to cautions and stays labeled as a driver report. Stops the strategy does not charge at are marked optional.
- $79 adds verified alternatives at each charging stop that has them, and a contingency section. If a stop is full or offline, it names the next verified station on the route in each direction and the miles between them. A low-battery fallback names the nearest verified stop ahead and behind. Sourced heat or queue notes are titled Caution. If no alternative is on the route, the plan says so once.

4. Owner review uses `ADMIN_TOKEN` and does not email the customer.

- `GET /api/admin/plans` lists requests in `new`, `review`, or `rejected-for-redo`. A redo row is labeled `Needs redo`.
- `POST /api/admin/plans/:id/draft` saves the body and sources. The request moves to `review`.
- Read the draft. `POST /api/admin/plans/:id/decision` with `{ "status": "rejected-for-redo" }` sends it back. `{ "status": "approved" }` accepts the latest draft.
- Approval returns `accessCode` once. The private page is `/plan/<accessCode>`. Only the SHA-256 hash is stored. The builder does not approve a plan and does not create that link.

Do not point these scripts at production. They have no D1 binding and no Fastmail token. Applying `schema-plan-drafts.sql` or `schema-portal.sql`, and approving a plan, are owner steps in the D1 console and the admin API.

## Plan review

`functions/api/admin/plans/[[path]].js` is the owner review API. It does not email the customer, and it does not send a plan.

Set `ADMIN_TOKEN` as a Pages secret. Every request needs `Authorization: Bearer <ADMIN_TOKEN>` or the `x-admin-token` header. If the token or the D1 binding is missing, the API returns 503.

- `GET /api/admin/plans` lists requests whose status is `new`, `review`, or `rejected-for-redo`. Redo rows include `queueLabel: "Needs redo"`.
- `GET /api/admin/plans/:id` returns that request and its drafts.
- `POST /api/admin/plans/:id/draft` saves a draft. Body: `format` (`markdown` or `html`), `body`, and `sources` (a list of `{ "label", "url" }`). The request status becomes `review`.
- `POST /api/admin/plans/:id/decision` with `{ "status": "approved" }` or `{ "status": "rejected-for-redo" }`. Approval requires a saved draft. The response includes a long random access code once. Only the SHA-256 hash is stored, on the latest draft (`plan_drafts.access_code`) and in `plan_links`. That code is the private `/plan/<code>` link. Rejection clears the hash and deletes `plan_links` for that request. Apply `schema-portal.sql` before approving. If that table is missing, approval returns 503 and the request stays in review.

Drafts live in `plan_drafts`. The statement is `schema-plan-drafts.sql`. Paste it into the D1 console for the database bound as `DB`, after `schema.sql`. Do not run it against production from a deploy or from CI.

The plan page reads JSON from `plan_drafts.body` (save it with format `markdown` or `html`; the column only allows those two). Use the same shape as a guide where you can: `title`, `summary`, `checked`, `stats`, `sources`, and `stops` with a `primary` whose `stalls`, `power`, `access`, and `price` each have `value`, `url` or `source`, and `checkedOn`. Source ids resolve through `sources` on the JSON or the draft's `sources` list. Facts without a link or a date omit that part. Unapproved drafts are never shown.

## Find my plans

`/find-my-plans` emails a one-time link to the address used at checkout. The link expires in 15 minutes, works once, and opens a list of that email's approved plans. Each list gives private `/plan/<token>` links. Tokens are 32 bytes. The database stores only SHA-256 hashes. The plan page looks up that hash. The stored hash is not itself a working link.

Pages Functions:

- `GET /api/portal` returns `{ "turnstileSiteKey" }` (or null).
- `POST /api/portal` with `{ "email", "cf-turnstile-response" }`. The JSON message is the same whether or not the email has an approved plan. Turnstile action is `find_plans` when `TURNSTILE_SECRET` is set.
- `GET /find-my-plans/open/<token>` shows a button and does not use the link up. `POST` on that URL uses it once and sets a 15-minute cookie.
- `GET /find-my-plans/list` lists approved plans for that cookie.
- `GET /plan/<token>` shows the approved plan. Unknown tokens and unapproved drafts are a 404. Responses send `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`.

The sign-in email is passed to `waitUntil` when the runtime provides it, including when there is nothing to send, so the response does not wait on Fastmail.

Rate limits, counted in D1 before the email is looked up: 3 requests per email per 15 minutes, and 10 per IP per 15 minutes. Over the limit, the response is 429 with the same message for every address. The form has the same honeypot field as intake (`website`).

Mail uses the existing Fastmail helper. From is `admin@evtripreports.com`. No new secret. The feature stays closed (503) until both `DB` and `FASTMAIL_TOKEN` are set. Turnstile uses the existing `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, and optional `TURNSTILE_HOSTNAMES`.

Tables are in `schema-portal.sql`: `plan_links`, `portal_signins`, `portal_sessions`, `portal_rate_limits`. Paste it into the D1 console. Do not run it against production from a deploy or from CI.

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
6. A row is what the site serves only when `status` is `live` and `json` is set. The export writes `live` when `src/data/routes.json` says `live` (or the older `live-ready` label) and every primary's stalls, power, and access are `verified`. A disclosed conflict on a backup or other site does not block that. Unverified, unpublished, or conflicting stalls, power, or access on a primary stays `verifying`. The build does the same: only routes that pass that gate get `/guides/<slug>/` and `/data/<slug>.json`. `verifying` is left off the homepage, the guides index, and the sitemap, and that URL 404s.
7. Confirm a guide on the preview URL, then an unknown path such as `/guides/not-a-route/`. The guide should be the D1 copy. The unknown path should be the 404 page with status 404.

The JSON in `src/data/routes/` stays in git. It is the fallback when D1 has no row, and it is what the Monday station check reads until `functions/data/[file].js` finds a live row.
