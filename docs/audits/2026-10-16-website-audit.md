> Follow-up: the local implementation is documented in [the preview notes](2026-10-16-field-guide-preview.md). Zak clarified that custom plans can cover any trip; published-guide coverage is not a product limit. The observations below describe the pre-redesign site.

# EVTripReports website audit

Date: October 16, 2026. Scope: public website, current repository, desktop browser inspection, and narrow-width layout measurements of downloaded public HTML/CSS.

## Assessment

The site has a useful research foundation and a coherent basic visual system. Its biggest weaknesses are prioritization, editorial judgment, product presentation, and the buying journey. A visitor sees extensive evidence of how research is collected but too little help choosing what to do. Preserve the source discipline and lightweight Astro architecture. Redesign the presentation around planning a trip and choosing a charging stop.

This is a qualitative audit, not a conversion-rate study. No customer order, subscription, email, or payment was submitted. Private plan delivery and live payment processing were not tested. Mobile measurements use 390px-wide local browser frames of public HTML/CSS with scripts removed; they are not physical-device or mobile transaction tests. Desktop screenshots are DOM-render captures, not pixel-perfect device captures.

## 1. Make the homepage useful immediately

Observed: the hero leads with “A travel agent for EVs,” a long explanatory paragraph, and a primary link to LA–Las Vegas. A full featured-route section comes before the directory of ten routes. On the narrow-width snapshot, “Route guides” starts around 1,733px down the page. The homepage contains no photographic imagery or product preview.

Recommendation:

- Lead with the customer's outcome: a road trip with charging stops worked out for their car.
- Offer two clear paths: find a free guide and get a custom plan.
- Put a compact route finder near the top. With ten routes, a city search and region filters are sufficient; a complex routing engine is unnecessary.
- Show a real sample plan early, with the car, primary charger, backup, and relevant charging estimate clearly labeled.
- Follow with selected guides, a short explanation of the custom service, a founder introduction, and concise FAQs.
- Put research methodology behind a short trust statement and an accessible detail link.

Suggested order: header → outcome + route finder → useful sample → popular guides → custom-plan offer → Zak's experience → FAQ → footer.

## 2. Give the site an identifiable visual direction

Observed: oversized black headlines, white and light-gray bands, black pill buttons, generic bordered cards, and repeated source labels dominate. The typography and palette are consistent, but the page has little sense of place, travel, or personal service.

Recommendation: a practical road-trip field guide. Keep the strong readability and restrained green. Add warm paper tones, geographic route illustrations, and a small number of authentic road/charging/destination photographs. Use compact highway labels, clear maps, and useful stop information as recurring visual elements. Reduce oversized section padding, especially around the featured route. Use one dominant action per section. Put a real face and founder voice behind the service.

The About page already contains a useful differentiator: Zak's EV charging work and 15 years in hospitality. Bring that into the homepage and purchase page. Do not fabricate testimonials, route-driving experience, or customer counts.

## 3. Turn the guides into decisions readers can act on

Observed on the live LA–Las Vegas guide:

- About 4,005 visible words and 61 rendered driver-report entries.
- Five stop areas, with eight backups and thirteen driver reports under the first stop.
- Desktop document height about 16,167px at the inspected browser width.
- In the narrow-width snapshot, the first stop begins around 1,377px and the second around 7,331px; the whole page is about 26,152px tall.
- The route line links to stops, but there is no persistent stop navigator.
- No guide links matched maps, directions, print, or download destinations.

Recommendation:

- Add an overview: route boundaries, vehicle/adapter considerations, major gaps, and the few decisions that matter.
- Show a concise recommended stop card: why stop here, compatibility, charger facts, practical amenities, one useful backup, and directions.
- Keep critical warnings visible. Put additional alternatives, historical driver reports, and detailed sources behind expandable sections.
- Summarize recent driver reports with dates and scope. Historical reports should not look like current operating status.
- Add a sticky stop navigator, map links, and a print-friendly view.
- Keep the dated sourcing model. Explain that checked specifications are not live availability.

Success criterion: a reader should be able to identify the relevant primary, backup, compatibility requirements, and map action without reading the entire stop section.

## 4. Fix route naming and mileage expectations

Observed on the live guide directory:

- “LA to San Francisco”: I-5 at SR-14 to Livermore outlets, 317 miles.
- “NYC to Boston”: George Washington Bridge to Foxborough, 197 miles.
- “LA to Phoenix”: East LA Interchange to Buckeye, 344 miles.
- “SF to Lake Tahoe”: San Francisco to central Truckee.

These endpoints are disclosed inside the directory, but homepage cards present the city names and distance without that qualification. The cards also call the stop areas “charging stops,” which can imply a driver needs every stop; LA–San Diego, for example, advertises five charging stops.

Recommendation: distinguish corridor mileage from the visitor's complete trip. Put covered endpoints on the card, or extend the guide through its named destination. Use “charging areas covered” or “places to charge” when the guide is a directory of options. Personal plans should identify required versus optional stops.

## 5. Show the paid product before asking for the order

Observed: /plans/ presents intro → comparison table → supported corridors → a long intake form → sample → FAQs. The sample begins around 3,914px on desktop and its heading around 4,630px in the narrow-width snapshot. Fourteen visible non-checkbox fields precede the submit action, plus six membership checkboxes. The pricing buttons say “Pay” but only select a tier and jump to the form. Selecting the $39 tier correctly changes the form and submit label.

Recommendation:

1. Show a complete, clearly labeled sample near the top, with a short explanation of what the buyer receives.
2. Check route, direction, and departure date first. Explain unsupported trips before collecting personal details.
3. Present concise plan cards with an optional detailed comparison. Use “Choose Route plan” and equivalent labels.
4. Collect vehicle/adapter information, then optional travel preferences, then show a review and payment step.
5. Carry a selected guide's route into the form automatically.
6. Explain return-trip scope and delivery timing before checkout.

Keep current pricing until demand and fulfillment effort support a change. The audit provides no evidence for a new price.

## 6. Correct trust and fulfillment inconsistencies first

### Payment success is controlled by a URL flag

Opening /plans/?paid=1 directly displays “Payment received” and changes the form to “Send trip details” without a payment. This was reproduced on the public site. The three pricing buttons also remain visibly rendered despite having the hidden attribute: their CSS display value is flex.

Fix: derive confirmation from a verified order/session status. Show pending verification when appropriate and provide one clear next action. Correct hidden-state styling. This observation does not establish a bypass of payment records or access to an approved plan.

Source: src/pages/plans.astro, especially the paid query-string check and the paid branch; shared .pill styling in src/styles/global.css.

### Sales promises exceed what the generator guarantees

The sales page promises a backup at every stop and says a plan adds target departure charge. The builder explicitly allows “No verified backup” and calculates charging targets only for the detailed and full tiers. Food and lodging output is conditional on available sourced material.

Fix: align each tier's copy with the actual deliverable and add a pre-delivery completeness check for required inclusions. If human review fills a gap, make that an explicit fulfillment requirement; this audit did not inspect delivered customer plans.

Sources: src/pages/plans.astro; scripts/build-plan.mjs, including buildStrategy gating and buildStop's tier-specific fields.

### Corrections should not enter the purchase flow

The About page tells users to use the paid request form for corrections, though email is also offered. The form requires car, route, dates, and tier selection.

Fix: a small “Report an issue with this stop” action with the route and stop prefilled, or a dedicated correction email link.

### Newsletter capture is currently unavailable

The public subscription configuration returns open:false, and the newsletter sections are hidden in the live page. This is a missing retention opportunity, not a broken visible signup form.

Fix: enable only when the mailing service and intended publishing workflow are ready, then offer specific route updates where useful.

## 7. Preserve the technical strengths and address focused gaps

Observed strengths: the sampled public pages returned HTTP 200, an invented guide returned a real 404, the sitemap responded, self-hosted font and static-page architecture keep the implementation lean, and the styles include visible keyboard focus, a skip link, and reduced-motion support. These checks are not a full accessibility, security, SEO, or performance certification.

Follow-up improvements:

- Accessibility: the desktop route SVG contains links but is aria-hidden; the alternative route list is hidden at desktop widths. Supply an always-accessible stop list or properly named navigation links. Verify keyboard and screen-reader behavior after redesign.
- SEO/social: add route-specific social images, clear descriptive titles, suitable guide structured data, and useful related-route links. Canonicals, descriptions, a sitemap, and a shared social image already exist.
- Measurement: the repository loads Tinylytics, but the inspected app code has no dedicated funnel events. Track guide discovery, sample views, tier choice, intake completion, checkout, and verified paid orders without personal trip data. Inspect actual analytics before claiming conversion problems.
- Performance: keep images responsive and compressed, reserve image dimensions, and lazy-load below-the-fold imagery. No Lighthouse or field Core Web Vitals score was measured.

## Recommended delivery order

| Order | Work | Acceptance condition |
| --- | --- | --- |
| 1 | Payment confirmation, hidden-state fix, tier promises, route labels, correction flow | Public copy and displayed transaction states match the actual product and order status |
| 2 | One polished LA–Las Vegas guide and a complete sample plan | Primary decision, backup, compatibility, evidence, and directions are easy to find on desktop and mobile |
| 3 | Homepage and guide directory using the same design language | Visitors can find a relevant route or understand the custom service near the top |
| 4 | Guided intake and clearer tier selection | Eligibility checked early, selected route retained, price and delivery clear before payment |
| 5 | Roll out remaining guides, newsletter, social previews, and funnel measurement | Consistent templates, visible operational signup, and measured user journeys |

Start by designing the homepage, one guide, and the sample-plan presentation together. These three surfaces establish the promise, demonstrate the free value, and show what someone is paying for. Further route expansion can then use the improved template.

## Evidence

Public URLs reviewed: https://evtripreports.com/ ; /guides/ ; /guides/la-to-las-vegas/ ; /plans/ ; /plans/?paid=1 ; /find-my-plans/. About, FAQ, methodology, layout, CSS, guide rendering, intake, and plan generation were also inspected in source.

Desktop captures: /Users/zakwinnick/Downloads/evtripreports-audit-home.png and /Users/zakwinnick/Downloads/evtripreports-audit-guide.png. Narrow-width figures came from DOM geometry; the capture tool did not render the nested-frame screenshots correctly, so those captures are excluded from evidence.
