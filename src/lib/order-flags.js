// What the admin queue and the builder check on a paid order before a plan is built.
// Pure: no clock, no network, no database. Nothing here emails a customer.
import { matchOrder } from './corridors.js';

const BATTERY_TAG = /^\[Start battery: (\d{1,3})%\]\s*/;

// The form's start battery is stored as the first line of the notes column, so the table
// does not change. The builder gets it back out through parseNotes and never prints the tag.
export function packNotes(notes, startBattery) {
  const text = String(notes ?? '').trim();
  if (startBattery == null) return text;
  const tag = `[Start battery: ${startBattery}%]`;
  return text ? `${tag}\n${text}` : tag;
}

export function parseNotes(raw) {
  const text = String(raw ?? '');
  const match = text.match(BATTERY_TAG);
  if (!match) return { notes: text, startBattery: null };
  const value = Number(match[1]);
  return { notes: text.slice(match[0].length), startBattery: value >= 0 && value <= 100 ? value : null };
}

// The five form choices are "CCS port, no adapter", "CCS port, with a NACS adapter",
// "NACS port (Tesla-style)", "NACS port, with a CCS adapter", and "Not sure".
export function portKnown(port) {
  const text = String(port ?? '').trim().toLowerCase();
  if (!text || text === 'not sure' || text === 'unsure' || text === 'unknown') return false;
  return /\b(ccs|nacs|tesla)\b|tesla-style/.test(text);
}

const BLOCKING_ORDER = ['port-unknown', 'reverse-direction', 'corridor-unmatched'];

// Flags for one plan_requests row (columns start_place and end_place) or an order object (start, end).
// A blocking flag means a plan must not be built from this order until a person sorts it out.
export function reviewFlags(row) {
  const flags = [];
  const start = row?.start_place ?? row?.start ?? '';
  const end = row?.end_place ?? row?.end ?? '';
  const tier = String(row?.tier ?? '');
  const { startBattery } = parseNotes(row?.notes);

  if (!portKnown(row?.port ?? row?.adapter)) {
    flags.push({ code: 'port-unknown', blocking: true, label: 'Needs customer question: charge port or adapter' });
  }
  const corridor = matchOrder({ start, end });
  if (corridor.status === 'reverse') {
    flags.push({ code: 'reverse-direction', blocking: true, label: `Needs manual build: reverse direction (source route data for the reverse of ${corridor.title})` });
  } else if (corridor.status === 'unmatched') {
    flags.push({ code: 'corridor-unmatched', blocking: true, label: 'Needs route research: gather and verify source data for this custom trip' });
  } else if (corridor.startMatch === 'near' || corridor.endMatch === 'near') {
    flags.push({ code: 'near-endpoint', blocking: false, label: `Start or end is near the ${corridor.title} end point, not at it` });
  }
  if (String(row?.return_date ?? row?.returnDate ?? '').trim()) {
    flags.push({ code: 'return-leg', blocking: false, label: 'Return date given: the way back is the reverse direction and is built by hand' });
  }
  if (/\$?(39|79)|detailed|multi/i.test(tier) && startBattery == null && row?.startBattery == null) {
    flags.push({ code: 'no-start-battery', blocking: false, label: 'No start battery given: the charging strategy will read Not yet verified' });
  }
  flags.sort((a, b) => {
    const ia = BLOCKING_ORDER.indexOf(a.code);
    const ib = BLOCKING_ORDER.indexOf(b.code);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return {
    flags,
    blocked: flags.some((flag) => flag.blocking),
    blockingLabel: flags.find((flag) => flag.blocking)?.label || '',
    corridor: corridor.status === 'unmatched'
      ? { status: 'unmatched' }
      : { status: corridor.status, slug: corridor.slug, title: corridor.title },
    startBattery,
  };
}

// plan_requests row -> the order JSON that scripts/build-plan.mjs reads.
export function orderFromRequest(row, slug) {
  const { notes, startBattery } = parseNotes(row?.notes);
  const memberships = String(row?.memberships ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const order = {
    slug: slug || '',
    vehicle: String(row?.car ?? ''),
    adapter: String(row?.port ?? ''),
    memberships,
    depart: String(row?.depart ?? ''),
    tier: String(row?.tier ?? ''),
    notes: notes.trim(),
    start: String(row?.start_place ?? row?.start ?? ''),
    end: String(row?.end_place ?? row?.end ?? ''),
    passengers: String(row?.passengers ?? ''),
  };
  if (startBattery != null) order.startBattery = startBattery;
  const back = String(row?.return_date ?? '').trim();
  if (back) order.returnDate = back;
  return order;
}
