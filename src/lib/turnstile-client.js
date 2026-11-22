// Shared Turnstile loader for the plan form and Find My Plans.
// One page can host several widgets. They must share a single api.js tag: a second
// copy logs "already has been loaded" and the later challenge never finishes.
export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const SECURITY_RETRY = 'The security check failed. Try again.';
const PENDING = '__etrTurnstile';

function apiReady(win) {
  return !!(win.turnstile && typeof win.turnstile.render === 'function');
}

function settlePending(win, promise) {
  promise.finally(() => {
    if (win[PENDING] === promise) delete win[PENDING];
  });
  win[PENDING] = promise;
  return promise;
}

export function loadTurnstile(doc = globalThis.document, win = globalThis.window) {
  if (apiReady(win)) return Promise.resolve(win.turnstile);
  if (win[PENDING]) return win[PENDING];

  const existing = doc.querySelector('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]');
  if (existing) {
    return settlePending(win, new Promise((resolve, reject) => {
      const done = () => {
        if (apiReady(win)) resolve(win.turnstile);
        else reject(new Error('turnstile'));
      };
      if (typeof existing.addEventListener === 'function') {
        existing.addEventListener('load', done, { once: true });
        existing.addEventListener('error', () => reject(new Error('turnstile')), { once: true });
      }
      const previous = existing.onload;
      existing.onload = (event) => {
        if (typeof previous === 'function') previous.call(existing, event);
        done();
      };
    }));
  }

  return settlePending(win, new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () => {
      if (apiReady(win)) resolve(win.turnstile);
      else reject(new Error('turnstile'));
    };
    script.onerror = () => reject(new Error('turnstile'));
    doc.head.appendChild(script);
  }));
}

export function revealTurnstileSlot(slot) {
  slot.hidden = false;
  if (typeof slot.removeAttribute === 'function') slot.removeAttribute('hidden');
  if (typeof slot.getBoundingClientRect === 'function') slot.getBoundingClientRect();
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

export function renderWidget(slot, { sitekey, action }, win = globalThis.window) {
  revealTurnstileSlot(slot);
  let token = '';
  // The normal widget is 300px wide and pushes the page sideways on a 320px screen.
  const narrow = Number(win.innerWidth) > 0 && Number(win.innerWidth) < 360;
  const id = win.turnstile.render(slot, {
    sitekey,
    action,
    size: narrow ? 'compact' : 'normal',
    appearance: 'always',
    'response-field': true,
    'response-field-name': 'cf-turnstile-response',
    callback(value) { token = nonempty(value); },
    'expired-callback'() { token = ''; },
    'error-callback'() { token = ''; },
  });
  return {
    id,
    getToken() {
      const fromCallback = nonempty(token);
      if (fromCallback) return fromCallback;
      if (id != null && win.turnstile && typeof win.turnstile.getResponse === 'function') {
        try {
          const fromApi = nonempty(win.turnstile.getResponse(id));
          if (fromApi) return fromApi;
        } catch {
          // A stale id throws. The hidden input still holds the issued token.
        }
      }
      const input = typeof slot.querySelector === 'function'
        ? slot.querySelector('input[name="cf-turnstile-response"]')
        : null;
      return nonempty(input && input.value);
    },
    reset() {
      token = '';
      if (id != null && win.turnstile && typeof win.turnstile.reset === 'function') win.turnstile.reset(id);
    },
  };
}
