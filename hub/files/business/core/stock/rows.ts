// Ledger rows: their shape, their order, and the checks a step must pass before it makes rows.

import type { Position } from './valuation.ts';
import type { Scenario, Step } from '../contract.ts';
import type { Layer } from './fifo.ts';

/** One stock ledger row (02 §4.1), plus the figures the valuation pass writes on it. */
export interface Row {
  seq: number;          // creation order; breaks ties at the same posting time (02 §4.3)
  step: string;         // step that made it (a reversal keeps the original step, like the original voucher, 02 §4.2)
  line: number;         // line index in that step (landed cost is shared per line, 02 §6.7)
  item: string;
  warehouse: string;
  at: string;           // 'YYYY-MM-DD HH:MM:SS', the sort key with seq
  kind: 'in' | 'out' | 'count';
  qty: number;          // + in, - out; a count asserts a balance and its qty is the change (counted - before), set by the valuation pass
  rate: number;         // in: line rate before landed cost; count: counted rate
  countQty: number;     // count rows: the counted qty
  sourceSeq: number;    // transfer target: seq of its source row (02 §4.1 dependant row); else -1
  cancelled: boolean;
  reversal: boolean;    // the mirror row written on cancel (02 §4.2 step 2)
  // Figures (02 §4.1), written by the valuation pass; frozen once the row is cancelled.
  qtyBefore: number;
  valueBefore: number;
  rateBefore: number;
  qtyAfter: number;
  valuationRate: number;
  stockValue: number;
  valueChange: number;
  incomingRate: number; // in rows: rate actually used (landed cost included, or what left the source)
  pieces: Layer[];      // out rows: what left, as [qty, rate] pieces
  pos?: Position;       // the item+warehouse position after this row (set by the valuation pass)
  negativeOk?: boolean; // from its step: recorded while negative stock was allowed (contract NegativeOk)
}

/** Ledger order: posting date+time, then creation (02 §4.3). */
export function byTime(a: Row, b: Row): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.seq - b.seq;
}

export function newRow(seq: number, step: string, line: number, item: string, warehouse: string, at: string,
  kind: Row['kind'], qty: number, rate: number): Row {
  return {
    seq, step, line, item, warehouse, at, kind, qty, rate, countQty: 0, sourceSeq: -1,
    cancelled: false, reversal: false,
    qtyBefore: 0, valueBefore: 0, rateBefore: 0, qtyAfter: 0, valuationRate: 0, stockValue: 0, valueChange: 0,
    incomingRate: 0, pieces: [],
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;

/** Plain checks on the step itself (no ledger needed). Returns an error message or null. */
export function checkStep(s: Scenario, step: Step): string | null {
  if (!DATE.test(step.date) || !TIME.test(step.time)) return 'Date must be YYYY-MM-DD and time HH:MM:SS';
  if (step.kind === 'cancel' || step.kind === 'landed_cost') return null;

  const items = new Set(s.items.map((i) => i.key));
  const stores = new Set(s.warehouses);
  if (step.kind === 'transfer') {
    if (!stores.has(step.from) || !stores.has(step.to)) return `Unknown warehouse ${step.from} or ${step.to}`;
    if (step.from === step.to) return 'Transfer needs two different warehouses';
  } else if (!stores.has(step.warehouse)) {
    return `Unknown warehouse ${step.warehouse}`;
  }
  if (!step.lines.length) return 'No lines';
  for (const line of step.lines) {
    if (!items.has(line.item)) return `Unknown item ${line.item}`;
    // A count may say 0 (nothing found); every other line moves a positive qty (contract: qty always positive).
    const minOk = step.kind === 'count' ? line.qty >= 0 : line.qty > 0;
    if (!Number.isFinite(line.qty) || !minOk) return `Bad quantity for ${line.item}`;
    // Receipts and counts need a rate (contract; 02 §5.4: opening stock and counts need a rate).
    const needsRate = step.kind === 'receipt' || step.kind === 'purchase_receipt' || step.kind === 'count';
    if (needsRate && (line.rate === undefined || !Number.isFinite(line.rate) || line.rate < 0)) {
      return `Rate needed for ${line.item}`;
    }
  }
  return null;
}
