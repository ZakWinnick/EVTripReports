// Shared response for private plan pages: noindex, no-referrer, not cached.
import { esc } from '../../src/lib/render-guide.js';

export function privateHeaders() {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
}

function bareDocument(title, main) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)} | EV Trip Reports</title></head><body><main id="main">${main}</main></body></html>`;
}

export async function renderPrivatePage(env, request, { title, description, main, status = 200 }) {
  const headers = privateHeaders();
  let shell = null;
  try {
    if (env.ASSETS) shell = await env.ASSETS.fetch(new Request(new URL('/portal-shell/index.html', request.url)));
  } catch (e) {
    console.error('portal shell missing', e.message);
    shell = null;
  }
  if (!shell || !shell.ok || typeof HTMLRewriter === 'undefined') {
    return new Response(bareDocument(title, main), { status, headers });
  }

  const fullTitle = `${title} | EV Trip Reports`;
  const out = new HTMLRewriter()
    .on('title', { element: (e) => e.setInnerContent(fullTitle) })
    .on('meta[name="description"]', { element: (e) => e.setAttribute('content', description) })
    .on('meta[property="og:title"]', { element: (e) => e.setAttribute('content', fullTitle) })
    .on('meta[property="og:description"]', { element: (e) => e.setAttribute('content', description) })
    .on('meta[property="og:url"]', { element: (e) => e.remove() })
    .on('link[rel="canonical"]', { element: (e) => e.remove() })
    .on('meta[name="robots"]', { element: (e) => e.setAttribute('content', 'noindex, nofollow') })
    .on('script', {
      element(e) {
        if (typeof e.getAttribute !== 'function') return;
        const src = e.getAttribute('src') || '';
        if (src.includes('tinylytics')) e.remove();
      },
    })
    .on('main#main', { element: (e) => e.setInnerContent(main, { html: true }) })
    .transform(shell);
  return new Response(out.body, { status, headers });
}

export async function privateNotFound(env, request) {
  const headers = privateHeaders();
  try {
    if (env.ASSETS) {
      const page = await env.ASSETS.fetch(new Request(new URL('/404.html', request.url)));
      if (page && page.ok) return new Response(page.body, { status: 404, headers });
    }
  } catch (e) {
    console.error('404 page missing', e.message);
  }
  return new Response('Page not found', { status: 404, headers });
}
