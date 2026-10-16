// Email signup markup shared by the footer and guide pages.
// The Buttondown key stays in the Pages Function. Nothing in this file can see it.

const COPY = 'New corridor guides and charger changes on the routes we cover. No spam.';
const NOTE = 'Emails go to Buttondown, which sends these updates.';

export function newsletterForm(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('newsletter form id');
  return `<form class="newsletter" id="${id}" method="post" action="/api/subscribe" novalidate>
<p class="newsletter__copy" id="${id}-copy">${COPY}</p>
<div class="newsletter__row">
<label class="sr" for="${id}-email">Email</label>
<input id="${id}-email" name="email" type="email" required autocomplete="email" autocapitalize="none" autocorrect="off" inputmode="email" maxlength="254" placeholder="Email" aria-describedby="${id}-copy ${id}-note" />
<button class="pill" type="submit">Sign Up</button>
</div>
<label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off" /></label>
<div class="newsletter__slot" hidden></div>
<p class="newsletter__note" id="${id}-note">${NOTE} <a href="/privacy/">Privacy</a></p>
<p class="newsletter__msg" role="status" aria-live="polite"></p>
</form>`;
}
