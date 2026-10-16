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
  assert.equal(matchOrder({ start: 'South Lake Tahoe, CA', end: 'San Francisco' }).status, 'unmatched');
  assert.equal(matchOrder({ start: 'Los Angeles', end: 'Los Angeles' }).status, 'unmatched');
  assert.equal(matchOrder({ start: '', end: '' }).status, 'unmatched');
  assert.equal(matchOrder().status, 'unmatched');
});
