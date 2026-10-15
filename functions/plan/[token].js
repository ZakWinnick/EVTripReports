// /plan/<token>
// Private page for one approved plan. The token is 32 bytes. Only its hash is stored.
// Unapproved drafts and unknown tokens are a 404. noindex and no-referrer on every response.
export { onPlan as onRequest } from '../_lib/portal.js';
