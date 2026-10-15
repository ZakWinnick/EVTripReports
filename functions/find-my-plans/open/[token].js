// /find-my-plans/open/<token>
// GET shows a button. POST uses the one-time link, which expires 15 minutes after it was sent.
export { onOpen as onRequest } from '../../_lib/portal.js';
