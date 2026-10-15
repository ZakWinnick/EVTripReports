// Builds a plan from a fake order and the route JSON in this repo.
// Prints a summary and writes the plan body. No database and no email.

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPlan, planSummary } from './build-plan.mjs';

export const FAKE_ORDER = {
  slug: 'la-to-las-vegas',
  vehicle: '2024 Hyundai Ioniq 5',
  adapter: 'CCS port, with a NACS adapter',
  memberships: ['Electrify America Pass+'],
  startBattery: 80,
  depart: '2026-11-02T08:00',
  tier: '$39',
  notes: 'One dog. Prefer a stop with a restroom when the guide lists one.',
  start: 'Los Angeles, CA',
  end: 'Las Vegas, NV',
  passengers: '2 adults, 1 dog',
};

export async function runDryRun({ root, outPath, log = () => {}, order = FAKE_ORDER } = {}) {
  const routePath = path.join(root, 'src/data/routes', `${order.slug}.json`);
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  const plan = buildPlan(order, route);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`);
  log('Dry run only. No database writes. No email.');
  log(planSummary(plan));
  log(`Wrote ${outPath}`);
  return plan;
}

function parseArgs(argv) {
  let out = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[++i] || '';
    else if (argv[i] === '--help' || argv[i] === '-h') return { help: true, out };
  }
  return { help: false, out };
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error('Usage: node scripts/dry-run-order.mjs [--out scripts/out/dry-run-plan.json]');
    process.exit(0);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outPath = path.resolve(args.out || path.join(root, 'scripts/out/dry-run-plan.json'));
  runDryRun({ root, outPath, log: (line) => console.log(line) }).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
