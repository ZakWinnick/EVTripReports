import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CORRIDORS, corridorBySlug, matchOrder, parsePlace, plannableList } from './corridors.js';

const routes = JSON.parse(readFileSync(new URL('../data/routes.json', import.meta.url), 'utf8'));

test('corridors are exactly the live routes, so a hidden route is never offered', () => {
  const live = routes.filter((route) => route.status === 'live').map((route) => route.slug).sort();
  assert.deepEqual(CORRIDORS.map((item) => item.slug).sort(), live);
  assert.equal(corridorBySlug('chicago-to-milwaukee'), null);
  for (const corridor of CORRIDORS) {
    assert.equal(corridor.title, routes.find((route) => route.slug === corridor.slug).title);
    assert.equal(plannableList().some((item) => item.slug === corridor.slug), true);
  }
});

test('places parse with and without a state', () => {
  assert.deepEqual(parsePlace('Las Vegas, NV'), { city: 'las vegas', state: 'nv' });
  assert.deepEqual(parsePlace('Las Vegas NV'), { city: 'las vegas', state: 'nv' });
  assert.deepEqual(parsePlace('Portland, Oregon'), { city: 'portland', state: 'or' });
  assert.deepEqual(parsePlace('Washington, DC'), { city: 'washington', state: 'dc' });
  assert.deepEqual(parsePlace('New York'), { city: 'new york', state: '' });
  assert.deepEqual(parsePlace('LA'), { city: 'la', state: '' });
  assert.deepEqual(parsePlace(''), { city: '', state: '' });
});

test('every corridor maps forward, and its reverse is flagged reverse', () => {
  for (const corridor of CORRIDORS) {
    const forward = matchOrder({ start: corridor.from.label, end: corridor.to.label });
    assert.equal(forward.status, 'forward', corridor.slug);
    assert.equal(forward.slug, corridor.slug);
    const back = matchOrder({ start: corridor.to.label, end: corridor.from.label });
    assert.equal(back.status, 'reverse', corridor.slug);
    assert.equal(back.slug, corridor.slug);
  }
});

test('near places, nicknames, and look-alike cities', () => {
  assert.equal(matchOrder({ start: 'Pasadena, CA', end: 'Las Vegas, NV' }).startMatch, 'near');
  assert.equal(matchOrder({ start: 'vegas', end: 'Salt Lake City, UT' }).slug, 'las-vegas-to-salt-lake-city');
  assert.equal(matchOrder({ start: 'Washington DC', end: 'NYC' }).slug, 'dc-to-nyc');
  assert.equal(matchOrder({ start: 'Washington, WA', end: 'NYC' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Portland, ME', end: 'Seattle, WA' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Chicago, IL', end: 'Milwaukee, WI' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'South Lake Tahoe, CA', end: 'San Francisco' }).status, 'reverse');
  assert.equal(matchOrder({ start: 'Los Angeles', end: 'Los Angeles' }).status, 'unmatched');
  assert.equal(matchOrder({ start: '', end: '' }).status, 'unmatched');
  assert.equal(matchOrder().status, 'unmatched');
});

test('real metro spellings are not refused (a false reject loses a sale)', () => {
  const ok = (start, end, slug) => {
    const hit = matchOrder({ start, end });
    assert.equal(hit.status, 'forward', `${start} to ${end}`);
    assert.equal(hit.slug, slug, `${start} to ${end}`);
  };
  ok('Los Angeles, CA', 'Oakland, CA', 'la-to-sf');
  ok('Los Angeles', 'San Jose, CA', 'la-to-sf');
  ok('LA', 'San Francisco Bay Area', 'la-to-sf');
  ok('Pasadena, CA', 'Berkeley', 'la-to-sf');
  ok('Oakland, CA', 'South Lake Tahoe, CA', 'sf-to-tahoe');
  ok('San Jose', 'Incline Village, NV', 'sf-to-tahoe');
  ok('San Francisco', 'Tahoe City', 'sf-to-tahoe');
  ok('Los Angeles', 'Chandler, AZ', 'la-to-phoenix');
  ok('Los Angeles', 'La Jolla', 'la-to-san-diego');
  ok('Irvine, CA', 'San Diego', 'la-to-san-diego');
  ok('Los Angeles (LAX)', 'Las Vegas, NV 89109', 'la-to-las-vegas');
  ok('123 Main St, Pasadena, CA 91101', 'Henderson, NV', 'la-to-las-vegas');
  ok('Bellevue, WA', 'Portland, OR', 'seattle-to-portland');
  ok('Tacoma', 'Vancouver, WA', 'seattle-to-portland');
  ok('Arlington, VA', 'New York, NY', 'dc-to-nyc');
  ok('Bethesda, MD', 'Jersey City, NJ', 'dc-to-nyc');
  ok('New York City', 'Cambridge, MA', 'nyc-to-boston');
  ok('Fort Worth, TX', 'Round Rock, TX', 'dallas-to-austin');
  ok('Dallas-Fort Worth', 'Austin', 'dallas-to-austin');
  ok('Henderson, NV', 'Provo, UT', 'las-vegas-to-salt-lake-city');
});

test('look-alike places in the wrong state or country still do not match', () => {
  assert.equal(matchOrder({ start: 'Seattle', end: 'Vancouver, BC' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Seattle', end: 'Vancouver' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Seattle', end: 'Portland, WA' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Washington, VA', end: 'NYC' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Las Vegas, NM', end: 'Los Angeles' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Chicago, IL', end: 'Milwaukee, WI' }).status, 'unmatched');
});
