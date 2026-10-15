// Prints SQL for the D1 `routes` table. Writes nothing to Cloudflare.
// The owner runs the output in the D1 console. Do not point this at production from a script.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { exportStatus, primaryPublishBlock } from '../src/lib/publish-status.js';

const root = process.cwd();
const dir = path.join(root, 'src/data/routes');
const list = JSON.parse(await readFile(path.join(dir, '../routes.json'), 'utf8'));
const order = new Map(list.map((r, i) => [r.slug, i]));
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

const q = (s) => String(s).replaceAll("'", "''");

console.log('-- Local export of src/data/routes. Apply schema-routes.sql first.');
console.log('-- Paste into the D1 console for the database already bound to Pages as DB.');
console.log('-- Insert every row in one pass. A partial table replaces the whole homepage card list.');
console.log('BEGIN TRANSACTION;');

for (const file of files) {
  const route = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
  const meta = list.find((r) => r.slug === route.slug);
  // Live when routes.json approves it and every primary's stalls, power, and access are verified.
  // A disclosed conflict on a backup or other site does not block that.
  // Unverified, unpublished, or conflicting primary stalls, power, or access stays verifying.
  const block = primaryPublishBlock(route);
  const status = exportStatus(meta?.status, route);
  if ((meta?.status === 'live' || meta?.status === 'live-ready') && block) {
    console.error(`-- ${route.slug} stays verifying: ${block}`);
  }
  const sort = ((order.get(route.slug) ?? 100) + 1) * 10;
  const json = q(JSON.stringify(route));
  const sql = `INSERT INTO routes (slug, title, highway, status, sort, json, updated_at) VALUES ('${q(route.slug)}', '${q(route.title)}', '${q(route.highway)}', '${status}', ${sort}, '${json}', datetime('now')) ON CONFLICT(slug) DO UPDATE SET title = excluded.title, highway = excluded.highway, status = excluded.status, sort = excluded.sort, json = excluded.json, updated_at = excluded.updated_at;`;
  if (Buffer.byteLength(sql) > 100000) {
    console.error(`-- SKIP ${route.slug}: statement is over D1's 100KB query limit`);
    continue;
  }
  console.log(sql);
}

console.log('COMMIT;');
