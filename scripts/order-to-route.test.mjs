import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPlan, OrderBlockedError } from './build-plan.mjs';
import { checkOrder, listCorridors } from './order-to-route.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/order-to-route.mjs');
const request = (over = {}) => ({
  id: 3, tier: 'Detailed plan', car: '2024 Hyundai Ioniq 5', port: 'CCS port, with a NACS adapter', start_place: 'Pasadena, CA', end_place: 'Las Vegas, NV',
  depart: '2026-11-02T08:00', return_date: '', memberships: 'Electrify America Pass+', notes: '[Start battery: 70%]', passengers: '', ...over,
});

test('the list names all ten live corridors and not the hidden one', () => {
  const lines = listCorridors();
  assert.equal(lines.length, 10);
  assert.equal(lines.some((line) => /chicago/i.test(line)), false);
});

test('a forward order maps to a route file and builds a plan', async () => {
  const result = checkOrder(request());
  assert.equal(result.blocked, false);
  assert.match(result.buildCommand, /src\/data\/routes\/la-to-las-vegas\.json/);
  const route = JSON.parse(await readFile(path.join(root, 'src/data/routes/la-to-las-vegas.json'), 'utf8'));
  const plan = buildPlan(result.order, route);
  assert.ok(plan.stops.length > 0);
  assert.match(plan.summary, /Start battery: 70%/);
});

test('reverse, unknown port, and unknown corridor write no order', () => {
  for (const over of [{ start_place: 'Las Vegas, NV', end_place: 'Los Angeles, CA' }, { port: 'Not sure' }, { start_place: 'Boise, ID', end_place: 'Reno, NV' }]) {
    const result = checkOrder(request(over));
    assert.equal(result.blocked, true);
    assert.equal(result.order, null);
    assert.equal(result.buildCommand, '');
  }
  const reverse = checkOrder(request({ start_place: 'Las Vegas, NV', end_place: 'Los Angeles, CA' }));
  assert.throws(() => buildPlan({ ...request(), slug: 'la-to-las-vegas', vehicle: 'x', adapter: 'CCS port, no adapter', start: 'Las Vegas, NV', end: 'Los Angeles, CA', tier: '$39' }, JSON.parse('{"slug":"la-to-las-vegas","title":"LA to Las Vegas","stops":[]}')), OrderBlockedError);
  assert.equal(reverse.corridor.status, 'reverse');
});

test('the command line lists, checks, and exits 2 when blocked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'etr-o2r-'));
  try {
    const listed = spawnSync(process.execPath, [script, '--list'], { encoding: 'utf8' });
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /dallas-to-austin/);
    const file = path.join(dir, 'request.json');
    const out = path.join(dir, 'order.json');
    await writeFile(file, JSON.stringify({ request: request() }));
    const ok = spawnSync(process.execPath, [script, '--request', file, '--out', out], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const order = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(order.slug, 'la-to-las-vegas');
    assert.equal(order.startBattery, 70);
    await writeFile(file, JSON.stringify(request({ start_place: 'Las Vegas', end_place: 'LA' })));
    const blockedOut = path.join(dir, 'blocked.json');
    const blocked = spawnSync(process.execPath, [script, '--request', file, '--out', blockedOut], { encoding: 'utf8' });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stdout, /BLOCKED: Needs manual build: reverse direction/);
    await assert.rejects(readFile(blockedOut));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the built plans page lists the live corridors and not the hidden one', async () => {
  const html = await readFile(path.join(root, 'dist/plans/index.html'), 'utf8');
  const section = html.slice(html.indexOf('Some roads we’ve researched'));
  for (const line of ['Los Angeles to Las Vegas', 'Dallas to Austin', 'Washington, DC to New York City']) assert.ok(section.includes(line), line);
  assert.equal(/Chicago/.test(section.slice(0, 3000)), false);
  assert.match(html, /name="startBattery"/);
  assert.match(html, /name="departTime"/);
  assert.equal(html.includes('\u2014') || html.includes('\u2013'), false);
});
