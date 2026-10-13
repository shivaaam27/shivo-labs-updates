// Landed cost on an earlier purchase receipt (02 §6.7): the receipt rows and every later row are
// valued again; the extra cost is credited to expenses included in valuation (R2, R3, R4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Step } from '../contract.ts';
import { figures, gl, near, on, row, run } from './testkit.ts';

const ITEMS = { items: { Sugar: 'FIFO' as const, Rice: 'FIFO' as const, Oil: 'FIFO' as const } };

const opening: Step[] = [
  { id: 'O1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'Oil', qty: 60, rate: 5800 }, { item: 'Sugar', qty: 200, rate: 2800 }] },
  { id: 'PR1', kind: 'purchase_receipt', ...on(2), warehouse: 'Stores', lines: [{ item: 'Rice', qty: 100, rate: 13200 }, { item: 'Oil', qty: 120, rate: 5900 }] },
];
const lcv: Step = { id: 'LCV1', kind: 'landed_cost', ...on(3), receipt: 'PR1', amount: 50000, distribute: 'amount' };
const dn: Step = { id: 'DN1', kind: 'delivery', ...on(4), warehouse: 'Stores', lines: [{ item: 'Sugar', qty: 20, rate: 3500 }, { item: 'Rice', qty: 10, rate: 15000 }, { item: 'Oil', qty: 15, rate: 7000 }] };

test('purchase receipt before landed cost: Oil [60@5,800] + 120 @ 5,900 (R2)', () => {
  const r = run(opening, ITEMS);
  figures(row(r, 'PR1', 'Oil'), 180, 5866.67, 1056000, 708000);
  assert.deepEqual(gl(r, 'PR1'), { stock: 2028000, stock_received_not_billed: -2028000 });
});

test('landed cost 50,000 by amount: shares, new rates and the receipt ledger (R3)', () => {
  const r = run([...opening, lcv], ITEMS);
  assert.deepEqual(r.errors, []);
  // Rice 1,320,000 / 2,028,000 x 50,000 = 32,544.38; Oil gets the rest, 17,455.62.
  near(row(r, 'PR1', 'Rice').valueChange, 1352544.38, 0.001, 'Rice');   // 100 x 13,525.4438
  near(row(r, 'PR1', 'Oil').valueChange, 725455.62, 0.001, 'Oil');      // 120 x 6,045.4635
  assert.deepEqual(gl(r, 'PR1'), { stock: 2078000, stock_received_not_billed: -2028000, expenses_in_valuation: -50000 });
  assert.deepEqual(gl(r, 'LCV1'), {});
});

test('delivery after the landed cost: Sugar 20, Rice 10, Oil 15 (R4)', () => {
  const r = run([...opening, lcv, dn], ITEMS);
  near(row(r, 'DN1', 'Sugar').valueChange, -56000, 0.001);
  near(row(r, 'DN1', 'Rice').valueChange, -135254.44, 0.001);
  const oil = row(r, 'DN1', 'Oil');
  figures(oil, 165, 5978.52, 986455.62, -87000); // took 15 x 5,800 from the oldest layer
  assert.deepEqual(gl(r, 'DN1'), { stock: -278254.44, cost_of_goods_sold: 278254.44 });
});

test('landed cost dated after a sale raises that sale\'s cost (moving average, 02 §6.7 step 4)', () => {
  const r = run([
    { id: 'PR1', kind: 'purchase_receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 1000 }] },
    { id: 'DN1', kind: 'delivery', ...on(2), warehouse: 'Stores', lines: [{ item: 'A', qty: 5, rate: 2000 }] },
    { id: 'LCV1', kind: 'landed_cost', ...on(3), receipt: 'PR1', amount: 1000, distribute: 'qty' },
  ]);
  figures(row(r, 'PR1'), 10, 1100, 11000, 11000);
  figures(row(r, 'DN1'), 5, 1100, 5500, -5500);
  assert.deepEqual(gl(r, 'DN1'), { stock: -5500, cost_of_goods_sold: 5500 });
});

test('landed cost by qty over two lines, then cancelled; receipt cannot be cancelled while it stands', () => {
  const r = run([
    { id: 'PR1', kind: 'purchase_receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }, { item: 'B', qty: 30, rate: 100 }] },
    { id: 'LCV1', kind: 'landed_cost', ...on(2), receipt: 'PR1', amount: 1000, distribute: 'qty' },
    { id: 'X1', kind: 'cancel', ...on(3), target: 'PR1' },
  ], { items: { A: 'Moving Average', B: 'FIFO' } });
  figures(row(r, 'PR1', 'A'), 10, 125, 1250, 1250);   // 250 of 1,000
  figures(row(r, 'PR1', 'B'), 30, 125, 3750, 3750);   // 750 of 1,000
  assert.deepEqual(r.errors.map((e) => e.step), ['X1']);

  const r2 = run([
    { id: 'PR1', kind: 'purchase_receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'LCV1', kind: 'landed_cost', ...on(2), receipt: 'PR1', amount: 1000, distribute: 'qty' },
    { id: 'X1', kind: 'cancel', ...on(3), target: 'LCV1' },
  ]);
  assert.deepEqual(r2.errors, []);
  figures(row(r2, 'PR1'), 10, 100, 1000, 1000);
  assert.deepEqual(gl(r2, 'PR1'), { stock: 1000, stock_received_not_billed: -1000 });
});

test('landed cost on something that is not a purchase receipt is refused', () => {
  const r = run([
    { id: 'R1', kind: 'receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 100 }] },
    { id: 'LCV1', kind: 'landed_cost', ...on(2), receipt: 'R1', amount: 100, distribute: 'qty' },
  ]);
  assert.deepEqual(r.errors.map((e) => e.step), ['LCV1']);
});

test('rounding: moving average rate follows the rounded value, fifo rate follows the exact layers (referee S06)', () => {
  const r = run([
    { id: 'P1', kind: 'purchase_receipt', ...on(1), warehouse: 'Stores', lines: [{ item: 'A', qty: 10, rate: 1200 }, { item: 'B', qty: 20, rate: 400 }] },
    { id: 'LC1', kind: 'landed_cost', ...on(2), receipt: 'P1', amount: 5000, distribute: 'amount' },
    { id: 'D1', kind: 'delivery', ...on(3), warehouse: 'Stores', lines: [{ item: 'A', qty: 4, rate: 2000 }, { item: 'B', qty: 5, rate: 800 }] },
    { id: 'LC2', kind: 'landed_cost', ...on(4), receipt: 'P1', amount: 1000, distribute: 'qty' },
  ], { items: { A: 'Moving Average', B: 'FIFO' } });
  // Incoming rate = (line amount + landed share) / qty: (12,000 + 3,333.33) / 10 and (8,000 + 2,666.67) / 20.
  near(row(r, 'P1', 'A').valuationRate, 1533.333, 1e-9, 'A in');
  near(row(r, 'P1', 'B').valuationRate, 533.3335, 1e-9, 'B in');
  // Moving average: 6 x 1,533.333 = 9,199.998 -> 9,200.00, and the rate becomes 9,200 / 6.
  const a = row(r, 'D1', 'A');
  near(a.stockValue, 9200, 1e-9, 'A value');
  near(a.valueChange, -6133.33, 1e-9, 'A change');
  near(a.valuationRate, 9200 / 6, 1e-6, 'A rate');
  // FIFO: [15 @ 533.3335] = 8,000.0025 -> value 8,000.00, but the rate stays 533.3335 (not 8,000 / 15).
  const b = row(r, 'D1', 'B');
  near(b.stockValue, 8000, 1e-9, 'B value');
  near(b.valueChange, -2666.67, 1e-9, 'B change');
  near(b.valuationRate, 533.3335, 1e-9, 'B rate');
});
