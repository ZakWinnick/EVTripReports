> Current product direction: promote custom planning and one sample plan only. The guide directory and planning-page route catalog are retired. `/guides/` redirects to `/sample-plan/`; existing individual guide URLs and research remain available for references. Earlier design notes below describe superseded iterations.

# Field-guide redesign: local review

Local preview: http://127.0.0.1:4321/

Status: implemented locally on `codex/field-guide-redesign`. No commit, push, deployment, or production data change was made.

## Scope

- Homepage, all ten published guides, guide directory, dedicated sample plan, and custom-plan selection/intake.
- A restrained editorial layout with system Georgia headings, a compact searchable route directory, source-backed Baker notes, and mobile layouts. The decorative map cards, Fraunces font, oversized slogans, and monogram were removed after the first visual review.
- Station facts and a backup option stay prominent. Additional backups, dated driver reports, route facts, long exit notes, and sources remain available in expandable sections. Printing expands those sections and restores their state afterward.
- Existing route research was preserved. This design pass did not recheck station conditions.

## Trust corrections

- Published guides are examples, not a restriction on custom trips. Both the form and request handler accept new routes and reverse directions. The queue identifies research needed; it does not silently substitute a forward guide for a reverse trip. The builder accepts separately researched custom-route files.
- A checkout-return URL cannot prove payment. The return panel says so, directs customers to their receipt/order help, and prevents duplicate intake submission from that state.
- Copy distinguishes available backups from guaranteed backups and identifies which tiers include battery estimates. Covered mileage boundaries and the difference between charging areas and required stops are visible.
- Corrections go to a dedicated email link with route/stop context.
- The sample uses the customer draft builder with a fictional traveler, explicit range assumptions, historical source dates, and visible missing facilities information.
- The existing newsletter configuration gate remains intact.

## Verification

- Production build: 23 pages, successful.
- Automated tests: 206 passed, zero failed. Includes intake acceptance, builder safeguards, payment handling, source preservation, publication gates, and existing portal/security tests.
- Browser checks: homepage, directory, sample, plans, and all ten guides at 320, 390, and 1150 pixel frame widths. No page overflow or missing in-page anchor targets. Additional tablet visual inspection at 768 pixels.
- Exercised guide search (including I95), region filters, clear/empty states, mobile menu Escape behavior, arbitrary and reverse trip continuation, departure validation, checkout-return visibility, and print disclosure expansion/restoration.
- No production order, payment, email, or newsletter submission was performed. The local Astro preview does not run the Cloudflare database/payment services; those handlers were exercised with the automated test fixtures.

The temporary responsive-review harness was removed from the build. The local preview server remains available for review.

## Second visual pass

The homepage now opens with the service description and a route directory instead of a decorative hero. Plain copy replaces the repeated slogans on the guides, sample, and plans page. Station facts, source dates, correction links, sample assumptions, and custom-trip acceptance remain intact. All 14 main pages were checked again at phone and desktop widths. No deployment was performed.

## Homepage service concept

Local concept following feedback on the first two visual directions. The homepage now leads with custom trip planning for any route, one explicitly illustrative Ontario-to-Las Vegas journey, an annotated Baker charging stop, the founder introduction, and three pricing rows. All ten researched guides remain in the separate guide library. New styling is scoped to the homepage; the other pages retain their previous preview design.

The sample uses the existing plan builder and dated station records. Estimates, assumptions, source dates, missing facilities, and live-status limitations remain visible. Homepage pricing links preselect the corresponding intake tier, with unknown values falling back to Route plan; a paid-return URL still hides intake without claiming payment.

Verification: visual review on desktop and at 320, 390, and 768 pixels; overflow and anchor checks also at 1150 pixels. Tier selection checked for all three options and an unknown value. No checkout, charge, order submission, or publication was performed.
