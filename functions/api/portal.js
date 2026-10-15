// /api/portal
// GET  returns the Turnstile site key, or null when it is unset.
// POST { email, cf-turnstile-response } emails a one-time Find my plans link.
// The JSON message is the same whether or not that email has an approved plan.
// Requires the DB binding and FASTMAIL_TOKEN. Mail is sent from admin@evtripreports.com.
export { onApi as onRequest } from '../_lib/portal.js';
