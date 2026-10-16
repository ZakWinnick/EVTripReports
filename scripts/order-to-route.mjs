// Maps an order's start and end to a corridor we can plan, and says which way it runs.
//
//   node scripts/order-to-route.mjs --list
//   node scripts/order-to-route.mjs --start "Pasadena, CA" --end "Las Vegas, NV"
//   node scripts/order-to-route.mjs --request request.json [--out order.json]
//
// request.json is one plan request as the admin API returns it (GET /api/admin/plans/:id, either
// the whole response or just its "request" object). With --out, order.json is written for
// scripts/build-plan.mjs, but only when nothing blocks the build. A reverse trip, a port that is
// Not sure, and a trip outside our corridors exit with status 2 and write nothing.
// No database, no network, no email.

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORRIDORS, matchOrder } from '../src/lib/corridors.js';
import { orderFromRequest, reviewFlags } from '../src/lib/order-flags.js';

export function listCorridors() {
  return CORRIDORS.map((item) => `${item.slug}: ${item.from.label} to ${item.to.label} (${item.highway}), one direction only`);
}

// Returns { corridor, flags, blocked, order, buildCommand }. order is null when the build is blocked.
export function checkOrder(row, { routeDir = 'src/data/routes' } = {}) {
  const review = reviewFlags(row);
  const match = matchOrder({ start: row?.start_place ?? row?.start ?? '', end: row?.end_place ?? row?.end ?? '' });
  const forward = match.status === 'forward';
  const order = !review.blocked && forward ? orderFromRequest(row, match.slug) : null;
  return {
    corridor: review.corridor,
    flags: review.flags,
    blocked: review.blocked || !forward,
    order,
    buildCommand: order ? `node scripts/build-plan.mjs --order order.json --route ${routeDir}/${match.slug}.json --out plan.json` : '',
  };
}

function parseArgs(argv) {
  const out = { list: false, start: '', end: '', request: '', out: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') out.list = true;
    else if (arg === '--start') out.start = argv[++i] || '';
    else if (arg === '--end') out.end = argv[++i] || '';
    else if (arg === '--request') out.request = argv[++i] || '';
    else if (arg === '--out') out.out = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.list && !args.request && !(args.start && args.end))) {
    console.error('Usage: node scripts/order-to-route.mjs --list | --start "A" --end "B" | --request request.json [--out order.json]');
    process.exit(args.help ? 0 : 1);
  }
  if (args.list) {
    console.log(listCorridors().join('\n'));
    return;
  }
  let row = { start: args.start, end: args.end, port: 'CCS port, no adapter' };
  if (args.request) {
    const parsed = JSON.parse(await readFile(args.request, 'utf8'));
    row = parsed.request || parsed;
  }
  const result = checkOrder(row);
  const corridor = result.corridor.status === 'unmatched' ? 'none' : `${result.corridor.title} (${result.corridor.slug}), ${result.corridor.status}`;
  console.log(`Corridor: ${corridor}`);
  for (const flag of result.flags) console.log(`${flag.blocking ? 'BLOCKED' : 'Note'}: ${flag.label}`);
  if (result.blocked) {
    if (!args.start) console.log('No order written. Supported corridors:');
    console.log(listCorridors().join('\n'));
    process.exit(2);
  }
  if (args.request) {
    if (args.out) {
      await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
      await writeFile(args.out, `${JSON.stringify(result.order, null, 2)}\n`);
      console.log(`Wrote ${args.out}`);
    } else {
      console.log(JSON.stringify(result.order, null, 2));
    }
  }
  console.log(`Next: ${result.buildCommand}`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
