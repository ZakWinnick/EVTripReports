import assert from 'node:assert/strict';
import test from 'node:test';
import { orderFromRequest, packNotes, parseNotes, portKnown, reviewFlags } from './order-flags.js';

const row = (over = {}) => ({
  id: 1, tier: 'Detailed plan', car: '2024 Ioniq 5', port: 'CCS port, no adapter', start_place: 'Los Angeles, CA', end_place: 'Las Vegas, NV',
  depart: '2026-11-02T08:00', return_date: '', memberships: 'EVgo plan; None', notes: '[Start battery: 80%]\nOne dog.', passengers: '2 adults', ...over,
});

test('the start battery tag round-trips and is never part of the notes', () => {
  assert.equal(packNotes('Hi', 80), '[Start battery: 80%]\nHi');
  assert.equal(packNotes('', 80), '[Start battery: 80%]');
  assert.equal(packNotes('Hi', null), 'Hi');
  assert.deepEqual(parseNotes('[Start battery: 80%]\nHi'), { notes: 'Hi', startBattery: 80 });
  assert.deepEqual(parseNotes('[Start battery: 80%]'), { notes: '', startBattery: 80 });
  assert.deepEqual(parseNotes('Hi'), { notes: 'Hi', startBattery: null });
  assert.deepEqual(parseNotes(null), { notes: '', startBattery: null });
  assert.equal(parseNotes('[Start battery: 180%]').startBattery, null);
});

test('the five form port choices', () => {
  for (const port of ['CCS port, no adapter', 'CCS port, with a NACS adapter', 'NACS port (Tesla-style)', 'NACS port, with a CCS adapter']) assert.equal(portKnown(port), true, port);
  for (const port of ['Not sure', 'not sure', '', null, 'unknown']) assert.equal(portKnown(port), false, String(port));
});

test('a clean forward order has no blocking flag', () => {
  const out = reviewFlags(row());
  assert.equal(out.blocked, false);
  assert.deepEqual(out.flags, []);
  assert.equal(out.startBattery, 80);
  assert.equal(out.corridor.slug, 'la-to-las-vegas');
});

test('Not sure port is flagged as a customer question', () => {
  const out = reviewFlags(row({ port: 'Not sure' }));
  assert.equal(out.blocked, true);
  assert.equal(out.flags[0].code, 'port-unknown');
  assert.match(out.blockingLabel, /^Needs customer question/);
});

test('reverse and unmatched orders block, with the reverse label first for a known corridor', () => {
  const reverse = reviewFlags(row({ start_place: 'Las Vegas, NV', end_place: 'Los Angeles, CA' }));
  assert.equal(reverse.blocked, true);
  assert.match(reverse.blockingLabel, /^Needs manual build: reverse direction/);
  const unmatched = reviewFlags(row({ start_place: 'Boise, ID', end_place: 'Reno, NV' }));
  assert.equal(unmatched.flags[0].code, 'corridor-unmatched');
  const both = reviewFlags(row({ port: 'Not sure', start_place: 'Las Vegas', end_place: 'LA' }));
  assert.deepEqual(both.flags.map((flag) => flag.code), ['port-unknown', 'reverse-direction']);
});

test('notes flags: no battery on a paid-detail tier, return date, near end point', () => {
  const none = reviewFlags(row({ notes: '' }));
  assert.deepEqual(none.flags.map((flag) => flag.code), ['no-start-battery']);
  assert.equal(none.blocked, false);
  assert.equal(reviewFlags(row({ tier: 'Route plan', notes: '' })).flags.length, 0);
  assert.ok(reviewFlags(row({ return_date: '2026-11-05' })).flags.some((flag) => flag.code === 'return-leg'));
  assert.ok(reviewFlags(row({ start_place: 'Pasadena, CA' })).flags.some((flag) => flag.code === 'near-endpoint'));
});

test('a request row becomes the order JSON the builder reads', () => {
  const order = orderFromRequest(row({ return_date: '2026-11-05' }), 'la-to-las-vegas');
  assert.equal(order.slug, 'la-to-las-vegas');
  assert.equal(order.vehicle, '2024 Ioniq 5');
  assert.equal(order.adapter, 'CCS port, no adapter');
  assert.deepEqual(order.memberships, ['EVgo plan', 'None']);
  assert.equal(order.startBattery, 80);
  assert.equal(order.notes, 'One dog.');
  assert.equal(order.depart, '2026-11-02T08:00');
  assert.equal(order.returnDate, '2026-11-05');
});
