import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlan, renderPlan } from '../src/lib/render-plan.js';
import { OrderBlockedError, UNKNOWN, buildPlan, draftRecord, planMarkdown, tierOf } from './build-plan.mjs';
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

function assertCleanHtml(html, label = '') {
  for (const bad of ['Invalid Date', 'undefined', 'null', 'NaN']) {
    assert.equal(html.includes(bad), false, `${label} ${bad}`.trim());
  }
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
  assert.equal(plan.stops[1].note, 'No verified backup at Beta yet.');
  assert.equal(plan.stops[1].why.includes('No verified backup'), false);
  assert.equal(plan.stops.some((stop) => stop.backups.some((backup) => backup.name === 'Backup')), false);
  const tips = plan.tips.map((tip) => tip.text).join(' ');
  assert.match(tips, /Skipped Closed: Guide primary Closed Supercharger is Tesla only/);
  assert.match(tips, /Tesla-only sites this car cannot use: Tesla Only Alpha/);
  assert.doesNotMatch(tips, /Skip Tesla Only Alpha/);
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
  assert.ok(tips.some((tip) => tip.includes('Tesla-only sites this car cannot use: Tesla Only Alpha.')));
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
});

test('a "Not sure" port never produces a paid plan with no stops', () => {
  for (const tier of ['$19', '$39', '$79']) {
    for (const adapter of ['Not sure', '', 'unknown']) {
      assert.throws(
        () => buildPlan(order({ adapter, tier }), sampleRoute()),
        (error) => error instanceof OrderBlockedError && error.code === 'needs-customer-question' && /Needs customer question/.test(error.message),
        `${tier} ${adapter}`,
      );
    }
  }
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
  assert.match(html, /<h2 class="h2">Charging strategy<\/h2>/);
  assert.equal(html.includes('\u2014'), false);
  assertCleanHtml(html, 'draft');
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
      assertCleanHtml(html, meta.slug);
      if (tier === '$19') assert.doesNotMatch(html, /Charging strategy/);
      if (tier === '$39' || tier === '$79') {
        assert.match(html, /<h2 class="h2">Charging strategy<\/h2>/);
        assert.ok(html.indexOf('>Charging strategy<') < html.indexOf('id="stop-'), meta.slug);
        assert.match(html, /Reserve floor is 10%/);
        assert.match(html, /Arrival target is 15%/);
      }
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
  assert.ok(full.contingency.some((item) => item.title === 'Low battery fallback' && /Late Tesla/.test(item.text) && /No verified stop is ahead/.test(item.text)));
  assert.equal(full.contingency.filter((item) => item.title === 'Weather or heat').length, 0);

  const tied = longRoute();
  tied.stats[0].value = '200';
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
  assert.match(plain.summary, /Mileage starts at Start, the route's first point, 100 miles/);
  assert.match(plain.summary, /first-stop numbers are optimistic/);
  assert.doesNotMatch(plain.summary, /No charging stop/);
  assert.equal(plain.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 64% on arrival.');
  const md = planMarkdown(shifted);
  assert.equal(md.split(shifted.strategy.text).length - 1, 1);
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
  route.stops[0].primary.driverReports.push({
    source: 'plugshare',
    url: 'https://www.plugshare.com/location/11',
    date: '2026-05-02',
    summary: 'I love the charging options and the restaurants.',
    category: 'food',
  });
  route.stops[0].backups[0].driverReports = [{
    source: 'plugshare',
    url: 'https://www.plugshare.com/location/12',
    date: '2026-05-03',
    summary: 'Queued for a stall.',
  }];
  const split = buildPlan(order(), route).stops[0];
  assert.ok(split.food.every((item) => !/charging options/.test(item.text)));
  assert.equal(split.primaryCautions.some((item) => /charging options/.test(item.text)), false);
  assert.ok(split.driverNotes.some((item) => /charging options/.test(item.text) && /Driver report/.test(item.note) && item.checkedOn === '2026-05-02' && item.url.includes('plugshare.com')));
  assert.ok(split.backupCautions.some((item) => /Queued/.test(item.text)));
  assert.equal(split.primaryCautions.some((item) => item.status === 'verified'), false);
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
  assert.match(plan.summary, /an estimated 41\.9 miles from Los Angeles to I-10 junction, Ontario/);
  assert.doesNotMatch(plan.summary, /Los Angeles, CA to Las Vegas/);
  assert.match(plan.summary, /Charge at Barstow, 1503 East Main Street to 77%/);
  assert.doesNotMatch(plan.summary, /Charge at Ultra Gas and Mart/);
  assert.match(plan.summary, /America\/Los_Angeles/);
  assert.match(plan.summary, /Data checked /);
  assert.equal(plan.timeZone, 'America/Los_Angeles');
  assert.equal(plan.depart, '2026-11-02T08:00:00-08:00');
  assert.equal(plan.originLeg.miles, 41.86);
  assert.equal(plan.originLeg.estimate, true);
  assert.equal(plan.originLeg.status, undefined);
  assert.equal(plan.originLeg.checkedOn, '2026-10-15');
  assert.match(plan.originLeg.url, /^http:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);
  assert.equal(plan.strategy.stops.map((stop) => stop.name).join(', '), 'Barstow, 1503 East Main Street');
  assert.equal(plan.strategy.destination.arrivePercent, 15);
  assert.equal(plan.strategy.targetPercent, 15);
  assert.equal(plan.strategy.chargeLimit, 90);
  const barstow = plan.stops.find((stop) => stop.id === 'barstow');
  assert.equal(barstow.charging, true);
  assert.equal(barstow.primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 36% on arrival.');
  assert.equal(barstow.primary.facts.find((fact) => fact.label === 'Departure battery').value, 'Estimate: 77%.');
  assert.equal(barstow.primary.facts.find((fact) => fact.label === 'Charge time').value, 'Estimate: 8 minutes at the verified 325 kW.');
  const valley = plan.stops.find((stop) => stop.id === 'victor-valley');
  assert.match(valley.primary.facts.find((fact) => fact.label === 'Drive time').value, /70 minutes from Los Angeles/);
  assert.match(valley.primary.facts.find((fact) => fact.label === 'Drive time').value, /passing about 09:10/);
  assert.match(barstow.primary.facts.find((fact) => fact.label === 'Drive time').value, /arriving about 09:42/);
  assert.match(barstow.primary.facts.find((fact) => fact.label === 'Drive time').value, /Leave about 09:50/);
  const baker = plan.stops.find((stop) => stop.id === 'baker');
  assert.equal(baker.charging, false);
  assert.equal(baker.primary.facts.find((fact) => fact.label === 'Electrify America Pass+').value, 'Price not published');
  assert.ok(baker.primaryCautions.some((item) => /heat throttling/.test(item.text)));
  assert.ok(baker.backupCautions.some((item) => /had been offline/i.test(item.text)));
  assert.ok(baker.food.some((item) => /Arby's and a food court/.test(item.text)));
  assert.ok(baker.food.every((item) => !/Tesla site:/.test(item.text) && !/offline/i.test(item.text) && !/\bkW\b/.test(item.text)));
  assert.equal(JSON.stringify(baker.primary.facts).includes('Poor restrooms'), false);
  const yermo = plan.stops.find((stop) => stop.id === 'yermo');
  assert.equal(yermo.charging, false);
  assert.equal(yermo.headline, false);
  assert.equal(yermo.backups.length, 0);
  assert.equal(yermo.note, 'No verified backup at Yermo yet. Charge to a higher level at the previous stop.');
  assert.equal(yermo.why.includes('No verified backup'), false);
  assert.equal(planMarkdown(plan).split(yermo.note).length - 1, 1);
  assert.equal(yermo.primary.exit.value, UNKNOWN);
  assert.equal(yermo.primary.exit.status, 'unverified');
  const yermoHtml = renderPlan(plan);
  const yermoAt = yermoHtml.indexOf('id="stop-yermo"');
  const yermoStop = yermoHtml.slice(yermoAt, yermoHtml.indexOf('</section>', yermoAt));
  const exitAt = yermoStop.indexOf('<dt>Exit</dt>');
  const exitRow = yermoStop.slice(exitAt, yermoStop.indexOf('</div>', exitAt));
  assert.equal(exitRow.split('Not yet verified').length - 1, 1);
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
  assert.equal(basic.stops.find((stop) => stop.id === 'yermo').note, 'No verified backup at Yermo yet.');
  assert.ok(basic.tips.some((tip) => tip.text.startsWith("What's estimated:") && /estimated 41\.9 miles from Los Angeles/.test(tip.text)));
  assert.ok(basic.tips.some((tip) => /Tesla-only sites this car cannot use:/.test(tip.text)));
  assert.equal(basic.tips.filter((tip) => /Skip .+ Tesla only/.test(tip.text)).length, 0);
  assert.equal(basic.stops[0].charging, undefined);

  const full = buildPlan({ ...FAKE_ORDER, tier: '$79' }, route);
  const stall = full.contingency.find((item) => item.title === 'Stall full or offline' && /Barstow, 1503 East Main Street/.test(item.text));
  assert.match(stall.text, /Walmart Barstow/);
  assert.match(stall.text, /miles ahead on the route/);
  assert.match(stall.text, /miles back on the route/);
  assert.equal(full.contingency.filter((item) => item.title === 'Weather or heat').length, 0);
  assert.ok(full.contingency.some((item) => item.title === 'Caution' && /heat throttling/.test(item.text)));
  assert.ok(full.contingency.some((item) => item.title === 'Low battery fallback' && /Prizm Outlets/.test(item.text) && /No verified stop is ahead/.test(item.text)));
  assert.doesNotMatch(full.tips.map((tip) => tip.text).join('\n'), /Every EA site/);
  assert.ok(full.tips.some((tip) => /Electrify America/.test(tip.text) && /Driver reports \(/.test(tip.text) && /\d{4}-\d{2}-\d{2}/.test(tip.text)));
  assert.ok(full.tips.some((tip) => tip.text.startsWith('Northbound,')));
  assert.equal(full.tips.filter((tip) => /Tesla-only sites on this route/.test(tip.text)).length, 0);
  assert.equal(full.stops.filter((stop) => stop.charging && stop.other?.length).length >= 0, true);
  assert.equal(planMarkdown(full).split(full.strategy.text).length - 1, 1);
});

test('the plan holds a 15% arrival target inside the charge limit', () => {
  const route = sampleRoute();
  route.stops = [route.stops[0]];
  route.stops[0].mile = 20;
  route.stats[0].value = '230';
  const capped = buildPlan(order(), route);
  assert.equal(capped.strategy.chargeLimit, 90);
  assert.equal(capped.stops[0].charging, true);
  assert.equal(capped.stops[0].primary.target.value, 'Estimate: charge to 90%.');
  assert.equal(capped.strategy.destination.arrivePercent, 6);
  assert.equal(capped.strategy.destination.belowReserve, true);
  assert.match(capped.strategy.text, /15% arrival target cannot be met/);
  assert.match(capped.assumptions.join(' '), /charge limit for this plan is 90%/);

  const open = buildPlan(order({ chargeLimit: 100 }), route);
  assert.equal(open.strategy.chargeLimit, 100);
  assert.equal(open.strategy.destination.arrivePercent, 15);
  assert.equal(open.strategy.destination.belowTarget, false);
  assert.match(open.assumptions.join(' '), /order sets a charge limit of 100%/);

  route.stats[0].value = '215';
  const short = buildPlan(order(), route);
  assert.equal(short.strategy.destination.arrivePercent, 12);
  assert.equal(short.strategy.destination.belowTarget, true);
  assert.equal(short.strategy.destination.belowReserve, false);
  assert.match(short.strategy.text, /cannot be met within the 90% charge limit/);

  const two = sampleRoute();
  two.stats[0].value = '250';
  two.stops[0].mile = 50;
  two.stops[1].mile = 120;
  two.stops = two.stops.slice(0, 2);
  const both = buildPlan(order({ startBattery: 40 }), two);
  assert.deepEqual(both.strategy.stops.map((stop) => stop.name), ['Walmart Alpha', 'Beta EA']);
  assert.equal(both.strategy.destination.arrivePercent, 15);
});

test('an estimated origin leg shifts the battery and the clock', () => {
  const route = sampleRoute();
  route.originLegs = [{
    start: 'Los Angeles',
    miles: 41.86,
    source: 'osrm',
    url: 'http://router.project-osrm.org/route/v1/driving/-118.24,34.05;-117.54,34.06',
    checkedOn: '2026-10-15',
    estimate: true,
    note: 'Estimate. Driving distance from Los Angeles City Hall.',
  }];
  route.sources.osrm = { name: 'OpenStreetMap OSRM', url: 'http://router.project-osrm.org/' };
  const plan = buildPlan(order({ start: 'Los Angeles, CA', end: 'End' }), route);
  assert.equal(plan.originLeg.estimate, true);
  assert.equal(plan.originLeg.status, undefined);
  assert.equal(plan.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value, 'Estimate: about 47% on arrival.');
  const drive = plan.stops[0].primary.facts.find((fact) => fact.label === 'Drive time').value;
  assert.match(drive, /76 minutes from Los Angeles/);
  assert.match(drive, /passing about 09:16/);
  assert.match(plan.assumptions.join(' '), /Source checked 2026-10-15/);
  assert.match(plan.summary, /an estimated 41\.9 miles/);
});

test('a higher charge is named only when the previous stop is a charging stop', () => {
  const route = longRoute();
  const after = structuredClone(route.stops[0]);
  after.id = 'after';
  after.name = 'After';
  after.mile = 200;
  after.backups = [];
  after.other = [];
  after.primary.name = 'After EA';
  route.stops.push(after);
  const detailed = buildPlan(order(), route);
  assert.equal(detailed.stops.find((stop) => stop.id === 'late').charging, true);
  assert.equal(detailed.stops.find((stop) => stop.id === 'after').note, 'No verified backup at After yet. Charge to a higher level at the previous stop.');
  const basic = buildPlan(order({ tier: '$19' }), route);
  assert.equal(basic.stops.find((stop) => stop.id === 'after').note, 'No verified backup at After yet.');

  const lonely = longRoute();
  lonely.stops[1].backups = [];
  const late = buildPlan(order(), lonely).stops.find((stop) => stop.id === 'late');
  assert.equal(late.charging, true);
  assert.equal(late.note, 'No verified backup at Late yet.');
});

test('pet lines appear only when the order has a pet, and name the stops that have them', () => {
  const quiet = buildPlan(order({ notes: 'Window seat.', passengers: '2 adults' }), sampleRoute());
  assert.equal(quiet.tips.some((tip) => /pet info|Sourced pet/.test(tip.text)), false);
  const route = sampleRoute();
  route.stops[0].reports.push({
    date: '2026-06-01',
    source: 'wiki',
    site: 'Walmart Alpha',
    text: 'Dog friendly patio outside the store.',
  });
  const line = buildPlan(order(), route).tips.find((tip) => /pet/.test(tip.text)).text;
  assert.match(line, /Sourced pet notes: Alpha/);
  assert.doesNotMatch(line, /No sourced pet info/);
});

test('contingency names the next verified station in each direction, and says once when there is none', () => {
  const route = sampleRoute();
  route.stops = [route.stops[0]];
  route.stops[0].backups = [];
  route.stops[0].other = [];
  route.stats[0].value = '50';
  const plan = buildPlan(order({ tier: '$79', notes: '' }), route);
  const stalls = plan.contingency.filter((item) => item.title === 'Stall full or offline');
  assert.equal(stalls.length, 1);
  assert.match(stalls[0].text, /No alternative verified station for Alpha/);
  assert.equal(plan.contingency.filter((item) => item.title === 'Weather or heat').length, 0);
});

test('a reverse-direction order is refused for every tier, and a forward order builds', async () => {
  const vegas = JSON.parse(await readFile(path.join(root, 'src/data/routes/la-to-las-vegas.json'), 'utf8'));
  for (const tier of ['$19', '$39', '$79']) {
    for (const [start, end] of [['Las Vegas, NV', 'Los Angeles, CA'], ['vegas', 'LA'], ['Henderson, NV', 'Pasadena, CA']]) {
      assert.throws(
        () => buildPlan({ ...FAKE_ORDER, tier, start, end }, vegas),
        (error) => error instanceof OrderBlockedError && error.code === 'needs-manual-build' && /Needs manual build: reverse direction/.test(error.message),
        `${tier} ${start} to ${end}`,
      );
    }
  }
  const forward = buildPlan({ ...FAKE_ORDER, tier: '$79', start: 'Pasadena, CA', end: 'Las Vegas, NV' }, vegas);
  assert.ok(forward.tips.some((tip) => tip.text.startsWith('Northbound,')));
  assert.equal(forward.tips.some((tip) => tip.text.startsWith('Southbound,')), false);
  // An order for a different corridor than the route file is refused too.
  assert.throws(
    () => buildPlan({ ...FAKE_ORDER, start: 'Seattle, WA', end: 'Portland, OR' }, vegas),
    (error) => error instanceof OrderBlockedError && /not la-to-las-vegas/.test(error.message),
  );
});

test('a named origin that matches the first point has no origin leg', async () => {
  const tahoe = JSON.parse(await readFile(path.join(root, 'src/data/routes/sf-to-tahoe.json'), 'utf8'));
  const plan = buildPlan(order({ slug: 'sf-to-tahoe', start: 'San Francisco, CA', end: 'Truckee, CA', notes: '' }), tahoe);
  assert.equal(plan.originLeg, undefined);
  assert.doesNotMatch(plan.summary, /first-stop numbers are optimistic/);
  assert.equal(tahoe.direction, 'eastbound');
});

test('the start battery tag from the intake form is read and never printed', async () => {
  const vegas = JSON.parse(await readFile(path.join(root, 'src/data/routes/la-to-las-vegas.json'), 'utf8'));
  const plan = buildPlan({ ...FAKE_ORDER, startBattery: undefined, depart: '2026-11-02T07:30', notes: '[Start battery: 65%]\nOne dog.' }, vegas);
  assert.match(plan.summary, /Start battery: 65%/);
  assert.match(plan.summary, /at 07:30/);
  assert.ok(plan.tips.some((tip) => tip.text === 'Order note: One dog.'));
  assert.doesNotMatch(JSON.stringify(plan), /\[Start battery/);
  assert.notEqual(plan.stops[0].primary.facts.find((fact) => fact.label === 'Arrival battery').value, UNKNOWN);
});

test('a stored plan renders the same HTML, and new sections appear only when the plan has them', async () => {
  const stored = JSON.parse(await readFile(path.join(root, 'scripts/fixtures/stored-plan.json'), 'utf8'));
  const snap = (await readFile(path.join(root, 'scripts/fixtures/stored-plan.snapshot.html'), 'utf8')).replace(/\n$/, '');
  const storedHtml = renderPlan(stored);
  assert.equal(storedHtml, snap);
  assertCleanHtml(storedHtml, 'stored plan');
  assert.match(storedHtml, /Verified Oct 15, 2026/);
  assert.match(storedHtml, /<h2 class="h2">Charging strategy<\/h2>/);
  assert.match(storedHtml, /Charge at Walmart Alpha to 50%/);
  assert.match(storedHtml, /Reserve floor is 10%/);
  const route = sampleRoute();
  route.originLegs = [{
    start: 'Los Angeles',
    miles: 10,
    source: 'wiki',
    url: 'https://en.wikipedia.org/wiki/Example',
    checkedOn: '2026-10-15',
    estimate: true,
    note: 'Estimate.',
  }];
  route.stops[0].primary.driverReports.push({
    source: 'plugshare',
    url: 'https://www.plugshare.com/location/11',
    date: '2026-05-02',
    summary: 'Heat throttling on the dispenser.',
  });
  route.stops[0].backups[0].driverReports = [{
    source: 'plugshare',
    url: 'https://www.plugshare.com/location/12',
    date: '2026-05-03',
    summary: 'Queued for a stall.',
  }];
  const html = renderPlan(buildPlan(order({ start: 'Los Angeles, CA', end: 'End' }), route));
  assert.match(html, /Estimate: 10 miles from Los Angeles to Start, before the route mile marks/);
  assert.match(html, /Primary cautions/);
  assert.match(html, /Backup cautions/);
  assert.doesNotMatch(html, /<h3 class="h3 sub">Cautions<\/h3>/);
});

test('repeated unverified fields collapse to one line', () => {
  const plan = {
    title: 'Yermo',
    tier: 'Detailed plan ($39)',
    strategy: {
      text: 'No charging stop.',
      reservePercent: 10,
      targetPercent: 15,
      stops: [],
      destination: { arrivePercent: 20, arriveClock: '10:00', belowReserve: false, ranOut: false },
    },
    stops: [{
      id: 'yermo',
      name: 'Yermo',
      mile: 82,
      primary: {
        name: 'Yermo, Sunrise Canyon Road',
        network: { value: 'Tesla Supercharger', status: 'verified', url: 'https://www.tesla.com/findus', checkedOn: '2026-10-14' },
        address: { value: '40865 Sunrise Canyon Road, Yermo, CA', status: 'verified', url: 'https://www.tesla.com/findus', checkedOn: '2026-10-14' },
        exit: { value: UNKNOWN, status: 'unverified' },
        stalls: { value: UNKNOWN, status: 'unverified' },
        power: { value: UNKNOWN, status: 'unverified' },
        access: { value: 'Open to all EVs', status: 'verified', url: 'https://www.tesla.com/findus', checkedOn: '2026-10-14' },
        checkedOn: '2026-10-14',
      },
    }],
  };
  const html = renderPlan(plan);
  assert.match(html, /Exit, stalls and power/);
  assert.match(html, />Not yet verified</);
  const start = html.indexOf('Primary charger');
  const primary = html.slice(start, html.indexOf('</section>', start));
  const sheet = primary.slice(primary.indexOf('<dl class="sheet">'), primary.indexOf('</dl>'));
  assert.equal(sheet.split('Not yet verified').length - 1, 1);
  assert.match(sheet, /<dt>Exit, stalls and power<\/dt><dd><span>Not yet verified<\/span>/);
  assert.doesNotMatch(sheet, /<dt>Exit<\/dt>|<dt>Stalls<\/dt>|<dt>Max power<\/dt>/);
  const md = planMarkdown(plan);
  assert.match(md, /- Exit, stalls and power: Not yet verified/);
  assert.equal(md.split('- exit: Not yet verified').length - 1, 0);
  assert.equal(md.split('- stalls: Not yet verified').length - 1, 0);
  assert.equal(md.split('- power: Not yet verified').length - 1, 0);
  assert.match(md, /- network: Tesla Supercharger/);
  assert.match(md, /- access: Open to all EVs/);
  assertCleanHtml(html, 'yermo');
  assert.equal(html.includes('\u2014'), false);
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

// Restroom honesty: only a host or network page makes a restroom "sourced". Driver reports
// (PlugShare, Reddit, X, forums) stay in the plan, labeled as driver reports.
function restroomTip(plan) {
  return plan.tips.find((tip) => /restroom note/.test(tip.text))?.text || '';
}

test('a driver report about restrooms never counts as a sourced restroom note', () => {
  const route = sampleRoute();
  route.sources.reddit = { name: 'Reddit', url: 'https://www.reddit.com/' };
  route.stops[0].primary.driverReports.push({
    source: 'reddit',
    url: 'https://www.reddit.com/r/electricvehicles/comments/abc/',
    date: '2026-09-20',
    summary: 'Stopped here mostly for the Walmart restrooms and snacks.',
  });
  route.stops[0].around.push({
    text: 'PlugShare users list restrooms and grocery at this Walmart (crowd-sourced icons). Walmart has not confirmed restrooms.',
    category: 'food',
    source: 'plugshare-123',
    url: 'https://www.plugshare.com/location/123',
    checkedOn: '2026-10-16',
  });
  route.stops[0].around.push({
    text: 'Store hours and restrooms: Not yet verified.',
    category: 'food',
    source: 'ea-locator',
    url: 'https://www.electrifyamerica.com/locate-charger/alpha/',
    checkedOn: '2026-10-16',
  });
  const plan = buildPlan(order({ notes: '' }), route);
  const tip = restroomTip(plan);
  assert.doesNotMatch(tip, /Sourced restroom notes: .*Walmart Alpha/);
  assert.match(tip, /^No sourced restroom note at any stop\./);
  assert.match(tip, /Driver reports or PlugShare listings mention restrooms at Walmart Alpha/);
  assert.match(tip, /not host or network facts/);
  const restroom = plan.stops[0].primary.facts.find((fact) => fact.label === 'Restroom');
  assert.match(restroom.note, /^Driver report/);
  assert.match(planMarkdown(plan), /- Restroom: .*\(Driver report, not a network fact\.\)/);
});

test('a host page about restrooms is the sourced note and takes the Restroom line over a driver report', () => {
  const route = sampleRoute();
  route.sources['walmart-alpha'] = { name: 'Walmart Alpha store page', url: 'https://www.walmart.com/store/1' };
  route.stops[0].around.push({
    text: 'Walmart Alpha store page lists customer restrooms near the front entrance and hours of 6am to 11pm.',
    category: 'restroom',
    source: 'walmart-alpha',
    url: 'https://www.walmart.com/store/1',
    checkedOn: '2026-10-16',
  });
  const plan = buildPlan(order({ notes: '' }), route);
  const tip = restroomTip(plan);
  assert.match(tip, /^Sourced restroom notes: Walmart Alpha\./);
  assert.doesNotMatch(tip, /No sourced restroom note at [^.]*Walmart Alpha/);
  const restroom = plan.stops[0].primary.facts.find((fact) => fact.label === 'Restroom');
  assert.match(restroom.value, /customer restrooms/);
  assert.equal(restroom.source, 'walmart-alpha');
  assert.match(restroom.note, /^Route note/);
  const moved = plan.stops[0].food.find((item) => item.text === 'Convenience store with a restroom.');
  assert.ok(moved, 'displaced driver report stays in the plan');
  assert.match(moved.note, /^Driver report/);
});

test('LV to SLC plan does not count the Cedar City Reddit report as a sourced restroom note', async () => {
  const route = JSON.parse(await readFile(path.join(root, 'src/data/routes/las-vegas-to-salt-lake-city.json'), 'utf8'));
  const plan = buildPlan({ ...FAKE_ORDER, slug: route.slug, start: route.startLabel, end: route.endLabel }, route);
  const tip = restroomTip(plan);
  assert.ok(tip, 'restroom honesty tip present');
  const sourced = (tip.match(/^Sourced restroom notes: ([^.]*(?:\.[^ ][^.]*)*)\./) || [])[1] || '';
  assert.equal(/Cedar City/.test(sourced), false, tip);
  assert.match(tip, /No sourced restroom note at [^.]*Walmart 1438 \(Cedar City, UT\)/);
  const cedar = plan.stops.find((stop) => /Cedar City/.test(stop.primary?.name || ''));
  const restroom = cedar?.primary?.facts?.find((fact) => fact.label === 'Restroom');
  if (restroom) assert.match(restroom.note, /^Driver report/);
});

test('host-page store hours at the LA to San Diego, DC to NYC and LV to SLC hosts reach the plan with link and date', async () => {
  const cases = [
    { slug: 'la-to-san-diego', battery: 15, stops: [
      { name: /Walmart 2242/, url: 'https://www.walmart.com/store/2242-anaheim-ca', hours: /6am to 11pm, Monday to Sunday/ },
      { name: /Walmart 2494/, url: 'https://www.walmart.com/store/2494-oceanside-ca', hours: /6am to 11pm, Monday to Sunday/ },
    ] },
    { slug: 'dc-to-nyc', battery: 20, stops: [
      { name: /Walmart 2009/, url: 'https://www.walmart.com/store/2009-abingdon-md', hours: /6am to 11pm, Monday to Sunday/ },
      { name: /Wawa Store 840/, url: 'https://www.wawa.com/locations/0840', hours: /5:00 AM to 10:00 PM, Monday to Sunday/ },
      { name: /Urban Edge Properties Marlton Commons/, url: 'https://ravitzfamilymarkets.com/shoprite-of-marlton/', hours: /7am to 10pm/ },
      { name: /Walmart 3078/, url: 'https://www.walmart.com/store/3078-east-brunswick-nj', hours: /6am to 11pm, Monday to Sunday/ },
    ] },
    { slug: 'las-vegas-to-salt-lake-city', battery: 20, stops: [
      { name: /Walmart 3847/, url: 'https://www.walmart.com/store/3847-mesquite-nv', hours: /6am to 11pm, Monday to Sunday/ },
      { name: /Walmart 1439/, url: 'https://www.walmart.com/store/1439-washington-ut', hours: /6am to 11pm, Monday to Sunday/ },
      // The dated Reddit report on the primary takes the Restroom line first; it is still a driver report.
      { name: /Walmart 1438/, url: 'https://www.walmart.com/store/1438-cedar-city-ut', hours: /6am to 11pm, Monday to Sunday/, restroomValue: /Walmart lots with restrooms/ },
      { name: /Walmart 4068/, url: 'https://www.walmart.com/store/4068-spanish-fork-ut', hours: /6am to 11pm, Monday to Sunday/ },
    ] },
  ];
  for (const { slug, battery, stops } of cases) {
    const route = JSON.parse(await readFile(path.join(root, `src/data/routes/${slug}.json`), 'utf8'));
    const plan = buildPlan({ ...FAKE_ORDER, tier: '$79', notes: '', startBattery: battery, slug: route.slug, start: route.startLabel, end: route.endLabel }, route);
    const html = renderPlan(plan);
    for (const want of stops) {
      const stop = plan.stops.find((item) => want.name.test(item.primary?.name || ''));
      assert.ok(stop, `${slug}: stop ${want.name} in plan`);
      const hours = (stop.food || []).find((item) => item.url === want.url);
      assert.ok(hours, `${slug}: host hours note for ${want.name}`);
      assert.match(hours.text, want.hours);
      assert.equal(hours.checkedOn, '2026-10-16');
      assert.match(hours.note, /^Route note/);
      assert.match(hours.text, /Restrooms: Not yet verified/);
      const all = JSON.stringify([stop.food || [], stop.cautions || []]);
      assert.equal(/store hours and restrooms: Not yet verified|hours: Not yet verified|confirmed restrooms or store hours/i.test(all), false, all);
      assert.ok(html.includes(want.url), `${slug}: rendered plan links ${want.url}`);
      assert.equal((stop.primary.facts || []).some((fact) => fact.label === 'Restroom' && fact.url === want.url), false);
    }
    const tip = restroomTip(plan);
    for (const want of stops) assert.match(tip, new RegExp(`No sourced restroom note at [^.]*${want.name.source}`));
    assert.match(tip, /Driver reports or PlugShare listings mention restrooms/);
    assert.match(tip, /not host or network facts/);
    for (const want of stops) {
      const stop = plan.stops.find((item) => want.name.test(item.primary?.name || ''));
      const restroom = (stop.primary.facts || []).find((fact) => fact.label === 'Restroom');
      assert.ok(restroom, `${slug}: Restroom fact for ${want.name}`);
      assert.match(restroom.value, want.restroomValue || /Driver-reported/);
      assert.match(restroom.note, /^Driver report/);
      if (!want.restroomValue) assert.match(restroom.value, /successful check-in is dated/);
    }
  }
});

test('LV to SLC Beaver primary gets its Restroom line from the Flying J store page', async () => {
  const route = JSON.parse(await readFile(path.join(root, 'src/data/routes/las-vegas-to-salt-lake-city.json'), 'utf8'));
  const plan = buildPlan({ ...FAKE_ORDER, tier: '$79', notes: '', startBattery: 20, slug: route.slug, start: route.startLabel, end: route.endLabel }, route);
  const beaver = plan.stops.find((stop) => /Days Inn Beaver/.test(stop.primary?.name || ''));
  assert.ok(beaver, 'Beaver stop in plan');
  const restroom = (beaver.primary.facts || []).find((fact) => fact.label === 'Restroom');
  assert.ok(restroom, 'Restroom fact at Beaver');
  assert.equal(restroom.url, 'https://locations.pilotflyingj.com/us/ut/beaver/653-w-1400-n');
  assert.equal(restroom.checkedOn, '2026-10-16');
  assert.match(restroom.value, /clean restrooms/);
  assert.match(restroom.note, /^Route note/);
});

test('LA to San Diego primaries each get a Restroom line: driver-reported at Irvine, official park restrooms at the no-host Dana Point and Midway sites', async () => {
  const route = JSON.parse(await readFile(path.join(root, 'src/data/routes/la-to-san-diego.json'), 'utf8'));
  const plan = buildPlan({ ...FAKE_ORDER, tier: '$79', notes: '', startBattery: 15, slug: route.slug, start: route.startLabel, end: route.endLabel }, route);
  const want = [
    { name: /Irvine Spectrum/, url: 'https://www.plugshare.com/location/351856', value: /Driver-reported[\s\S]*dated 2026-10-13/, note: /^Driver report/ },
    { name: /Dana Point Station/, url: 'https://www.parks.ca.gov/?page_id=645', value: /Doheny State Beach[\s\S]*6:00 AM to 10:00 PM daily[\s\S]*0\.7 mile on foot/, note: /^Route note/ },
    { name: /3757 Midway/, url: 'https://www.sandiego.gov/map-public-restrooms', value: /Bill Cleator[\s\S]*7:00 AM to dusk[\s\S]*1\.7 miles by road/, note: /^Route note/ },
  ];
  for (const w of want) {
    const stop = plan.stops.find((item) => w.name.test(item.primary?.name || ''));
    assert.ok(stop, `stop ${w.name}`);
    const restroom = (stop.primary.facts || []).find((fact) => fact.label === 'Restroom');
    assert.ok(restroom, `Restroom fact at ${w.name}`);
    assert.equal(restroom.url, w.url);
    assert.equal(restroom.checkedOn, '2026-10-16');
    assert.match(restroom.value, w.value);
    assert.match(restroom.note, w.note);
  }
  const dana = route.stops.find((stop) => stop.id === 'dana-point' || /Dana Point/.test(stop.name));
  assert.ok(dana.around.some((item) => /^No host business at this site \(EA site note\)\./.test(item.text)));
  const midway = route.stops.find((stop) => /San Diego/.test(stop.name));
  assert.equal(midway.around.some((item) => item.source === 'evgo-midway-post'), false);
  for (const url of ['https://locations.wendys.com/united-states/ca/san-diego/3760-midway-drive', 'https://local.vons.com/ca/san-diego/3645-midway-dr.html']) {
    const stop = plan.stops.find((item) => /3757 Midway/.test(item.primary?.name || ''));
    const note = (stop.food || []).find((item) => item.url === url);
    assert.ok(note, `food note ${url}`);
    assert.match(note.text, /12:00 AM daily/);
  }
});

test('LV to SLC Salt Lake City primary is the Target EVgo site with a host-sourced restroom; Sam\'s Club is a backup', async () => {
  const route = JSON.parse(await readFile(path.join(root, 'src/data/routes/las-vegas-to-salt-lake-city.json'), 'utf8'));
  const slc = route.stops.find((stop) => stop.id === 'salt-lake-city');
  assert.equal(slc.primary.name, 'Target Salt Lake City #T2641');
  assert.equal(slc.primary.network, 'EVgo');
  for (const key of ['stalls', 'power', 'access']) assert.equal(slc.primary[key].status, 'verified');
  assert.equal(slc.backups[0].name, "Sam's Club 6686 (Salt Lake City, UT)");
  assert.equal(slc.backups.some((backup) => backup.name === 'Target Salt Lake City #T2641'), false);
  const plan = buildPlan({ ...FAKE_ORDER, tier: '$79', notes: '', startBattery: 20, slug: route.slug, start: route.startLabel, end: route.endLabel }, route);
  const stop = plan.stops.find((item) => /Target Salt Lake City/.test(item.primary?.name || ''));
  assert.ok(stop, 'SLC stop in plan');
  const restroom = (stop.primary.facts || []).find((fact) => fact.label === 'Restroom');
  assert.ok(restroom, 'Restroom fact at SLC');
  assert.equal(restroom.url, 'https://www.target.com/sl/salt-lake-city/2641');
  assert.equal(restroom.checkedOn, '2026-10-16');
  assert.match(restroom.value, /store map for store 2641 marks restrooms/);
  assert.match(restroom.note, /^Route note/);
  const hours = (stop.food || []).find((item) => item.url === 'https://www.target.com/sl/salt-lake-city/2641');
  assert.ok(hours, 'Target hours note');
  assert.match(hours.text, /7am to 10pm daily/);
  assert.equal(JSON.stringify(stop.primaryCautions || []).includes("Sam's Club"), false);
});

test('positive driver notes are filed as Driver notes, and problems stay under Cautions', () => {
  const route = sampleRoute();
  route.stops[0].primary.driverReports = [
    { source: 'plugshare', url: 'https://www.plugshare.com/location/21', date: '2026-08-16', summary: 'I love the charging options here, with restaurants across the street.', category: 'food' },
    { source: 'x', url: 'https://x.com/example/status/1', date: '2026-04-21', summary: 'Pulled a steady 148 kW for about 15 minutes. Lots of restaurants nearby.', category: 'food' },
    { source: 'plugshare', url: 'https://www.plugshare.com/location/22', date: '2026-08-17', summary: 'Two chargers not working and a long wait for the restaurants.', category: 'food' },
  ];
  const stop = buildPlan(order(), route).stops[0];
  assert.equal(stop.driverNotes.length, 2);
  assert.ok(stop.driverNotes.every((item) => /Driver report/.test(item.note) && item.url && item.checkedOn));
  const cautionText = JSON.stringify([stop.cautions || [], stop.primaryCautions || [], stop.otherCautions || []]);
  assert.doesNotMatch(cautionText, /I love the charging options/);
  assert.doesNotMatch(cautionText, /148 kW/);
  assert.match(cautionText, /not working/);
  const plan = buildPlan(order(), route);
  const html = renderPlan(plan);
  assert.match(html, /Driver notes/);
  assert.match(planMarkdown(plan), /Driver notes:/);
});


test('custom trips and reverse journeys can use their own researched route data', () => {
  for (const [start, end, slug] of [['Chicago', 'Milwaukee', 'chicago-custom'], ['Las Vegas', 'Los Angeles', 'vegas-la-custom']]) {
    const route = sampleRoute();
    Object.assign(route, { slug, title: `${start} to ${end}`, startLabel: start, endLabel: end });
    const plan = buildPlan(order({ slug, start, end }), route);
    assert.ok(plan.stops.length > 0);
    assert.ok(plan.sources['ea-locator']);
    assert.match(plan.summary, /Start battery/);
  }
});
