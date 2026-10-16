// Shared Turnstile loader for the plan form, Find my plans, and the newsletter.
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
  const id = win.turnstile.render(slot, {
    sitekey,
    action,
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

function fieldValue(form, name) {
  const el = form.querySelector(`[name="${name}"]`);
  return el ? String(el.value || '') : '';
}

export function mountNewsletterForms(doc = globalThis.document, win = globalThis.window) {
  const forms = Array.prototype.slice.call(doc.querySelectorAll('form.newsletter'));
  if (!forms.length) return;
  const widgets = new WeakMap();

  function setOpen(open) {
    forms.forEach((form) => {
      const band = form.closest('.newsletter-band');
      form.hidden = !open;
      if (band) band.hidden = !open;
    });
  }

  setOpen(false);

  win.fetch('/api/subscribe').then((res) => {
    if (!res.ok) return null;
    return res.json();
  }).then((body) => {
    if (!body || body.open !== true) return;
    setOpen(true);
    const sitekey = body && body.turnstileSiteKey;
    if (!sitekey) return;
    return loadTurnstile(doc, win).then(() => {
      forms.forEach((form) => {
        const slot = form.querySelector('.newsletter__slot');
        if (!slot || !win.turnstile) return;
        widgets.set(form, renderWidget(slot, { sitekey, action: 'newsletter_signup' }, win));
      });
    });
  }).catch(() => {});

  forms.forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = form.querySelector('.newsletter__msg');
      const btn = form.querySelector('button[type="submit"]');
      if (!msg || !btn || btn.disabled) return;
      msg.className = 'newsletter__msg';
      msg.textContent = '';
      if (!form.checkValidity()) {
        msg.textContent = 'Enter an email address.';
        msg.classList.add('is-err');
        const bad = form.querySelector(':invalid');
        if (bad) bad.focus();
        return;
      }
      const widget = widgets.get(form);
      const data = { email: fieldValue(form, 'email').trim() };
      const honey = fieldValue(form, 'website');
      if (honey) data.website = honey;
      if (widget) {
        const token = widget.getToken();
        if (!token) {
          msg.textContent = SECURITY_RETRY;
          msg.classList.add('is-err');
          widget.reset();
          return;
        }
        data['cf-turnstile-response'] = token;
      }
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending';
      win.fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      }).then((res) => res.json().catch(() => ({})).then((body) => ({ res, body }))).then((out) => {
        if (out.res.ok) {
          form.reset();
          msg.textContent = out.body.already ? 'That email is already signed up.' : 'Check your email to confirm.';
          msg.classList.add('is-ok');
        } else if (out.res.status === 403) {
          msg.textContent = SECURITY_RETRY;
          msg.classList.add('is-err');
        } else if (out.res.status === 503 || out.res.status === 404 || out.res.status === 405) {
          msg.textContent = out.body.error || 'Newsletter signup is not open yet.';
          msg.classList.add('is-err');
        } else {
          msg.textContent = out.body.error || 'Signup did not go through. Try again.';
          msg.classList.add('is-err');
        }
      }).catch(() => {
        msg.textContent = 'Signup did not go through because the connection dropped. Try again.';
        msg.classList.add('is-err');
      }).then(() => {
        btn.disabled = false;
        btn.textContent = label;
        const current = widgets.get(form);
        if (current) current.reset();
      });
    });
  });
}
