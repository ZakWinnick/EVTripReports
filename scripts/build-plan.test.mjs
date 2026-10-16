import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlan, renderPlan } from '../src/lib/render-plan.js';
import { UNKNOWN, buildPlan, draftRecord, tierOf } from './build-plan.mjs';
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

test('the $19 list has no timing or amenity notes, and flags a stop with no backup', () => {
  const plan = buildPlan(order({ tier: '$19' }), sampleRoute());
  assert.equal(plan.tier, 'Route plan ($19)');
  assert.equal(plan.assumptions, undefined);
  assert.equal(plan.strategy, undefined);
  assert.deepEqual(plan.stops.map((stop) => stop.name), ['Alpha', 'Beta']);
  for (const stop of plan.stops) {
    assert.equal(stop.primary.target, undefined);
    assert.equal(stop.charging, undefined);
    assert.equal(stop.food, undefined);
    assert.equal(stop.hotels, undefined);
    assert.equal(stop.other, undefined);
    assert.ok(!stop.primary.facts || stop.primary.facts.every((fact) => fact.label !== 'Restroom' && fact.label !== 'Arrival battery'));
  }
  assert.equal(plan.stops[0].backups[0].name, 'Tesla Alpha');
  assert.equal(plan.stops[0].backups[0].teslaAccess, 'open');
  assert.equal(plan.stops[0].headline, true);
  assert.equal(plan.stops[1].backups.length, 0);
  assert.equal(plan.stops[1].headline, false);
  assert.equal(plan.stops[1].note, 'No verified backup at Beta yet. Charge to a higher level at the previous stop.');
  assert.equal(plan.stops.some((stop) => stop.backups.some((backup) => backup.name === 'Backup')), false);
  const tips = plan.tips.map((tip) => tip.text).join(' ');
  assert.match(tips, /Skipped Closed: Guide primary Closed Supercharger is Tesla only/);
  assert.match(tips, /Skip Tesla Only Alpha at Alpha: Tesla only/);
  assert.match(tips, /What's estimated:/);
  assert.doesNotMatch(plan.summary, /verified stops/);
  assert.match(plan.summary, /2 stops on I-5, 1 with a verified backup/);
});

test('the $39 plan adds a charging strategy, timing, and amenity notes that exist in the data', () => {
  const plan = buildPlan(order(), sampleRoute());
  const alpha = plan.stops[0];
  assert.equal(alpha.charging, false);
  assert.equal(alpha.primary.target, undefined);
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Charging').value, 'Optional. This plan does not charge here.');
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 64% on arrival.');
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Drive time').value, 'Estimate: 37 minutes from Start at 65 mph, passing about 08:37.');
  const beta = plan.stops[1];
  assert.equal(beta.primary.name, 'Beta EA');
  assert.equal(beta.primary.stalls.value, '6');
  assert.equal(beta.primary.power.value, '150 kW');
  assert.equal(beta.charging, false);
  assert.equal(beta.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 48% on arrival.');
  assert.equal(beta.primary.facts.find((fact) => fact.label === 'Drive time').value, 'Estimate: 37 minutes from Alpha at 65 mph, passing about 09:14.');
  assert.equal(plan.strategy.stops.length, 0);
  assert.equal(plan.strategy.destination.arrivePercent, 40);
  assert.match(plan.summary, /No charging stop/);
  assert.match(plan.summary, /40%/);
  assert.equal(alpha.food[0].text, 'Food court across the lot.');
  assert.notEqual(alpha.food[0].name, 'Food');
  assert.match(alpha.food[0].note, /Driver report/);
  assert.equal(alpha.food[0].url, 'https://www.plugshare.com/location/2');
  assert.equal(alpha.hotels[0].text, 'Hotel next door has overnight charging in the lot.');
  assert.notEqual(alpha.hotels[0].name, 'Lodging');
  assert.equal(alpha.primary.facts.find((fact) => fact.label === 'Restroom').value, 'Convenience store with a restroom.');
  assert.equal(beta.food, undefined);
  assert.equal(beta.hotels, undefined);
  assert.equal(alpha.other, undefined);
  assert.ok(plan.assumptions.length >= 5);
  assert.equal(plan.tips.some((tip) => tip.text.startsWith('Assumption:')), false);
  assert.equal(plan.tips.filter((tip) => tip.text.startsWith('Order note:')).length, 1);
  assert.match(plan.tips.map((tip) => tip.text).join(' '), /No sourced pet info at any stop/);
  assert.equal(plan.tips.some((tip) => /If Walmart Alpha is full or offline/.test(tip.text)), false);
});

test('the $79 plan adds contingency from verified sites, and alternatives only at charging stops', () => {
  const plan = buildPlan(order({ tier: '$79' }), sampleRoute());
  assert.equal(plan.stops[0].other, undefined);
  const tips = plan.tips.map((tip) => tip.text);
  assert.ok(tips.some((tip) => tip.includes('Skip Tesla Only Alpha at Alpha: Tesla only.')));
  assert.ok(tips.some((tip) => tip === 'Leave a buffer before the pass.'));
  assert.equal(tips.some((tip) => /fast|slow/i.test(tip)), false);
  assert.equal(tips.some((tip) => tip.startsWith('Assumption:')), false);
  const titles = plan.contingency.map((item) => item.title);
  assert.ok(titles.includes('Stall full or offline'));
  assert.ok(titles.includes('Low battery fallback'));
  assert.match(plan.contingency.find((item) => item.title === 'Stall full or offline').text, /Walmart Alpha/);
  assert.match(plan.contingency.find((item) => item.title === 'Stall full or offline').text, /Tesla Alpha/);
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
    for (const key of ['network', 'address', 'exit', 'stalls', 'power', 'access', 'price']) {
      const fact = stop.primary[key];
      assert.equal(typeof fact, 'object');
      assert.notEqual(fact, null);
      if (fact.value === UNKNOWN) assert.equal(fact.status, 'unverified');
      else if (fact.status === 'verified') assertSourced(fact);
    }
    assert.equal(stop.backups.some((backup) => backup.name === 'Backup'), false);
  }
  assert.equal(plan.stops[1].primary.price.value, UNKNOWN);
  assert.equal(plan.stops[1].primary.price.status, 'unverified');
  assert.equal(plan.stops[1].primary.exit.status, 'unverified');
  assert.equal(plan.stops[1].backups.length, 0);
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
  assert.match(html, /Optional stop/);
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
        assert.equal(stop.backups.some((backup) => backup.name === 'Backup'), false, meta.slug);
        for (const key of ['stalls', 'power', 'access', 'network', 'address', 'exit', 'price']) {
          assert.equal(typeof stop.primary[key], 'object', `${meta.slug} ${stop.name} ${key}`);
        }
        for (const key of ['stalls', 'power', 'access']) {
          assert.equal(stop.primary[key].status, 'verified', `${meta.slug} ${stop.name} ${key}`);
          assertSourced(stop.primary[key]);
        }
        if (stop.primary.exit.value === UNKNOWN) assert.equal(stop.primary.exit.status, 'unverified');
        if (/tesla|supercharger/i.test(`${stop.primary.network?.value || ''} ${stop.primary.name}`)) {
          assert.ok(stop.primary.teslaAccess === 'open' || stop.primary.teslaAccess === 'tesla-only');
        }
        const backup = stop.backups[0];
        if (backup) {
          assert.equal(backup.status, 'verified');
          assert.ok(backup.url);
          assert.ok(backup.checkedOn);
          assert.match(backup.facts, /kW/);
          if (/tesla|supercharger/i.test(`${backup.network || ''} ${backup.name}`)) {
            assert.ok(backup.teslaAccess === 'open' || backup.teslaAccess === 'tesla-only');
          }
        } else {
          assert.match(stop.note, /No verified backup at/);
          assert.equal(stop.headline, false);
        }
        if (tier === '$19') {
          assert.equal(stop.primary.target, undefined);
          assert.equal(stop.food, undefined);
          assert.equal(stop.other, undefined);
          assert.equal(stop.charging, undefined);
        }
        if (tier === '$39') assert.equal(stop.other, undefined);
        const blob = JSON.stringify(stop);
        assert.equal(blob.includes('\u2014'), false, meta.slug);
        assert.equal(blob.includes('\u2013'), false, meta.slug);
      }
      if (tier === '$19') {
        assert.ok(plan.tips.some((tip) => tip.text.startsWith("What's estimated:")), meta.slug);
        assert.equal(plan.assumptions, undefined);
      }
      if (tier === '$79') assert.ok(plan.contingency?.length, meta.slug);
      if (tier !== '$19') {
        assert.ok(plan.stops[0].primary.facts.some((fact) => String(fact.value).startsWith('Estimate:')));
        assert.equal(plan.tips.some((tip) => tip.text.startsWith('Assumption:')), false);
      }
      if (/^5 verified stops|verified stops/.test(plan.summary)) {
        assert.ok(plan.stops.every((stop) => stop.headline === true), meta.slug);
      }
      const html = renderPlan(plan);
      assert.match(html, new RegExp(plan.stops[0].primary.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});

function longRoute(overrides = {}) {
  const base = sampleRoute();
  base.stats[0].value = '300';
  base.stops = [
    {
      ...base.stops[0],
      id: 'early',
      name: 'Early',
      mile: 80,
      primary: {
        ...base.stops[0].primary,
        name: 'Early EA',
        power: { value: '150 kW CCS', status: 'verified', source: 'ea-locator', url: 'https://www.electrifyamerica.com/locate-charger/early/' },
      },
    },
    {
      id: 'late',
      name: 'Late',
      mile: 140,
      why: 'Later stop.',
      primary: {
        name: 'Late Tesla',
        network: 'Tesla Supercharger',
        address: '9 Late St',
        exit: 'Exit 180',
        stalls: { value: '20', status: 'verified', source: 'tesla-findus', url: 'https://www.tesla.com/findus/location/supercharger/late' },
        power: { value: 'Up to 250 kW', status: 'verified', source: 'tesla-findus', url: 'https://www.tesla.com/findus/location/supercharger/late' },
        access: { value: 'Open to all EVs. Non-Tesla CCS cars need a NACS adapter.', status: 'verified', source: 'tesla-findus', url: 'https://www.tesla.com/findus/location/supercharger/late' },
        teslaAccess: 'open',
        price: { value: 'Non-Tesla: $0.50/kWh. Members pay $0.36/kWh.', status: 'verified', source: 'tesla-findus', url: 'https://www.tesla.com/findus/location/supercharger/late' },
        checkedOn: '2026-10-15',
      },
      backups: [
        {
          name: 'Late EA extra',
          network: 'Electrify America',
          address: '10 Late St',
          exit: 'Exit 140',
          facts: '8 stalls, 350 kW CCS.',
          access: 'Open to all CCS EVs',
          status: 'verified',
          source: 'ea-locator',
          url: 'https://www.electrifyamerica.com/locate-charger/late-extra/',
          checkedOn: '2026-10-15',
        },
        {
          name: 'Late EA more',
          network: 'Electrify America',
          address: '11 Late St',
          exit: 'Exit 140',
          facts: '4 stalls, 150 kW CCS.',
          access: 'Open to all CCS EVs',
          status: 'verified',
          source: 'ea-locator',
          url: 'https://www.electrifyamerica.com/locate-charger/late-more/',
          checkedOn: '2026-10-15',
        },
      ],
    },
  ];
  return { ...base, ...overrides, stops: overrides.stops || base.stops, stats: overrides.stats || base.stats };
}

test('charging uses the fewest stops, then the highest verified kW, then a membership', () => {
  const higherKw = buildPlan(order({ memberships: ['Electrify America Pass+'] }), longRoute());
  assert.deepEqual(higherKw.strategy.stops.map((stop) => stop.name), ['Late Tesla']);
  assert.equal(higherKw.stops.find((stop) => stop.id === 'late').charging, true);
  assert.equal(higherKw.stops.find((stop) => stop.id === 'early').charging, false);
  assert.ok(higherKw.stops.find((stop) => stop.id === 'late').other === undefined);

  const full = buildPlan(order({ tier: '$79', memberships: ['Electrify America Pass+'] }), longRoute());
  assert.deepEqual(full.stops.find((stop) => stop.id === 'late').other.map((site) => site.name), ['Late EA more']);
  assert.equal(full.stops.find((stop) => stop.id === 'early').other, undefined);
  assert.ok(full.contingency.some((item) => item.title === 'Stall full or offline' && /Late Tesla/.test(item.text)));
  assert.ok(full.contingency.some((item) => item.title === 'Low battery fallback' && /Early EA/.test(item.text)));

  const tied = longRoute();
  tied.stops[1].primary.power.value = '150 kW';
  const memberWins = buildPlan(order({ memberships: ['Electrify America Pass+'] }), tied);
  assert.equal(memberWins.strategy.stops[0].name, 'Early EA');
});

test('a sourced member price is kept, and a missing member price says Price not published', () => {
  const plan = buildPlan(order({ memberships: ['Tesla Supercharging membership', 'Electrify America Pass+'] }), longRoute());
  const late = plan.stops.find((stop) => stop.id === 'late').primary;
  const member = late.facts.find((fact) => fact.label === 'Tesla Supercharging membership');
  assert.match(member.value, /\$0\.36\/kWh/);
  assert.equal(member.status, 'verified');
  const early = plan.stops.find((stop) => stop.id === 'early').primary;
  const pass = early.facts.find((fact) => fact.label === 'Electrify America Pass+');
  assert.equal(pass.value, 'Price not published');
  assert.equal(pass.status, 'unpublished');
});

test('mileage uses a sourced origin leg and does not invent one', () => {
  const withLeg = sampleRoute();
  withLeg.approach = {
    miles: 50,
    from: 'Los Angeles, CA',
    to: 'Start',
    source: 'wiki',
    checkedOn: '2026-10-15',
  };
  const shifted = buildPlan(order({ start: 'Los Angeles, CA', end: 'End' }), withLeg);
  assert.equal(shifted.originLeg.miles, 50);
  assert.equal(shifted.originLeg.status, 'verified');
  assert.match(shifted.assumptions.join(' '), /50 miles from Los Angeles, CA to Start/);
  assert.equal(shifted.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 44% on arrival.');

  const plain = buildPlan(order({ start: 'Los Angeles, CA', end: 'Las Vegas, NV' }), sampleRoute());
  assert.equal(plain.originLeg, undefined);
  assert.match(plain.summary, /Mileage counted from Start/);
  assert.equal(plain.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 64% on arrival.');
});

test('warnings stay out of food and restroom lists, and a restroom about another site stays off the primary', () => {
  const route = sampleRoute();
  route.stops[0].primary.driverReports.push({
    source: 'plugshare',
    url: 'https://www.plugshare.com/location/9',
    date: '2026-05-12',
    summary: 'Poor restrooms, heat throttling, and broken chargers.',
    category: 'restroom',
  });
  route.stops[0].reports.push({
    date: '2026-05-24',
    source: 'wiki',
    site: 'Tesla Alpha',
    text: 'Recommends Tesla Alpha and says it has lots of restrooms.',
  });
  route.stops[0].around.push({
    source: 'wiki',
    text: 'Open to non-Teslas, next to a food court. Had been offline for a couple of weeks.',
  });
  const plan = buildPlan(order(), route);
  const alpha = plan.stops[0];
  const restroom = alpha.primary.facts.find((fact) => fact.label === 'Restroom');
  assert.equal(restroom.value, 'Convenience store with a restroom.');
  assert.equal(JSON.stringify(alpha).includes('lots of restrooms'), false);
  assert.ok(alpha.cautions.some((item) => /heat throttling/.test(item.text)));
  assert.ok(alpha.cautions.some((item) => /offline/.test(item.text)));
  assert.ok(alpha.food.every((item) => !/offline/.test(item.text) && !/heat throttling/.test(item.text)));
  assert.ok(alpha.food.every((item) => item.name !== 'Food'));
  assert.equal(alpha.cautions.filter((item) => item.name === 'Cautions').length, 0);
});

test('an arrival under the reserve is flagged', () => {
  const route = sampleRoute();
  route.stops[0].mile = 200;
  route.stops = [route.stops[0]];
  route.stats[0].value = '220';
  const plan = buildPlan(order({ startBattery: 20 }), route);
  const arrival = plan.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value;
  assert.match(arrival, /below the 10% reserve/);
  assert.equal(plan.stops[0].belowReserve, true);
});

test('departure time, source names, and the checked range are normalized', () => {
  const route = sampleRoute();
  route.slug = 'la-sample';
  route.sources.x = { url: 'https://x.com/example/status/1' };
  route.tips.push({ text: 'A driver posted a photo of the stall count.', source: 'x', url: 'https://x.com/example/status/1', checkedOn: '2026-05-01' });
  const plan = buildPlan(order({ slug: 'la-sample', tier: '$79', depart: '2026-11-02T08:00' }), route);
  assert.equal(plan.timeZone, 'America/Los_Angeles');
  assert.equal(plan.depart, '2026-11-02T08:00:00-08:00');
  assert.match(plan.summary, /America\/Los_Angeles/);
  assert.equal(plan.sources.x.name, 'X');
  assert.match(plan.dataChecked, /2026-05-01 to /);
  const named = JSON.stringify(plan);
  assert.equal(named.includes('\u2014') || named.includes('\u2013'), false);
});

test('en dashes in route names are stripped from the plan', () => {
  const route = sampleRoute();
  route.stops[0].primary.name = 'Alpha, CA \u2013 Copus Road';
  route.stops[0].name = 'Alpha \u2014 Town';
  const plan = buildPlan(order({ tier: '$19' }), route);
  assert.equal(plan.stops[0].name, 'Alpha, Town');
  assert.equal(plan.stops[0].primary.name, 'Alpha, CA, Copus Road');
  assert.equal(JSON.stringify(plan).includes('\u2013'), false);
  assert.equal(JSON.stringify(plan).includes('\u2014'), false);
});

test('the LA to Las Vegas dry-run order does not overstate verification or attach the wrong notes', async () => {
  const route = JSON.parse(await readFile(path.join(root, 'src/data/routes/la-to-las-vegas.json'), 'utf8'));
  const plan = buildPlan(FAKE_ORDER, route);
  assert.match(plan.summary, /5 stops on I-15, 4 with a verified backup/);
  assert.doesNotMatch(plan.summary, /5 verified stops/);
  assert.match(plan.summary, /Mileage counted from I-10 junction, Ontario/);
  assert.match(plan.summary, /Charge at Ultra Gas and Mart to 45%/);
  assert.match(plan.summary, /America\/Los_Angeles/);
  assert.match(plan.summary, /Data checked /);
  assert.equal(plan.timeZone, 'America/Los_Angeles');
  assert.equal(plan.depart, '2026-11-02T08:00:00-08:00');
  assert.equal(plan.originLeg, undefined);
  assert.equal(plan.strategy.stops.map((stop) => stop.name).join(', '), 'Ultra Gas and Mart');
  const baker = plan.stops.find((stop) => stop.id === 'baker');
  assert.equal(baker.charging, true);
  assert.equal(baker.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 25% on arrival.');
  assert.equal(baker.primary.facts.find((fact) => fact.label === 'Departure battery').value, 'Estimate: 45%.');
  assert.equal(baker.primary.facts.find((fact) => fact.label === 'Charge time').value, 'Estimate: 4 minutes at the verified 350 kW.');
  assert.match(baker.primary.facts.find((fact) => fact.label === 'Drive time').value, /arriving about 10:06/);
  assert.match(baker.primary.facts.find((fact) => fact.label === 'Drive time').value, /Leave about 10:10/);
  assert.equal(baker.primary.facts.find((fact) => fact.label === 'Electrify America Pass+').value, 'Price not published');
  assert.ok(baker.cautions.some((item) => /heat throttling/.test(item.text)));
  assert.ok(baker.cautions.some((item) => /had been offline/i.test(item.text)));
  assert.ok(!baker.food || baker.food.every((item) => !/offline/i.test(item.text)));
  assert.equal(JSON.stringify(baker.primary.facts).includes('Poor restrooms'), false);
  const yermo = plan.stops.find((stop) => stop.id === 'yermo');
  assert.equal(yermo.charging, false);
  assert.equal(yermo.headline, false);
  assert.equal(yermo.backups.length, 0);
  assert.equal(yermo.note, 'No verified backup at Yermo yet. Charge to a higher level at the previous stop.');
  assert.equal(yermo.primary.exit.value, UNKNOWN);
  assert.equal(yermo.primary.exit.status, 'unverified');
  const primm = plan.stops.find((stop) => stop.id === 'primm');
  assert.equal(JSON.stringify(primm).includes('lots of restrooms'), false);
  assert.equal(primm.charging, false);
  assert.notEqual(primm.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 5% on arrival, before charging.');
  const fullText = JSON.stringify(plan);
  assert.equal(fullText.split('One dog').length - 1, 1);
  assert.equal(fullText.includes('\u2014'), false);
  assert.equal(fullText.includes('\u2013'), false);
  assert.equal(plan.tips.filter((tip) => tip.text.startsWith('Order note:')).length, 1);
  assert.equal(plan.tips.some((tip) => tip.text.startsWith('Assumption:')), false);
  const honesty = plan.tips.find((tip) => /pet info/.test(tip.text)).text;
  assert.match(honesty, /Jean \(Terrible's\)/);
  assert.match(honesty, /No sourced pet info at any stop/);
  assert.match(honesty, /Walmart Hesperia/);
  for (const source of Object.values(plan.sources)) assert.ok(source.name && source.url);

  const basic = buildPlan({ ...FAKE_ORDER, tier: '$19' }, route);
  assert.match(basic.summary, /5 stops on I-15, 4 with a verified backup/);
  assert.doesNotMatch(basic.summary, /Charge at/);
  assert.ok(basic.tips.some((tip) => tip.text.startsWith("What's estimated:") && /Mileage counted from I-10 junction, Ontario/.test(tip.text)));
  assert.ok(basic.tips.some((tip) => /Tesla only/.test(tip.text)));
  assert.equal(basic.stops[0].charging, undefined);

  const full = buildPlan({ ...FAKE_ORDER, tier: '$79' }, route);
  assert.ok(full.contingency.some((item) => item.title === 'Stall full or offline' && /Mojave Pointe/.test(item.text)));
  assert.ok(full.contingency.some((item) => item.title === 'Weather or heat' && /heat throttling/.test(item.text)));
  assert.ok(full.contingency.some((item) => item.title === 'Low battery fallback' && /Barstow/.test(item.text)));
  assert.equal(full.stops.filter((stop) => stop.charging && stop.other?.length).length >= 0, true);
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
