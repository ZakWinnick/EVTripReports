// Live guides that the Astro build publishes under /guides/<slug>/.
// Same gate as src/pages/guides/[slug].astro: routes.json approval plus verified primaries.
// The sitemap function reads the generated list and merges D1 rows on top.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { exportStatus } from './publish-status.js';
import { lastmodDate } from './lastmod-date.js';

export { lastmodDate };

export async function liveBuiltGuides(root = process.cwd()) {
  const dir = path.join(root, 'src/data/routes');
  const list = JSON.parse(await readFile(path.join(root, 'src/data/routes.json'), 'utf8'));
  const listed = new Map(list.map((route) => [route.slug, route.status]));
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const guides = [];
  for (const file of files) {
    const route = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    if (!route?.slug || exportStatus(listed.get(route.slug), route) !== 'live') continue;
    const guide = { slug: route.slug };
    const lastmod = lastmodDate(route.checked);
    if (lastmod) guide.lastmod = lastmod;
    guides.push(guide);
  }
  guides.sort((a, b) => a.slug.localeCompare(b.slug));
  return guides;
}
