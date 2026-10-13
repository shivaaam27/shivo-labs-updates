// Valuation of one ledger row, given the position of its item+warehouse just before it (02 §5).
// Pure functions: position in, new position + row figures out.
//
// Rounding rule (learned from the referee's golden files S01-S10, 13 Oct 2026):
//   The stock value of a row is rounded to whole cents (money, 2 dp). The valuation rate is then
//   "value per unit of what is in stock", taken from the most exact value each method keeps:
//   - Moving Average keeps no layers, so its rounded value is the truth: rate = rounded value / qty,
//     after every row. Example S06: 6 left at 1533.333 -> value 9199.998 rounds to 9200.00, so the rate
//     becomes 9200 / 6 = 1533.333333 (it does not stay 1533.333).
//     (On inward rows this changes nothing in practice: the value in is qty x rate in whole cents.)
//   - FIFO keeps exact layers, so its rate = sum(layer qty x layer rate) / qty, from the unrounded
//     layers; only the stock value is rounded. Example S06: [15 @ 533.3335] -> value 8000.0025 rounds to
//     8000.00, but the rate stays 533.3335 (not 8000 / 15 = 533.333333).
//   - An incoming rate is (line amount + landed cost share) / qty, not rounded to cents (S06:
//     (12000 + 3333.33) / 10 = 1533.333 and (8000 + 2666.67) / 20 = 533.3335).
//   Rates are kept to 9 decimals (money.ts). ERPNext showed 1533.333333 (6 decimals) for 9200 / 6; the
//   gap is far below RATE_TOLERANCE, and no golden file shows which precision ERPNext uses inside.

import type { ValuationMethod } from '../contract.ts';
import { roundMoney, roundQty, roundRate } from '../money.ts';
import { addToQueue, copyQueue, queueValue, takeFromQueue } from './fifo.ts';
import type { Layer } from './fifo.ts';

/** Running position of one item in one warehouse. */
export interface Position {
  qty: number;
  rate: number;     // valuation rate
  value: number;    // stock value (money)
  queue: Layer[];   // FIFO layers (empty for Moving Average)
  hasRate: boolean; // some earlier row set a rate (02 §5.4: last known rate is the first fallback)
}

export interface Valued {
  pos: Position;      // position after the row
  valueChange: number;
  pieces: Layer[];    // for outward rows: what left, as [qty, rate] (the last rate is the fallback at qty 0)
}

export function emptyPosition(): Position {
  return { qty: 0, rate: 0, value: 0, queue: [], hasRate: false };
}

/**
 * Inward row: qty at `rate`. A transfer target also comes in this way, as ONE layer at the average
 * cost of what left the source (value out / qty), not the source's layers (referee S03).
 */
export function valueIn(method: ValuationMethod, before: Position, qty: number, rate: number): Valued {
  const newQty = roundQty(before.qty + qty);
  if (method === 'FIFO') {
    const queue = copyQueue(before.queue);
    addToQueue(queue, qty, rate);
    return finishFifo(before, newQty, queue, []);
  }
  // Moving Average, 02 §5.1: if nothing (or less than nothing) was in stock, the new rate is the incoming rate.
  const newRate = before.qty <= 0 ? rate : (before.qty * before.rate + qty * rate) / (before.qty + qty);
  return finishAverage(before, newQty, roundRate(newRate), []);
}

/** Outward row at valuation (02 §5.1 outward; §5.2 remove). */
export function valueOut(method: ValuationMethod, before: Position, qty: number): Valued {
  const newQty = roundQty(before.qty - qty);
  if (method === 'FIFO') {
    const queue = copyQueue(before.queue);
    const pieces = takeFromQueue(queue, qty, before.rate);
    return finishFifo(before, newQty, queue, pieces);
  }
  return finishAverage(before, newQty, before.rate, [[qty, before.rate]]);
}

/** Stock count: sets qty and rate; the FIFO queue becomes one layer (02 §6.3). */
export function valueCount(method: ValuationMethod, before: Position, qty: number, rate: number): Valued {
  const value = roundMoney(qty * rate);
  const queue: Layer[] = method === 'FIFO' && qty !== 0 ? [[qty, rate]] : [];
  const pos: Position = { qty, rate, value, queue, hasRate: true };
  return { pos, valueChange: roundMoney(value - before.value), pieces: [] };
}

function finishAverage(before: Position, newQty: number, newRate: number, pieces: Layer[]): Valued {
  // New value = new qty x new rate, in cents; forced to 0 when qty is 0 (02 §5.1).
  const value = newQty === 0 ? 0 : roundMoney(newQty * newRate);
  // The rate follows the rounded value (rule at the top; S06). With nothing left, keep the last rate.
  const rate = newQty === 0 ? newRate : roundRate(value / newQty);
  const pos: Position = { qty: newQty, rate, value, queue: [], hasRate: true };
  return { pos, valueChange: roundMoney(value - before.value), pieces };
}

function finishFifo(before: Position, newQty: number, queue: Layer[], pieces: Layer[]): Valued {
  const exact = queueValue(queue);
  const value = newQty === 0 ? 0 : roundMoney(exact);
  // Rate = value / qty (02 §5.2), from the unrounded layers (rule at the top; S06).
  // With nothing left, keep the last rate as the fallback for later rows (02 §5.4).
  let rate = newQty === 0 ? before.rate : roundRate(exact / newQty);
  if (newQty === 0 && pieces.length) rate = pieces[pieces.length - 1][1];
  const pos: Position = { qty: newQty, rate, value, queue, hasRate: true };
  return { pos, valueChange: roundMoney(value - before.value), pieces };
}
