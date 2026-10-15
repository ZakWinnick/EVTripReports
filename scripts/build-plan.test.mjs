import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlan, renderPlan } from '../src/lib/render-plan.js';
import { ASSUMPTIONS, UNKNOWN, buildPlan, draftRecord, tierOf } from './build-plan.mjs';
import { FAKE_ORDER, runDryRun } from './dry-run-order.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources() {
  return {
    'ea-locator': { name: 'Electrify America locator', url: 'https://www.electrifyamerica.com/locate-charger/' },
    'tesla-findus': { name: 'Tesla Find Us', url: 'https://www.tesla.com/findus' },
    wiki: { name: 'Example route notes', url: 'https://en.wikipedia.org/wiki/Example' },
    plugshare: { name: 'PlugShare', url: 'https://www.plugshare.com/' },
  };
}

function sampleRoute() {
  return {
    slug: 'sample',
    title: 'Sample to Sample',
    highway: 'I-5',
    checked: '2026-10-15',
    startLabel: 'Start',
    endLabel: 'End',
    startNote: 'Mileage starts at the junction.',
    stats: [
      { label: 'Start to end', value: '100', unit: 'mi', source: 'wiki' },
      { label: 'DC fast sites listed', value: '12', unit: '' },
    ],
    sources: sources(),
    stops: [
      {
        id: 'alpha',
        name: 'Alpha',
        towns: 'Alpha, CA',
        mile: 40,
        milepostNote: 'Exit 40',
        why: 'First verified stop after the grade.',
        primary: {
          name: 'Walmart Alpha',
          network: 'Electrify America',
          address: '1 Main St',
          exit: 'Exit 40',
          stalls: { value: '8', status: 'verified', source: 'ea-locator', url: 'https://www.electrifyamerica.com/locate-charger/alpha/' },
          power: { value: '350 kW CCS', status: 'verified', source: 'ea-locator', url: 'https://www.electrifyamerica.com/locate-charger/alpha/' },
          access: { value: 'Open to all CCS EVs', status: 'verified', source: 'ea-locator' },
          price: { value: 'Shown in the EA app.', status: 'unpublished', source: 'ea-locator' },
          checkedOn: '2026-10-15',
          driverReports: [
            { source: 'plugshare', url: 'https://www.plugshare.com/location/1', date: '2026-10-01', summary: 'Convenience store with a restroom.' },
            { source: 'plugshare', url: 'https://www.plugshare.com/location/2', date: '2026-08-01', summary: 'Food court across the lot.' },
          ],
        },
        backups: [
          {
            name: 'Tesla Alpha',
            network: 'Tesla Supercharger',
            address: '2 Main St',
            facts: '12 stalls, up to 250 kW.',
            access: 'Open to all EVs. Non-Tesla CCS cars need a NACS adapter.',
            teslaAccess: 'open',
            status: 'verified',
            source: 'tesla-findus',
            url: 'https://www.tesla.com/findus/location/supercharger/alpha',
            checkedOn: '2026-10-15',
          },
          {
            name: 'Tesla Only Alpha',
            network: 'Tesla Supercharger',
            address: '3 Main St',
            facts: '8 stalls, up to 150 kW.',
            access: 'Tesla only',
            teslaAccess: 'tesla-only',
            status: 'verified',
            source: 'tesla-findus',
            url: 'https://www.tesla.com/findus/location/supercharger/alpha-only',
            checkedOn: '2026-10-15',
          },
          {
            name: 'Alpha EA extra',
            network: 'Electrify America',
            address: '4 Main St',
            facts: '6 stalls, 150 kW CCS.',
            access: 'Open to all CCS EVs',
            status: 'verified',
            source: 'ea-locator',
            url: 'https://www.electrifyamerica.com/locate-charger/alpha-extra/',
            checkedOn: '2026-10-15',
          },
          {
            name: 'Mystery Tesla',
            network: 'Tesla Supercharger',
            address: '5 Main St',
            facts: '10 stalls, up to 250 kW.',
            access: 'See the Tesla page.',
            status: 'verified',
            source: 'tesla-findus',
            url: 'https://www.tesla.com/findus/location/supercharger/mystery',
            checkedOn: '2026-10-15',
          },
        ],
        other: [
          { name: 'DOE mystery', facts: 'DOE lists 2 CCS at 50 kW.', status: 'unverified' },
        ],
        reports: [
          { date: '2026-09-01', source: 'wiki', text: 'Hotel next door has overnight charging in the lot.' },
        ],
        around: [],
      },
      {
        id: 'beta',
        name: 'Beta',
        towns: 'Beta, CA',
        mile: 80,
        why: 'Second stop.',
        primary: {
          name: 'Unverified Beta',
          network: 'EVgo',
          address: '9 Side St',
          stalls: { value: '4', status: 'unverified', source: 'evgo' },
          power: { value: '100 kW', status: 'verified', source: 'evgo', url: 'https://www.evgo.com/beta' },
          access: { value: 'Open to CCS', status: 'verified', source: 'evgo', url: 'https://www.evgo.com/beta' },
        },
        backups: [
          {
            name: 'Beta EA',
            network: 'Electrify America',
            address: '8 Side St',
            facts: '6 stalls, 150 kW CCS.',
            access: 'Open to all CCS EVs',
            status: 'verified',
            source: 'ea-locator',
            url: 'https://www.electrifyamerica.com/locate-charger/beta/',
            checkedOn: '2026-10-15',
          },
        ],
        other: [],
      },
      {
        id: 'closed',
        name: 'Closed',
        mile: 90,
        why: 'Tesla only site.',
        primary: {
          name: 'Closed Supercharger',
          network: 'Tesla Supercharger',
          address: '9 Road',
          stalls: { value: '8', status: 'verified', source: 'tesla-findus', url: 'https://www.tesla.com/findus/location/supercharger/closed' },
          power: { value: 'Up to 150 kW', status: 'verified', source: 'tesla-findus', url: 'https://www.tesla.com/findus/location/supercharger/closed' },
          access: { value: 'Tesla only. The page does not say other EVs can charge.', status: 'verified', source: 'tesla-findus' },
          teslaAccess: 'tesla-only',
          price: { value: 'Not captured.', status: 'unpublished', source: 'tesla-findus' },
          checkedOn: '2026-10-15',
        },
        backups: [],
        other: [],
      },
    ],
    tips: [
      { text: 'Leave a buffer before the pass.', source: 'wiki' },
      { text: 'A search returned no public DC fast sites.', source: 'wiki' },
    ],
  };
}

function order(overrides = {}) {
  return {
    slug: 'sample',
    vehicle: '2024 Hyundai Ioniq 5',
    adapter: 'CCS port, with a NACS adapter',
    memberships: ['Electrify America Pass+'],
    startBattery: 80,
    depart: '2026-11-02T08:00',
    tier: '$39',
    notes: 'One dog.',
    ...overrides,
  };
}

function generatedText(plan) {
  const bits = [plan.summary, ...(plan.assumptions || [])];
  for (const tip of plan.tips || []) bits.push(typeof tip === 'string' ? tip : tip.text);
  for (const stop of plan.stops || []) {
    if (stop.why) bits.push(stop.why);
    const primary = stop.primary || {};
    for (const key of ['target', 'leaveWith', 'targetCharge']) {
      if (primary[key]?.value) bits.push(primary[key].value);
    }
    for (const fact of primary.facts || []) {
      if (String(fact.value || '').startsWith('Estimate:')) bits.push(fact.value);
    }
  }
  return bits.join('\n');
}

function assertSourced(fact) {
  assert.notEqual(fact.value, UNKNOWN);
  assert.ok(fact.url);
  assert.match(fact.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
}

test('tier names and prices map to the three plans', () => {
  assert.equal(tierOf('$19').price, '$19');
  assert.equal(tierOf(19).id, 'basic');
  assert.equal(tierOf('Route plan').id, 'basic');
  assert.equal(tierOf('Detailed plan').price, '$39');
  assert.equal(tierOf('Multi-day or family').price, '$79');
  assert.throws(() => tierOf('$10'), /Unknown tier/);
});

test('the $19 list has a backup at each stop and no timing or amenity notes', () => {
  const plan = buildPlan(order({ tier: '$19' }), sampleRoute());
  assert.equal(plan.tier, 'Route plan ($19)');
  assert.equal(plan.assumptions, undefined);
  assert.deepEqual(plan.stops.map((stop) => stop.name), ['Alpha', 'Beta']);
  for (const stop of plan.stops) {
    assert.equal(stop.backups.length, 1);
    assert.equal(stop.primary.target, undefined);
    assert.equal(stop.food, undefined);
    assert.equal(stop.hotels, undefined);
    assert.equal(stop.other, undefined);
    assert.ok(!stop.primary.facts || stop.primary.facts.every((fact) => fact.label !== 'Restroom' && fact.label !== 'Arrival battery'));
  }
  assert.equal(plan.stops[0].backups[0].name, 'Tesla Alpha');
  assert.equal(plan.stops[0].backups[0].teslaAccess, 'open');
  assert.equal(plan.stops[1].backups[0].facts, UNKNOWN);
  assert.match(plan.tips.map((tip) => tip.text).join(' '), /Skipped Closed: Guide primary Closed Supercharger is Tesla only/);
});

test('the $39 plan adds timing, assumptions, and amenity notes that exist in the data', () => {
  const plan = buildPlan(order(), sampleRoute());
  const alpha = plan.stops[0];
  assert.equal(alpha.primary.target.value, 'Estimate: leave with at least 26% for the next 40 miles, plus a 10% buffer.');
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 64% on arrival, before charging.');
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Drive time').value, 'Estimate: 37 minutes from the start at 65 mph, arriving about 08:37.');
  const beta = plan.stops[1];
  assert.equal(beta.primary.name, 'Beta EA');
  assert.equal(beta.primary.stalls.value, '6');
  assert.equal(beta.primary.power.value, '150 kW');
  assert.equal(beta.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 48% on arrival, before charging.');
  assert.equal(beta.primary.facts.find((fact) => fact.label === 'Drive time').value, 'Estimate: 74 minutes from the start at 65 mph, arriving about 09:14.');
  assert.equal(beta.primary.target.value, 'Estimate: leave with at least 18% for the next 20 miles, plus a 10% buffer.');
  assert.equal(alpha.food[0].text, 'Food court across the lot.');
  assert.match(alpha.food[0].note, /Driver report/);
  assert.equal(alpha.food[0].url, 'https://www.plugshare.com/location/2');
  assert.equal(alpha.hotels[0].text, 'Hotel next door has overnight charging in the lot.');
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Restroom').value, 'Convenience store with a restroom.');
  assert.equal(beta.food, undefined);
  assert.equal(beta.hotels, undefined);
  assert.equal(alpha.other, undefined);
  assert.deepEqual(plan.assumptions, ASSUMPTIONS);
  assert.ok(plan.tips.some((tip) => tip.text.startsWith('Assumption:')));
  assert.equal(plan.tips.some((tip) => /If Walmart Alpha is full or offline/.test(tip.text)), false);
});

test('the $79 plan adds other verified sites and contingency notes', () => {
  const plan = buildPlan(order({ tier: '$79' }), sampleRoute());
  const names = plan.stops[0].other.map((site) => site.name);
  assert.deepEqual(names, ['Alpha EA extra']);
  assert.equal(plan.stops[0].other[0].teslaAccess, undefined);
  const tips = plan.tips.map((tip) => tip.text);
  assert.ok(tips.some((tip) => tip === 'If Walmart Alpha is full or offline, use Tesla Alpha.'));
  assert.ok(tips.some((tip) => tip === 'No verified backup at Beta. Not yet verified.'));
  assert.ok(tips.some((tip) => tip.includes('Skip Tesla Only Alpha at Alpha: Tesla only.')));
  assert.ok(tips.some((tip) => tip === 'Leave a buffer before the pass.'));
  assert.equal(tips.some((tip) => /fast|slow/i.test(tip)), false);
});

test('a Tesla uses Tesla only sites and does not use a CCS site', () => {
  const plan = buildPlan(order({
    vehicle: '2023 Model Y',
    adapter: 'NACS port (Tesla-style)',
    tier: 'Route plan',
  }), sampleRoute());
  assert.deepEqual(plan.stops.map((stop) => stop.primary.name), ['Tesla Alpha', 'Closed Supercharger']);
  assert.equal(plan.stops[0].primary.teslaAccess, 'open');
  assert.equal(plan.stops[0].backups[0].name, 'Tesla Only Alpha');
  assert.equal(plan.stops[0].backups[0].teslaAccess, 'tesla-only');
  assert.equal(plan.stops[1].primary.teslaAccess, 'tesla-only');
  assert.match(plan.stops[0].why, /not verified for this car/);
  assert.match(plan.stops[1].why, /Tesla only/);
});

test('an unflagged Tesla site and an unverified station are not used as chargers', () => {
  const plan = buildPlan(order({ tier: '$79' }), sampleRoute());
  const names = plan.stops.flatMap((stop) => [
    stop.primary.name,
    ...stop.backups.map((site) => site.name),
    ...(stop.other || []).map((site) => site.name),
  ]);
  assert.equal(names.includes('Mystery Tesla'), false);
  assert.equal(names.includes('DOE mystery'), false);
  assert.equal(names.includes('Unverified Beta'), false);
});

test('verified facts carry a source link and a checked-on date, and unknowns use the set phrase', () => {
  const plan = buildPlan(order(), sampleRoute());
  for (const stop of plan.stops) {
    for (const key of ['stalls', 'power', 'access']) assertSourced(stop.primary[key]);
    if (stop.primary.price.value !== UNKNOWN) assertSourced(stop.primary.price);
    for (const key of ['network', 'address', 'exit']) {
      const fact = stop.primary[key];
      if (typeof fact === 'string') assert.equal(fact, UNKNOWN);
      else if (fact?.value === UNKNOWN) assert.equal(fact.status, 'unverified');
      else assertSourced(fact);
    }
  }
  assert.equal(plan.stops[1].primary.price.value, UNKNOWN);
  assert.equal(plan.stops[1].backups[0].facts, UNKNOWN);
});

test('missing battery, clock, and port stay unverified instead of being filled in', () => {
  const dated = buildPlan(order({ startBattery: undefined, depart: '2026-11-02' }), sampleRoute());
  assert.equal(dated.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value, UNKNOWN);
  assert.match(dated.stops[0].primary.facts.find((fact) => fact.label === 'Drive time').value, /Departure clock time: Not yet verified/);
  const closed = buildPlan(order({ adapter: 'Not sure', tier: '$19' }), sampleRoute());
  assert.equal(closed.stops.length, 0);
  assert.equal(closed.port, UNKNOWN);
  assert.match(closed.summary, /Not yet verified/);
  assert.ok(closed.tips.some((tip) => /No charging stops were chosen/.test(tip.text)));
});

test('copy stays specific, and the same order produces the same plan', () => {
  const route = sampleRoute();
  const before = structuredClone(route);
  const first = buildPlan(order(), route);
  const second = buildPlan(order(), route);
  assert.deepEqual(route, before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const text = generatedText(first);
  assert.equal(text.includes('\u2014'), false);
  assert.equal(text.includes('\u2013'), false);
  assert.doesNotMatch(text, /\b(fast|slow)\b/i);
  assert.doesNotMatch(text, /seamless|ultimate|worry-free|peace of mind|world-class|journey/i);
  assert.match(first.summary, /Detailed plan \(\$39\)/);
  assert.match(first.summary, /Electrify America Pass\+/);
  assert.match(first.summary, /Start battery: 80%/);
  assert.match(first.tips[0].text, /Order note: One dog/);
});

test('a draft record is the JSON body the admin API stores', () => {
  const plan = buildPlan(order(), sampleRoute());
  const draft = draftRecord(plan);
  assert.equal(draft.format, 'markdown');
  assert.deepEqual(parsePlan(draft.body), plan);
  assert.ok(draft.sources.every((source) => source.label && source.url.startsWith('https://')));
  const html = renderPlan(plan);
  assert.match(html, /Walmart Alpha/);
  assert.match(html, /Tesla Alpha/);
  assert.match(html, /Estimate: about 64%/);
  assert.match(html, /Not yet verified/);
  assert.equal(html.includes('\u2014'), false);
});

test('published routes build for each tier without inventing a station', async () => {
  const list = JSON.parse(await readFile(path.join(root, 'src/data/routes.json'), 'utf8'));
  for (const meta of list) {
    const route = JSON.parse(await readFile(path.join(root, 'src/data/routes', `${meta.slug}.json`), 'utf8'));
    for (const tier of ['$19', '$39', '$79']) {
      const plan = buildPlan({
        slug: meta.slug,
        vehicle: '2024 Hyundai Ioniq 5',
        adapter: 'CCS port, with a NACS adapter',
        memberships: [],
        startBattery: 70,
        depart: '2026-11-02',
        tier,
        notes: '',
      }, route);
      assert.ok(plan.stops.length > 0, meta.slug);
      const text = generatedText(plan);
      assert.equal(text.includes('\u2014'), false, meta.slug);
      assert.doesNotMatch(text, /\b(fast|slow)\b/i, meta.slug);
      for (const stop of plan.stops) {
        assert.equal(stop.backups.length, 1);
        for (const key of ['stalls', 'power', 'access']) {
          assert.equal(stop.primary[key].status, 'verified', `${meta.slug} ${stop.name} ${key}`);
          assertSourced(stop.primary[key]);
        }
        if (/tesla|supercharger/i.test(`${stop.primary.network?.value || ''} ${stop.primary.name}`)) {
          assert.ok(stop.primary.teslaAccess === 'open' || stop.primary.teslaAccess === 'tesla-only');
        }
        const backup = stop.backups[0];
        if (backup.status === 'verified') {
          assert.ok(backup.url);
          assert.ok(backup.checkedOn);
          assert.match(backup.facts, /kW/);
          if (/tesla|supercharger/i.test(`${backup.network || ''} ${backup.name}`)) {
            assert.ok(backup.teslaAccess === 'open' || backup.teslaAccess === 'tesla-only');
          }
        } else {
          assert.equal(backup.facts, UNKNOWN);
        }
        if (tier === '$19') {
          assert.equal(stop.primary.target, undefined);
          assert.equal(stop.food, undefined);
          assert.equal(stop.other, undefined);
        }
        if (tier === '$39') assert.equal(stop.other, undefined);
        if (tier === '$79') assert.ok(plan.tips.some((tip) => tip.text.startsWith('If ') || tip.text.startsWith('No verified backup')));
      }
      if (tier !== '$19') {
        assert.ok(plan.stops[0].primary.facts.some((fact) => String(fact.value).startsWith('Estimate:')));
      }
      const html = renderPlan(plan);
      assert.match(html, new RegExp(plan.stops[0].primary.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});

test('buildPlan does not call the network', () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('network');
  };
  try {
    buildPlan(order(), sampleRoute());
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('the dry run writes a plan and does not send anything', async () => {
  const source = await readFile(path.join(root, 'scripts/dry-run-order.mjs'), 'utf8');
  const builder = await readFile(path.join(root, 'scripts/build-plan.mjs'), 'utf8');
  for (const file of [source, builder]) {
    assert.equal(file.includes('sendMail'), false);
    assert.equal(file.includes('FASTMAIL'), false);
    assert.equal(file.includes('env.DB'), false);
    assert.equal(file.includes('ADMIN_TOKEN'), false);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'plan-dry-'));
  const outPath = path.join(dir, 'plan.json');
  const lines = [];
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network');
  };
  try {
    const plan = await runDryRun({ root, outPath, log: (line) => lines.push(line), order: FAKE_ORDER });
    const written = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(written.title, plan.title);
    assert.ok(written.stops.length > 0);
    assert.match(lines[0], /Dry run only/);
    assert.match(lines.join('\n'), /LA to Las Vegas/);
    assert.equal(renderPlan(written).includes('Primary charger') || renderPlan(written).includes(written.stops[0].primary.name), true);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI writes plan JSON from two files and does not need a database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'plan-cli-'));
  const orderPath = path.join(dir, 'order.json');
  const outPath = path.join(dir, 'plan.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(orderPath, JSON.stringify(order()));
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/build-plan.mjs'),
    '--order', orderPath,
    '--route', path.join(root, 'scripts/build-plan.test.mjs'),
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);

  const routePath = path.join(dir, 'route.json');
  await writeFile(routePath, JSON.stringify(sampleRoute()));
  const built = spawnSync(process.execPath, [
    path.join(root, 'scripts/build-plan.mjs'),
    '--order', orderPath,
    '--route', routePath,
    '--out', outPath,
  ], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const plan = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(plan.stops[0].primary.name, 'Walmart Alpha');
  await rm(dir, { recursive: true, force: true });
});
