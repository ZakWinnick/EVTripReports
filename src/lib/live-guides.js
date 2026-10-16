// Live guides that the Astro build publishes under /guides/<slug>/.
// Same gate as src/pages/guides/[slug].astro: routes.json approval plus verified primaries.
// The sitemap function reads the generated list and merges D1 rows on top.
// liveBuiltGuideIndex() is the /guides/ catalog (title, ends, distance).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { guideIndexRecord } from './guide-index.js';
import { exportStatus } from './publish-status.js';
import { lastmodDate } from './lastmod-date.js';

export { lastmodDate };

async function publishedRoutes(root) {
  const dir = path.join(root, 'src/data/routes');
  const list = JSON.parse(await readFile(path.join(root, 'src/data/routes.json'), 'utf8'));
  const listed = new Map(list.map((route) => [route.slug, route.status]));
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
  const bySlug = new Map();
  for (const file of files) {
    const route = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    if (route?.slug) bySlug.set(route.slug, route);
  }
  const live = [];
  for (const item of list) {
    const route = bySlug.get(item?.slug);
    if (!route || exportStatus(listed.get(route.slug), route) !== 'live') continue;
    live.push(route);
  }
  return live;
}

export async function liveBuiltGuides(root = process.cwd()) {
  const guides = [];
  for (const route of await publishedRoutes(root)) {
    const guide = { slug: route.slug };
    const lastmod = lastmodDate(route.checked);
    if (lastmod) guide.lastmod = lastmod;
    guides.push(guide);
  }
  guides.sort((a, b) => a.slug.localeCompare(b.slug));
  return guides;
}

// routes.json order, same publish gate as the slug pages.
export async function liveBuiltGuideIndex(root = process.cwd()) {
  return (await publishedRoutes(root))
    .map((route) => guideIndexRecord(route))
    .filter((guide) => guide.slug && guide.title);
}
