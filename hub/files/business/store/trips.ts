// Delivery trips (phase 4d, blueprint 03 §3.3, ERPNext Delivery Trip): a driver and a vehicle take delivery notes out,
// one stop each; stops are marked visited as the van goes. Scheduled → In Transit (some visited) → Completed (all).
// A trip books nothing, so (like till shifts) the engine never sees it; the delivery notes moved the goods already.
import type { Step } from '../core/contract.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';
import type { Data } from './docs.ts';
import { record } from './money.ts';
import { invoiceTotals } from '../core/money/taxes.ts';

const bad = (message: string): never => fail(422, message);
export const TRIP_KINDS = new Set<string>(['delivery_trip', 'trip_visit']);
const parse = (s: string): Data => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
type Trip = Extract<Step, { kind: 'delivery_trip' }>;

function live(db: DB, kinds: string[]): Data[] {
  const undone = new Set((db.prepare("SELECT json_extract(data, '$.target') AS t FROM steps WHERE kind = 'cancel'").all() as { t: string }[]).map((r) => r.t));
  return (db.prepare(`SELECT id, data FROM steps WHERE kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY seq`).all(...kinds) as { id: string; data: string }[])
    .filter((r) => !undone.has(r.id)).map((r) => parse(r.data));
}

/** The live trip a delivery note is on, if any. */
export function tripOf(db: DB, dn: string): Trip | null {
  return (live(db, ['delivery_trip']).find((t) => ((t.stops as Data[]) ?? []).some((s) => s.delivery_note === dn)) as Trip | undefined) ?? null;
}

/** Visited stops of a trip: the latest live mark per stop wins. */
export function visitsOf(db: DB, trip: string): boolean[] {
  const t = live(db, ['delivery_trip']).find((x) => x.id === trip) as Trip | undefined;
  const out = (t?.stops ?? []).map(() => false);
  for (const v of live(db, ['trip_visit'])) if (v.trip === trip && Number.isInteger(v.stop) && (v.stop as number) < out.length) out[v.stop as number] = v.visited === true;
  return out;
}

export function tripStatus(db: DB, trip: string): string {
  const v = visitsOf(db, trip);
  return v.length && v.every(Boolean) ? 'Completed' : v.some(Boolean) ? 'In Transit' : 'Scheduled';
}

export function cleanTripStep(db: DB, input: Data, kind: string, id: string, date: string, time: string): Step {
  if (kind === 'trip_visit') {
    const trip = String(input.trip ?? '');
    const t = live(db, ['delivery_trip']).find((x) => x.id === trip) as Trip | undefined;
    if (!t) bad('That trip does not exist (or was undone)');
    const stop = Number(input.stop);
    if (!Number.isInteger(stop) || stop < 0 || stop >= t!.stops.length) bad('No such stop on the trip');
    return { id, kind, date, time, trip, stop, visited: input.visited !== false };
  }
  const d = record(db, 'driver', input.driver, 'driver');
  if (d.data.active === false) bad(`${d.title} is switched off`);
  const v = record(db, 'vehicle', input.vehicle, 'vehicle');
  if (v.data.active === false) bad(`${v.title} is switched off`);
  // papers in order on the day of the trip
  if (typeof d.data.licence_expiry === 'string' && d.data.licence_expiry < date) bad(`${d.title}'s driving licence expired on ${d.data.licence_expiry}`);
  if (typeof v.data.insured_until === 'string' && v.data.insured_until < date) bad(`${v.title}'s insurance ended on ${v.data.insured_until}`);
  if (!Array.isArray(input.stops) || !input.stops.length) bad('Add at least one delivery to the trip');
  const seen = new Set<string>();
  const stops = (input.stops as Data[]).map((s, i) => {
    const dn = String(s?.delivery_note ?? '');
    const row = db.prepare("SELECT data FROM steps WHERE id = ? AND kind = 'delivery_note'").get(dn) as { data: string } | undefined;
    if (!row) bad(`Stop ${i + 1}: ${dn || 'that'} is not a delivery note`);
    const data = parse(row!.data);
    if (data.returnOf) bad(`Stop ${i + 1}: ${dn} is a return`);
    if (db.prepare("SELECT 1 FROM steps WHERE kind = 'cancel' AND json_extract(data, '$.target') = ?").get(dn)) bad(`Stop ${i + 1}: ${dn} was undone`);
    if (seen.has(dn)) bad(`${dn} is on the trip twice`);
    seen.add(dn);
    const other = tripOf(db, dn);
    if (other) bad(`${dn} is already on trip ${other.id}`);
    const note = typeof s.note === 'string' ? s.note.trim().slice(0, 200) : '';
    // what the driver needs at the stop, as it was when the trip was made: address, who to call, the delivery's total
    const c = record(db, 'customer', data.customer, 'customer').data;
    const person = ((c.contacts as Data[] | undefined) ?? [])[0];
    const contact = [person?.name, person?.phone ?? c.phone].filter((x) => typeof x === 'string' && x).join(' · ');
    const total = invoiceTotals((data.lines as Parameters<typeof invoiceTotals>[0]) ?? [], data.tax as Parameters<typeof invoiceTotals>[1], true, data.discountAmount as number | undefined).roundedTotal;
    return { delivery_note: dn, customer: String(data.customer), ...(typeof c.address === 'string' && c.address ? { address: c.address } : {}),
      ...(contact ? { contact } : {}), total, ...(note ? { note } : {}) };
  });
  const km = Number(input.distance);
  return { id, kind: 'delivery_trip', date, time, driver: d.id, vehicle: v.id, stops, ...(km > 0 ? { distance: km } : {}) };
}

/** Undo: a trip once nothing is marked visited; a delivery note on a live trip only after the trip is undone. */
export function undoTripCheck(db: DB, kind: string, target: string): void {
  if (kind === 'delivery_trip' && visitsOf(db, target).some(Boolean)) bad('Stops of this trip are marked visited; unmark them first');
  if (kind === 'delivery_note') { const t = tripOf(db, target); if (t) bad(`${target} is on trip ${t.id}; undo the trip first`); }
}
